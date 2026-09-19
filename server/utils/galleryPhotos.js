// Фото галереи профиля. Решение 17.09.2026 «куда грузим файлы»: галерея —
// в Bunny (utils/storage.js), диск сервера под неё не тратим. Сжатие то же,
// что у всех картинок (utils/image.js, webp), — до выгрузки.
//
// Ключ в хранилище — gallery/<userId>/<имя>.webp; в User.gallery — адрес
// на CDN. Без Bunny (локально, или на бою без переменных) — как раньше,
// public/uploads/gallery/<userId>/. Фото, загруженные до переезда, остаются
// на сервере: удаление понимает оба адреса.

const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('./storage');
const { saveImages } = require('./image');
const { resolveWithin, isPlainFileName } = require('./safePath');

const UPLOADS = path.join(__dirname, '..', 'public', 'uploads');
const localDir = (userId) => path.join(UPLOADS, 'gallery', String(userId));
const localPrefix = (userId) => `/uploads/gallery/${userId}/`;
const keyOf = (userId, name) => `gallery/${userId}/${name}`;

// files — из multer (memoryStorage). Возвращает адреса в порядке файлов.
// Сбой посреди пачки — уже выгруженные убираются, адреса не возвращаются.
async function save(userId, files) {
  if (storage.driver !== 'bunny') {
    const names = await saveImages(files, 'gallery', localDir(userId));
    return names.map((n) => localPrefix(userId) + n);
  }
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tk-gallery-'));
  const done = [];
  try {
    const names = await saveImages(files, 'gallery', tmp);
    const urls = [];
    for (const name of names) {
      urls.push(await storage.put(path.join(tmp, name), keyOf(userId, name), 'image/webp'));
      done.push(keyOf(userId, name));
    }
    return urls;
  } catch (e) {
    await Promise.all(done.map((k) => storage.remove(k).catch(() => {})));
    throw e;
  } finally {
    fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Адрес из User.gallery этого человека по имени файла, или null.
function find(userId, gallery, name) {
  if (!isPlainFileName(name)) return null;
  const tail = `/gallery/${userId}/${name}`;
  return (gallery || []).find((u) => u.endsWith(tail)) || null;
}

async function remove(userId, url) {
  const name = url.slice(url.lastIndexOf('/') + 1);
  if (url.startsWith(localPrefix(userId))) {
    const file = resolveWithin(localDir(userId), name);
    if (file) await fs.promises.rm(file, { force: true });
    return;
  }
  if (storage.driver === 'bunny') await storage.remove(keyOf(userId, name));
}

// Удаление аккаунта: всё из хранилища и папка на сервере.
async function removeAll(userId, gallery) {
  await Promise.all((gallery || []).filter((u) => !u.startsWith(localPrefix(userId)))
    .map((u) => remove(userId, u).catch(() => {})));
  const dir = resolveWithin(path.join(UPLOADS, 'gallery'), String(userId));
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

module.exports = { save, find, remove, removeAll };
