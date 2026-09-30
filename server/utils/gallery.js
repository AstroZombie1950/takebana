// Галерея человека — две вкладки (решение заказчика 25.09.2026): «Фото»
// (models/GalleryPhoto.js) и «Видео» (models/GalleryVideo.js), новые сверху.
// До 25.09 это была одна лента вперемешку. Нужны профилю (начало каждой
// вкладки) и страницам /@ник/photos и /@ник/videos (routes/streaming/catalog.js),
// а ещё карте сайта (routes/seo.js).

const GalleryPhoto = require('../models/GalleryPhoto');
const GalleryVideo = require('../models/GalleryVideo');
const Recording = require('../models/Recording');

// В профиле — сетка фото 3×4, шесть видео и шесть записей эфиров; на
// странице вкладки — по PAGE. Записи до 29.09 шли в профиль все разом,
// без потолка и без своей страницы.
const PREVIEW = { photos: 12, videos: 6, recordings: 6 };
const PAGE = 24;

const PHOTO_FIELDS = 'url caption likes comments createdAt';
const VIDEO_FIELDS = 'status error duration thumb upload title views likes comments createdAt';

// Чьё. owner — человек (id): его личное — без снятого от имени заведения;
// { venue: id } — всё заведения, кто бы из его людей ни вёл (29.09,
// docs/VENUES.md п. 9). Фото бывают только у человека.
const whose = (owner) => (owner && owner.venue ? { venue: owner.venue } : { userId: owner, venue: null });

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
function videoFilter(owner, self) {
  return { ...whose(owner), ...(self ? {} : { status: 'ready' }) };
}

function videos(owner, self, { skip = 0, limit = PREVIEW.videos } = {}) {
  return GalleryVideo.find(videoFilter(owner, self)).sort({ createdAt: -1 }).skip(skip).limit(limit).select(VIDEO_FIELDS).lean();
}

// Записи эфиров: чужому — только готовые, автору — и те, что ещё
// склеиваются или не склеились.
const REC_FIELDS = 'title status duration thumb isAdult createdAt views';
const recFilter = (owner, self) => ({ ...whose(owner), ...(self ? {} : { status: 'ready' }) });

function recordings(owner, self, { skip = 0, limit = PREVIEW.recordings } = {}) {
  return Recording.find(recFilter(owner, self)).sort({ createdAt: -1 }).skip(skip).limit(limit).select(REC_FIELDS).lean();
}

const recordingsCount = (owner, self) => Recording.countDocuments(recFilter(owner, self));

// Числа на вкладках — то, что можно смотреть: без роликов в работе.
// listed — сколько карточек у владельца всего, вместе с незаконченными:
// по нему листалка и «Все видео».
async function counts(owner, self) {
  const [photosN, videosN, listed] = await Promise.all([
    owner && owner.venue ? 0 : GalleryPhoto.countDocuments({ userId: owner }),
    GalleryVideo.countDocuments({ ...whose(owner), status: 'ready' }),
    self ? GalleryVideo.countDocuments(whose(owner)) : null,
  ]);
  return { photos: photosN, videos: videosN, videosListed: listed === null ? videosN : listed };
}

module.exports = { PREVIEW, PAGE, page, photos, videos, counts, recordings, recordingsCount };
