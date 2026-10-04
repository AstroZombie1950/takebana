// Маленькие копии аватаров (04.10, docs/seo, задача 33).
//
// Аватар хранится 512×512 — для профиля и просмотра во весь экран, а почти
// везде он кружок 30–72 px: на главной десяток таких по 48–78 КБ (PageSpeed
// 04.10: −120…285 КБ на страницу). Рядом с оригиналом лежит копия 144×144 —
// кружок 72 px на экране двойной плотности — «<имя>.s.webp».
//
// Какие копии есть, держим в памяти и адрес копии отдаём, только когда файл
// на диске: /uploads/ раздаёт nginx, и ненайденная копия была бы битой
// картинкой. При запуске досоздаём копии старых аватаров (до 04.10, часть —
// ещё .jpg). Удаляют копию вместе с оригиналом (remove — из мест, где
// удаляют аватар, логотип или фото группы); при запуске подчищаются копии,
// чей оригинал пропал мимо них.

const sharp = require('sharp');
const fsp = require('fs/promises');
const path = require('path');
const errorLog = require('./errorLog');

const SIZE = 144;
const SUFFIX = '.s.webp';
const PUBLIC = path.join(__dirname, '..', 'public');
// Аватары людей и логотипы заведений — uploads/avatars, фото групп — uploads/groups.
const DIRS = ['uploads/avatars', 'uploads/groups'];

const ready = new Set(); // адреса оригиналов, у которых копия на диске

const stem = (name) => name.replace(/\.[^.]+$/, '');
const urlOf = (dir, name) => '/' + path.relative(PUBLIC, path.join(dir, name)).split(path.sep).join('/');

// Адрес для кружка: копия, если она есть, иначе оригинал (и внешний адрес
// входа через Google — как есть).
const small = (url) => (ready.has(url) ? stem(url) + SUFFIX : url);

// Оригинал удалили — удаляем и копию: удалённое фото не должно оставаться
// по адресу копии. Адрес — из базы, но имя файла всё равно проверяем.
function remove(url) {
  if (!ready.delete(url)) return;
  const name = path.basename(url);
  if (!/^[\w.-]+$/.test(name) || !DIRS.some((d) => url === '/' + d + '/' + name)) return;
  fsp.unlink(path.join(PUBLIC, path.dirname(url), stem(name) + SUFFIX)).catch(() => {});
}

// src — оригинал буфером (при загрузке) или путём к файлу (при запуске).
async function add(dir, name, src) {
  const data = await sharp(src).resize(SIZE, SIZE, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  await fsp.writeFile(path.join(dir, stem(name) + SUFFIX), data);
  ready.add(urlOf(dir, name));
}

async function start() {
  for (const rel of DIRS) {
    const dir = path.join(PUBLIC, rel);
    let names;
    try { names = await fsp.readdir(dir); } catch (e) { continue; }
    const copies = new Set(names.filter((n) => n.endsWith(SUFFIX)).map((n) => n.slice(0, -SUFFIX.length)));
    const originals = names.filter((n) => !n.endsWith(SUFFIX) && !n.startsWith('.'));
    const stems = new Set(originals.map(stem));
    for (const s of copies) if (!stems.has(s)) await fsp.unlink(path.join(dir, s + SUFFIX)).catch(() => {});
    // По одному: sharp считает в своём пуле, сотня разом заняла бы все ядра.
    for (const name of originals) {
      if (copies.has(stem(name))) { ready.add(urlOf(dir, name)); continue; }
      await add(dir, name, path.join(dir, name)).catch((e) => errorLog.server(e, 'avatarSmall.start', { file: rel + '/' + name }));
    }
  }
}

module.exports = { small, add, remove, start };
