// Сводка места для панели (вкладка «Хранилище», routes/admin/storage.js):
// что лежит в Bunny и на диске сервера, что это за файлы, чьи они и сколько
// это стоит.
//
// База знает не всё: у фото, обложек и кусков HLS размер не хранится.
// Поэтому сводка обходит сами хранилища — папки Bunny через его API
// (utils/storage.js, list) и диск сервера — и каждый файл сверяет со ссылками
// из базы: так видно, что это (запись, фото галереи, голосовое, кружок…),
// и что лежит без ссылки — «сироты», за которые платим впустую.
//
// Обход Bunny — запрос на каждую папку, на большом объёме это десятки
// секунд. Поэтому отчёт один на процесс, живёт CACHE_MS и строится в фоне:
// панель получает «считаем» и спрашивает снова.

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const storage = require('./storage');
const errorLog = require('./errorLog');
const Recording = require('../models/Recording');
const GalleryVideo = require('../models/GalleryVideo');
const User = require('../models/User');
const Message = require('../models/Message');
const Stream = require('../models/Stream');
const Establishments = require('../models/Establishments');

const ROOT = path.join(__dirname, '..');
const UPLOADS = path.join(ROOT, 'public', 'uploads');
const MEDIA = path.join(ROOT, 'media');
const CACHE_MS = 30 * 60 * 1000;
// Сколько ждём отчёт в самом запросе, прежде чем ответить «считаем».
const WAIT_MS = 15000;
const PARALLEL = 8;
// Потолок папок на обход: дальше отчёт честно падает, а не висит часами.
const DIRS_MAX = 50000;
const TOP = 20;
const DAY = 86400000;

// Папка → группа. На диске сервера — по первой папке в uploads и media;
// в Bunny ключи те же, что в uploads при локальном хранилище (storage.put).
const UPLOAD_GROUPS = {
  recordings: 'recordings', gallery: 'gallery', chat: 'chat',
  avatars: 'avatars', thumbnails: 'covers', establishments: 'venues',
};
const MEDIA_GROUPS = { upload: 'drafts', rec: 'recChunks', live: 'live', basemap: 'basemap' };

// ── Ссылки из базы: ключ файла → [группа, вид, страница] ────────────────────
// Ключ — путь в хранилище (recordings/…, gallery/…, chat/…) или в uploads
// (avatars/…, thumbnails/…, establishments/…). Страница — куда вести из
// панели; у переписки её нет: личное.
function localKey(url) {
  const u = String(url || '');
  return u.startsWith('/uploads/') ? u.slice('/uploads/'.length) : '';
}

