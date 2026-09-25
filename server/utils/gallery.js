// Галерея человека — две вкладки (решение заказчика 25.09.2026): «Фото»
// (models/GalleryPhoto.js) и «Видео» (models/GalleryVideo.js), новые сверху.
// До 25.09 это была одна лента вперемешку. Нужны профилю (начало каждой
// вкладки) и страницам /@ник/photos и /@ник/videos (routes/streaming/catalog.js),
// а ещё карте сайта (routes/seo.js).

const GalleryPhoto = require('../models/GalleryPhoto');
const GalleryVideo = require('../models/GalleryVideo');

// В профиле — сетка фото 3×4 и шесть видео; на странице вкладки — по PAGE.
const PREVIEW = { photos: 12, videos: 6 };
const PAGE = 24;

const PHOTO_FIELDS = 'url caption likes comments createdAt';
const VIDEO_FIELDS = 'status error duration thumb upload title views likes comments createdAt';

// Номер страницы в пределах: за пределами — последняя.
function page(total, n) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const current = Math.min(Math.max(1, n || 1), pages);
  return { page: current, pages, skip: (current - 1) * PAGE };
}

// Фото: skip/limit — срез ленты.
function photos(userId, { skip = 0, limit = PREVIEW.photos } = {}) {
  return GalleryPhoto.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit).select(PHOTO_FIELDS).lean();
}

// self — смотрит владелец: ему видны и ролики, которые ещё грузятся,
// ждут публикации, пережимаются или не вышли.
function videoFilter(userId, self) {
  return { userId, ...(self ? {} : { status: 'ready' }) };
}

function videos(userId, self, { skip = 0, limit = PREVIEW.videos } = {}) {
  return GalleryVideo.find(videoFilter(userId, self)).sort({ createdAt: -1 }).skip(skip).limit(limit).select(VIDEO_FIELDS).lean();
}

// Числа на вкладках — то, что можно смотреть: без роликов в работе.
// listed — сколько карточек у владельца всего, вместе с незаконченными:
// по нему листалка и «Все видео».
async function counts(userId, self) {
  const [photosN, videosN, listed] = await Promise.all([
    GalleryPhoto.countDocuments({ userId }),
    GalleryVideo.countDocuments({ userId, status: 'ready' }),
    self ? GalleryVideo.countDocuments({ userId }) : null,
  ]);
  return { photos: photosN, videos: videosN, videosListed: listed === null ? videosN : listed };
}

module.exports = { PREVIEW, PAGE, page, photos, videos, counts };
