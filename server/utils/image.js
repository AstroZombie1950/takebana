// Сжатие и подгонка изображений — один слой на все загрузки сайта.
//
// Раньше multer писал присланный файл на диск байт в байт. Фото на мегабайт
// так и лежало мегабайтом и мегабайтом уезжало в браузер — даже когда его
// показывали аватаркой 128×128 или кружком 40×40 в списке диалогов.
//
// Здесь файл приходит буфером (multer.memoryStorage в routes/streaming/uploads.js)
// и ложится на диск уже обработанным: подогнанным по размеру, в webp и без
// метаданных. Последнее не косметика: в EXIF снимка с телефона лежат
// координаты съёмки, и они уезжали посетителям вместе с картинкой.
// sharp метаданные не переносит, если явно не попросить — это то, что нужно.

const sharp = require('sharp');
const { stamp, USER_PIXELS } = require('./watermark');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// Под что подгоняем. fit: 'cover' — кадрируем под точный размер (аватар
// круглый, обложка 16:9), 'inside' — вписываем в коробку, пропорции целы.
// Больше исходника не растягиваем: пиксели из воздуха не берутся.
//
// Размеры с запасом на экраны с удвоенной плотностью и на просмотр во весь
// экран: и аватар, и фото галереи открываются в лайтбоксе.
const PRESETS = {
  avatar:        { width: 512,  height: 512,  fit: 'cover',  quality: 82 },
  // Галерея — контент человека: со знаком (решение заказчика 18.09.2026).
  gallery:       { width: 1600, height: 1600, fit: 'inside', quality: 80, watermark: true },
  // Обложка эфира — тоже со знаком (21.09): её видно в поиске и на витрине,
  // и она же становится обложкой записи эфира (utils/recording.js).
  thumbnail:     { width: 1280, height: 720,  fit: 'cover',  quality: 80, watermark: true },
  establishment: { width: 1600, height: 1200, fit: 'inside', quality: 80 },
};

// Ошибку разбора отличаем от всего остального: маршрут отвечает на неё 400,
// а не 500 — присланное не является картинкой, и сервер тут ни при чём.
class BadImageError extends Error {
  constructor(cause) {
    super('Не удалось обработать изображение');
    this.name = 'BadImageError';
    this.cause = cause;
  }
}

// Имя нового файла. Время плюс случайные байты: два снимка в одну миллисекунду
// от разных людей не должны затирать друг друга.
const newName = () => Date.now() + '-' + crypto.randomBytes(6).toString('hex') + '.webp';

async function saveImage(buffer, preset, dir) {
  const p = PRESETS[preset];
  if (!p) throw new Error('Неизвестный профиль обработки: ' + preset);

  let data;
  try {
    if (p.watermark) {
      // stamp вписывает, а не кадрирует: обложку 16:9 сперва режем по кадру.
      const src = p.fit === 'cover'
        ? await sharp(buffer, { limitInputPixels: USER_PIXELS }).rotate().resize({ width: p.width, height: p.height, fit: 'cover', withoutEnlargement: true }).png().toBuffer()
        : buffer;
      data = (await stamp(src, p, p.quality)).data;
    }
    else data = await sharp(buffer, { limitInputPixels: USER_PIXELS })
      // По EXIF: снимок с телефона иначе ложится набок. Только до resize —
      // после поворота размеры меняются местами.
      .rotate()
      .resize({ width: p.width, height: p.height, fit: p.fit, withoutEnlargement: true })
      .webp({ quality: p.quality })
      .toBuffer();
  } catch (e) {
    throw new BadImageError(e);
  }

  await fsp.mkdir(dir, { recursive: true });
  const name = newName();
  await fsp.writeFile(path.join(dir, name), data);
  return name;
}

// Пачкой: по одному файлу за раз, а не все разом. sharp считает в своём пуле
// потоков, и сто фото галереи, запущенные параллельно, съели бы все ядра.
async function saveImages(files, preset, dir) {
  const names = [];
  for (const file of files) names.push(await saveImage(file.buffer, preset, dir));
  return names;
}

module.exports = { saveImage, saveImages, BadImageError, PRESETS };
