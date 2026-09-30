// Видео-меню заведения (29.09, docs/VENUES.md п. 10): позиции (models/MenuItem.js)
// и их ролики.
//
// Ролик — 5–15 секунд, без звука, по кругу. Присланное пережимается
// квадратом 640×640 со знаком (utils/videoEncode.js, clip): знак обязателен
// на всём видео сайта. Длиннее CLIP_SECONDS — режем с секунды, которую
// выбрал владелец. Лежит в Bunny, как видео галереи (решение «куда грузим
// файлы» 17.09), ключ menu/<venue>/<позиция>-<время>.<ext>: у замены свой
// адрес, и CDN не отдаёт прежний ролик из кэша.
//
// Очередь — та же, что у видео галереи: ролик короткий, пережимается
// за секунды, эфиры важнее.

const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('./storage');
const errorLog = require('./errorLog');
const { encode, schedule } = require('./videoEncode');
const MenuItem = require('../models/MenuItem');

const MAX_ITEMS = 100;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 300;
const PRICE_MAX = 24;
const SECTION_MAX = 40;
const CLIP_SECONDS = 15;
// Присланное: 15 секунд 4K с телефона — около сотни мегабайт.
const CLIP_MB = 250;

// Файлы ролика — из хранилища. Ошибка — в журнал: документ уже ушёл.
function dropFiles(clip) {
  const keys = [clip && clip.video && clip.video.key, clip && clip.thumb && clip.thumb.key].filter(Boolean);
  return Promise.all(keys.map((k) => storage.remove(k).catch((e) => errorLog.external(e, 'venueMenu.remove', { key: k }))));
}

async function convert(item, src, start, job) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `tk-menu-${item._id}-`));
  const base = `menu/${item.venue}/${item._id}-${Date.now().toString(36)}`;
  const uploaded = [];
  try {
    const out = await encode(src, dir, {
      maxSeconds: CLIP_SECONDS,
      clip: true,
      log: { menuItem: String(item._id) },
      // Обложка — первый кадр: с неё ролик и начинает крутиться.
      edit: { start, end: start + CLIP_SECONDS, mute: true, coverAt: start },
    });
    const video = { url: await storage.put(out.video, `${base}.mp4`, 'video/mp4'), key: `${base}.mp4` };
    uploaded.push(video.key);
    const thumb = out.thumb ? { url: await storage.put(out.thumb, `${base}.jpg`, 'image/jpeg'), key: `${base}.jpg` } : { url: '', key: '' };
    if (thumb.key) uploaded.push(thumb.key);
    // Позицию удалили или ролик заменили, пока шло пережатие, — наше не нужно.
    const was = await MenuItem.findOneAndUpdate({ _id: item._id, 'clip.job': job }, {
      $set: { 'clip.status': 'ready', 'clip.error': '', 'clip.video': video, 'clip.thumb': thumb, 'clip.duration': out.duration },
    });
    if (!was) await Promise.all(uploaded.map((k) => storage.remove(k).catch(() => {})));
    else await dropFiles(was.clip);
  } catch (e) {
    await Promise.all(uploaded.map((k) => storage.remove(k).catch(() => {})));
    if (!e.reason) errorLog.media(e, 'venueMenu.clip', { menuItem: String(item._id) });
    await MenuItem.updateOne({ _id: item._id, 'clip.job': job }, { $set: { 'clip.status': 'failed', 'clip.error': e.reason || 'convert' } }).catch(() => {});
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(src, { force: true }).catch(() => {});
  }
}

// Новый ролик позиции: src — принятый файл (временный, удаляется после),
// start — с какой секунды исходника. Прежний ролик виден, пока пережимается
// новый, и уходит, когда новый готов.
async function setClip(item, src, start, owner) {
  const job = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await MenuItem.updateOne({ _id: item._id }, { $set: { 'clip.status': 'processing', 'clip.error': '', 'clip.job': job } });
  schedule(() => convert(item, src, start, job), { lane: 'gallery', owner });
}

// Убрать ролик, оставив позицию. Идущее пережатие своё не запишет: job сброшен.
async function clearClip(item) {
  await MenuItem.updateOne({ _id: item._id }, {
    $set: { 'clip.status': 'none', 'clip.error': '', 'clip.job': '', 'clip.video': {}, 'clip.thumb': {}, 'clip.duration': 0 },
  });
  await dropFiles(item.clip);
}

async function remove(item) {
  await MenuItem.deleteOne({ _id: item._id });
  await dropFiles(item.clip);
}

// Всё меню заведения — при его удалении (utils/userDelete.js, removeVenue).
async function removeAll(venueId) {
  const items = await MenuItem.find({ venue: venueId }).lean();
  for (const item of items) await remove(item);
}

// При запуске: пережатие, оборванное перезапуском, не продолжить — присланный
// файл лежал во временной папке. Владелец пришлёт ролик заново.
async function sweep() {
  await MenuItem.updateMany({ 'clip.status': 'processing' }, { $set: { 'clip.status': 'failed', 'clip.error': 'restart', 'clip.job': '' } }).catch(() => {});
}

// Позиции по разделам — в порядке первой позиции каждого раздела.
function sections(items) {
  const map = new Map();
  for (const item of items) {
    const name = item.section || '';
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(item);
  }
  return [...map].map(([name, list]) => ({ name, items: list }));
}

// Позиция для браузера владельца: без ключей хранилища.
function itemView(item) {
  const clip = item.clip || {};
  return {
    id: String(item._id),
    section: item.section || '',
    name: item.name,
    description: item.description || '',
    price: item.price || '',
    clip: { status: clip.status || 'none', error: clip.error || '', video: (clip.video && clip.video.url) || '', thumb: (clip.thumb && clip.thumb.url) || '' },
  };
}

module.exports = {
  enabled: storage.enabled, MAX_ITEMS, NAME_MAX, DESCRIPTION_MAX, PRICE_MAX, SECTION_MAX, CLIP_SECONDS, CLIP_MB,
  setClip, clearClip, remove, removeAll, sweep, sections, itemView,
};
