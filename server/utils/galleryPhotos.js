// Фото галереи профиля. Решение 17.09.2026 «куда грузим файлы»: галерея —
// в Bunny (utils/storage.js), диск сервера под неё не тратим. Сжатие и знак —
// те же, что у всех картинок галереи (utils/image.js, webp), до выгрузки.
//
// С 25.09.2026 фото — документы models/GalleryPhoto.js (подпись, лайки,
// комментарии), а не строки в User.gallery. Ключ в хранилище —
// gallery/<userId>/<имя>.webp. Без Bunny (локально, или на бою без
// переменных) — public/uploads/gallery/<userId>/. Фото, загруженные до
// переезда в Bunny, остаются на сервере: удаление понимает оба адреса.

const fs = require('fs');
const sharp = require('sharp');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const GalleryPhoto = require('../models/GalleryPhoto');
const storage = require('./storage');
const engagement = require('./engagement');
const errorLog = require('./errorLog');
const { saveImages } = require('./image');
const { resolveWithin } = require('./safePath');

// Сколько фото у человека всего и сколько за один запрос: файлы multer
// держит в памяти (routes/streaming/profile.js).
const MAX_PER_USER = 100;
const PER_REQUEST = 20;
// Подпись — как у Инстаграма.
const CAPTION_MAX = 2200;

const UPLOADS = path.join(__dirname, '..', 'public', 'uploads');
const localDir = (userId) => path.join(UPLOADS, 'gallery', String(userId));
const localPrefix = (userId) => `/uploads/gallery/${userId}/`;
const keyOf = (userId, name) => `gallery/${userId}/${name}`;

// Ширина и высота готового файла (или буфера).
const sizeOf = (src) => sharp(src).metadata().then(({ width, height }) => ({ width, height }));

// files — из multer (memoryStorage). Возвращает [{ url, width, height }]
// в порядке файлов. Сбой посреди пачки — уже выгруженные убираются,
// адреса не возвращаются.
async function save(userId, files) {
  if (storage.driver !== 'bunny') {
    const names = await saveImages(files, 'gallery', localDir(userId));
    const out = [];
    for (const n of names) out.push({ url: localPrefix(userId) + n, ...await sizeOf(path.join(localDir(userId), n)) });
    return out;
  }
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tk-gallery-'));
  const done = [];
  try {
    const names = await saveImages(files, 'gallery', tmp);
    const out = [];
    for (const name of names) {
      const size = await sizeOf(path.join(tmp, name));
      out.push({ url: await storage.put(path.join(tmp, name), keyOf(userId, name), 'image/webp'), ...size });
      done.push(keyOf(userId, name));
    }
    return out;
  } catch (e) {
    await Promise.all(done.map((k) => storage.remove(k).catch(() => {})));
    throw e;
  } finally {
    fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Файл фото — из хранилища или с диска сервера.
async function removeFile(userId, url) {
  const name = url.slice(url.lastIndexOf('/') + 1);
  if (url.startsWith(localPrefix(userId))) {
    const file = resolveWithin(localDir(userId), name);
    if (file) await fs.promises.rm(file, { force: true });
    return;
  }
  if (storage.driver === 'bunny') await storage.remove(keyOf(userId, name));
}

// Фото удалено: файл, документ, а следом оценки, комментарии и жалобы.
async function remove(doc) {
  await removeFile(String(doc.userId), doc.url)
    .catch((e) => errorLog.external(e, 'gallery.photo.remove', { url: doc.url }));
  await Promise.all([
    GalleryPhoto.deleteOne({ _id: doc._id }),
    engagement.forgetTarget(doc._id, 'photo'),
  ]);
}

// Удаление аккаунта: каждое фото со всем, что под ним, и папка на сервере.
async function removeAll(userId) {
  const photos = await GalleryPhoto.find({ userId }).lean();
  for (const p of photos) await remove(p);
  const dir = resolveWithin(path.join(UPLOADS, 'gallery'), String(userId));
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// Время загрузки старого фото: имя файла начинается с метки времени
// (utils/image.js, newName). Без метки — порядок в массиве, от старых к новым.
const stampOf = (url) => {
  const m = /\/(\d{13})-[0-9a-f]+\.webp$/.exec(url);
  return m ? Number(m[1]) : 0;
};

// Перенос строк User.gallery в документы — при запуске, один раз: у кого
// поле пустое, тех запрос не находит. Повтор после сбоя безопасен —
// уникальный индекс по адресу не пустит дубль, а поле снимается только
// после того, как документы на месте. Через драйвер, мимо схемы: поля
// gallery в модели User больше нет.
async function migrate() {
  const users = mongoose.connection.collection('users');
  const left = await users.find({ 'gallery.0': { $exists: true } }, { projection: { gallery: 1, createdAt: 1 } }).toArray();
  for (const u of left) {
    const base = u.createdAt ? +u.createdAt : Date.now() - u.gallery.length * 1000;
    const docs = u.gallery.filter((url) => typeof url === 'string' && url).map((url, i) => ({
      userId: u._id,
      url,
      createdAt: new Date(stampOf(url) || base + i * 1000),
    }));
    try {
      await GalleryPhoto.insertMany(docs, { ordered: false });
    } catch (e) {
      if (!(e.code === 11000 || (e.writeErrors || []).every((w) => w.code === 11000))) throw e;
    }
    await users.updateOne({ _id: u._id }, { $unset: { gallery: '' } });
  }
  if (left.length) console.log(`[gallery] фото перенесены в документы: людей ${left.length}`);
}

// Размеры фото, загруженных до 04.10: файл — с диска или из Bunny, по одному.
// Файла нет вовсе — размер 0: больше не ищем, атрибутов у снимка не будет.
// Сбой сети — пропускаем, попробуем при следующем запуске.
const NONE = { width: 0, height: 0 };
async function sourceOf(url) {
  if (url.startsWith('/uploads/')) {
    const file = resolveWithin(UPLOADS, url.slice('/uploads/'.length));
    return file && fs.existsSync(file) ? file : null;
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('хранилище ответило ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function fillSizes() {
  const left = await GalleryPhoto.find({ width: { $exists: false } }).select('url').lean();
  for (const p of left) {
    try {
      const src = await sourceOf(p.url);
      await GalleryPhoto.updateOne({ _id: p._id }, { $set: src ? await sizeOf(src) : NONE });
    } catch (e) {
      errorLog.external(e, 'gallery.fillSizes', { photo: String(p._id) });
    }
  }
}

// При запуске процесса: перенос — когда база открыта, драйвер команды
// до соединения не копит.
function start() {
  const db = mongoose.connection;
  (db.readyState === 1 ? Promise.resolve() : new Promise((r) => db.once('open', r)))
    .then(migrate)
    .then(fillSizes)
    .catch((e) => errorLog.server(e, 'gallery.migrate'));
}

module.exports = { MAX_PER_USER, PER_REQUEST, CAPTION_MAX, save, remove, removeAll, start };