async function references() {
  const refs = new Map();
  const add = (key, group, kind, link = '') => { if (key) refs.set(key, [group, kind, link]); };

  const [recs, videos, users, messages, streams, venues] = await Promise.all([
    Recording.find({}, 'video thumb hls.files').lean(),
    GalleryVideo.find({}, 'video thumb').lean(),
    User.find({ $or: [{ 'gallery.0': { $exists: true } }, { avatar: /^\/uploads\// }, { 'streamDefaults.thumbnail': /^\/uploads\// }] },
      'gallery avatar streamDefaults.thumbnail').lean(),
    Message.find({ 'attachments.0': { $exists: true } }, 'attachments.kind attachments.key attachments.previewKey').lean(),
    Stream.find({ thumbnail: /^\/uploads\// }, 'thumbnail').lean(),
    Establishments.find({ 'photos.0': { $exists: true } }, 'photos').lean(),
  ]);

  // Ключ файла, а без него — адрес у нас (так лежат старые и тестовые записи).
  const fileKey = (f) => (f && (f.key || localKey(f.url))) || '';

  for (const r of recs) {
    const link = `/recording/${r._id}`;
    add(fileKey(r.video), 'recordings', 'video', link);
    add(fileKey(r.thumb), 'recordings', 'cover', link);
    for (const k of (r.hls && r.hls.files) || []) add(k, 'recordings', 'hls', link);
  }
  for (const v of videos) {
    add(fileKey(v.video), 'gallery', 'video', `/video/${v._id}`);
    add(fileKey(v.thumb), 'gallery', 'cover', `/video/${v._id}`);
  }
  for (const u of users) {
    const page = `/userPage/${u._id}`;
    // Фото — на CDN или, загруженные до переезда, у нас: ключ в обоих
    // случаях начинается с gallery/ (utils/galleryPhotos.js).
    for (const url of u.gallery || []) {
      const i = url.indexOf('/gallery/');
      if (i !== -1) add(url.slice(i + 1), 'gallery', 'photo', page + '/gallery');
    }
    add(localKey(u.avatar), 'avatars', 'file', page);
    add(localKey(u.streamDefaults && u.streamDefaults.thumbnail), 'covers', 'file', page);
  }
  for (const m of messages) {
    for (const a of m.attachments) {
      add(a.key, 'chat', a.kind);
      add(a.previewKey, 'chat', 'preview');
    }
  }
  for (const s of streams) add(localKey(s.thumbnail), 'covers', 'file', `/stream/${s._id}`);
  for (const v of venues) for (const p of v.photos || []) add(localKey(p), 'venues', 'file');
  return refs;
}

// ── Подсчёт ─────────────────────────────────────────────────────────────────
// Одна «куча» на место (Bunny или сервер): группы с видами, рост по месяцам,
// самые большие файлы, сироты.
function tally() {
  return { bytes: 0, files: 0, groups: {}, months: {}, added30: 0, top: [], orphanTop: [] };
}

function pushTop(list, item) {
  if (list.length === TOP && item.size <= list[TOP - 1].size) return;
  list.push(item);
  list.sort((a, b) => b.size - a.size);
  if (list.length > TOP) list.pop();
}

function count(t, key, size, at, [group, kind, link]) {
  t.bytes += size;
  t.files += 1;
  const g = t.groups[group] || (t.groups[group] = { bytes: 0, files: 0, kinds: {} });
  g.bytes += size;
  g.files += 1;
  const k = g.kinds[kind] || (g.kinds[kind] = { bytes: 0, files: 0 });
  k.bytes += size;
  k.files += 1;
  if (at && !isNaN(at)) {
    const month = at.toISOString().slice(0, 7);
    const m = t.months[month] || (t.months[month] = {});
    m[group] = (m[group] || 0) + size;
    if (Date.now() - at < 30 * DAY) t.added30 += size;
  }
  const item = { key, size, at, group, kind, link: link || '' };
  pushTop(t.top, item);
  if (kind === 'orphan') pushTop(t.orphanTop, item);
}

// Что это за файл: по ссылке из базы, иначе по папке — сирота своей группы.
// Служебные папки (черновики, куски записей, эфиры, подложка) ссылок
// не имеют и сиротами не бывают.
function classify(key, refs) {
  const hit = refs.get(key);
  if (hit) return hit;
  const [top, second] = key.split('/');
  if (top === 'media') {
    const group = MEDIA_GROUPS[second] || 'other';
    if (group === 'drafts') return [group, key.endsWith('.cover') ? 'cover' : 'part'];
    return [group, 'file'];
  }
  const group = UPLOAD_GROUPS[top];
  return group ? [group, 'orphan'] : ['other', 'file'];
}

// ── Обход ───────────────────────────────────────────────────────────────────
// Bunny: очередь папок и не больше PARALLEL запросов разом.
function walkBunny(onFile) {
  const queue = [''];
  let active = 0;
  let dirs = 0;
  return new Promise((resolve, reject) => {
    const next = () => {
      if (!queue.length && !active) return resolve(dirs);
      while (active < PARALLEL && queue.length) {
        if (++dirs > DIRS_MAX) return reject(new Error(`в Bunny больше ${DIRS_MAX} папок`));
        const prefix = queue.shift();
        active++;
        storage.list(prefix).then((items) => {
          for (const o of items) {
            if (o.dir) queue.push(`${prefix}${o.name}/`);
            else onFile(prefix + o.name, o.size, o.at);
          }
          active--;
          next();
        }, reject);
      }
    };
    next();
  });
}

// Диск: папка целиком, ключ — путь от base с приставкой prefix.
// Ссылки (symlink) не идём: подложка карты может быть ссылкой на общий диск.
async function walkDisk(dir, prefix, onFile) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return; // папки нет — на свежей машине это нормально
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkDisk(full, `${prefix}${e.name}/`, onFile);
    else if (e.isFile()) {
      const st = await fs.promises.stat(full).catch(() => null);
      if (st) onFile(prefix + e.name, st.size, st.birthtime && st.birthtime.getTime() ? st.birthtime : st.mtime);
    }
  }
}

async function build() {
  const started = Date.now();
  const refs = await references();

  const bunny = storage.driver === 'bunny' ? tally() : null;
  if (bunny) {
    bunny.dirs = await walkBunny((key, size, at) => count(bunny, key, size, at, classify(key, refs)));
  }

  const server = tally();
  await walkDisk(UPLOADS, '', (key, size, at) => count(server, key, size, at, classify(key, refs)));
  await walkDisk(MEDIA, 'media/', (key, size, at) => count(server, key, size, at, classify(key, refs)));

  // База лежит на том же диске: её место — тоже место сервера.
  const st = await mongoose.connection.db.stats();
  server.db = { data: st.dataSize || 0, storage: st.storageSize || 0, index: st.indexSize || 0 };
  try {
    const fsst = await fs.promises.statfs(ROOT);
    server.disk = { free: fsst.bavail * fsst.bsize, total: fsst.blocks * fsst.bsize };
  } catch (_) {
    server.disk = null;
  }

  return { at: new Date(), ms: Date.now() - started, driver: storage.driver, bunny, server };
}

// ── Кэш и фон ───────────────────────────────────────────────────────────────
let last = null;
let running = null;
let startedAt = null;
// Упавший обход: панель получает ошибку, а не «считаем» без конца.
// Следующий запрос через минуту пробует снова.
let failed = null;

// fresh — пересчитать, даже если свежий отчёт есть. Ответ — отчёт,
// { pending, startedAt }, пока считается, или { error }.
async function get({ fresh = false } = {}) {
  if (!running && !fresh && failed && Date.now() - failed.at < 60000) return { error: failed.message };
  const stale = !last || Date.now() - last.at > CACHE_MS;
  if (!running && (fresh || stale)) {
    startedAt = new Date();
    failed = null;
    running = build()
      .then((r) => { last = r; return r; })
      .catch((e) => {
        errorLog.server(e, 'storage.report');
        failed = { at: Date.now(), message: e.message };
        return { error: e.message };
      })
      .finally(() => { running = null; });
  }
  if (running) {
    let timer;
    const wait = new Promise((resolve) => { timer = setTimeout(resolve, WAIT_MS, null); });
    const done = await Promise.race([running, wait]);
    clearTimeout(timer);
    return done || { pending: true, startedAt };
  }
  return last;
}

module.exports = { get };
