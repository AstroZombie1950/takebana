// Водяной знак Takebana — одно место на все медиа сайта.
//
// Решение заказчика 18.09.2026: знак стоит на всех медиа — эфир и запись
// (utils/hls.js), загруженное видео и кружки (utils/videoEncode.js), фото
// переписки и галереи (здесь, stamp). Звонки и камеры заведений собирает
// Daily у зрителя, в кадр там положить нечего — знак наложен поверх плеера
// (класс .tk-wm в app.css). Звук и документы знака не несут.
//
// Правый верхний угол: там реже всего оказывается лицо и подписи.
// Размер — доля короткой стороны: 54 px на 720, как у эфира.
//
// Файл лежит в public/img: тот же знак браузер кладёт поверх плеера звонка.

const path = require('path');
const sharp = require('sharp');

const WATERMARK = path.join(__dirname, '..', 'public', 'img', 'watermark.png');
const WATERMARK_MARGIN = 24;
const WATERMARK_SHARE = 54 / 720;

// Высота знака и отступ для кадра w×h: на мелком кадре отступ 24 px
// съел бы полкартинки, поэтому он тоже в долях (24 на 720).
function size(w, h) {
  const short = Math.min(w, h);
  return {
    height: Math.max(14, Math.round(short * WATERMARK_SHARE)),
    margin: Math.max(6, Math.round(short * WATERMARK_MARGIN / 720)),
  };
}

const cache = new Map();
async function mark(height) {
  if (!cache.has(height)) cache.set(height, sharp(WATERMARK).resize({ height }).png().toBuffer({ resolveWithObject: true }));
  return cache.get(height);
}

// Картинка со знаком: input — что понимает sharp, box — во что вписать
// ({ width, height }), quality — webp. Сначала сырые пиксели нужного размера,
// потом знак, потом одно кодирование: без двойного сжатия.
// Анимация (gif, анимированный webp) — знак на каждом кадре: sharp держит
// её лентой кадров друг под другом, и одиночное наложение легло бы только
// на первый. Возвращает { data, width, height }.
// Предел пикселей для картинок от человека. У sharp по умолчанию 268 Мп:
// PNG в 10 МБ разворачивается почти в гигабайт памяти («бомба»). 50 Мп —
// с запасом больше любой камеры телефона; у анимации считаются все кадры.
const USER_PIXELS = 50e6;

async function stamp(input, box, quality) {
  const animated = (await sharp(input, { limitInputPixels: USER_PIXELS }).metadata().catch(() => ({}))).pages > 1;
  // Промежуточное — без потерь: сырые пиксели, у анимации — webp lossless
  // (сырой ленте sharp не передать границы кадров).
  const step = sharp(input, { animated, limitInputPixels: USER_PIXELS }).rotate()
    .resize({ width: box.width, height: box.height, fit: 'inside', withoutEnlargement: true });
  const resized = await (animated ? step.webp({ lossless: true }) : step.raw()).toBuffer({ resolveWithObject: true });
  const { width: w, channels } = resized.info;
  const pageH = resized.info.pageHeight || resized.info.height;
  const pages = animated ? Math.round(resized.info.height / pageH) : 1;
  const s = size(w, pageH);
  const wm = await mark(s.height);
  const left = Math.max(0, w - wm.info.width - s.margin);
  const tiles = Array.from({ length: pages }, (_, i) => ({ input: wm.data, left, top: i * pageH + s.margin }));
  const base = animated ? sharp(resized.data, { animated }) : sharp(resized.data, { raw: { width: w, height: pageH, channels } });
  const data = await base.composite(tiles).webp({ quality }).toBuffer();
  return { data, width: w, height: pageH };
}

module.exports = { WATERMARK, WATERMARK_MARGIN, WATERMARK_SHARE, USER_PIXELS, size, stamp };
