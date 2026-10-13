// Галерея человека — две вкладки (решение заказчика 25.09.2026): «Фото»
// (models/GalleryPhoto.js) и «Видео» (models/GalleryVideo.js), новые сверху.
// До 25.09 это была одна лента вперемешку. Нужны страницам /@ник/photos,
// /@ник/videos и /@ник/recordings (routes/streaming/catalog.js), вкладкам
// заведения, числам профиля и карте сайта (routes/seo.js). С 09.10 профиль
// начала вкладок не показывает — у него лента автора (utils/feed.js).

const GalleryPhoto = require('../models/GalleryPhoto');
const GalleryVideo = require('../models/GalleryVideo');
const Recording = require('../models/Recording');
const Post = require('../models/Post');
const { Types } = require('mongoose');

// На странице вкладки — по PAGE.
const PAGE = 24;

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

// Фото — плитками по постам (12.10, Иван: «одна карточка — один пост»,
// как в Инстаграме): фото поста — одна плитка на пост, прежняя пачка
// (загружены разом, utils/feed.js, BATCH_MS) — одна плитка на пачку,
// одиночное фото — своя. Плитка — первый выбранный кадр (он же самый
// новый: пачка пишется с шагом назад, routes/streaming/profile.js);
// set — сколько кадров.
// Склейка — в базе: соседи по времени одного поста или одной пачки
// получают общий номер группы (сумма «здесь началась новая» с начала).
const BATCH_MS = 50;
const tiles = (userId) => [
  { $match: { userId: new Types.ObjectId(String(userId)) } },
  { $setWindowFields: { sortBy: { createdAt: 1 }, output: {
    prevAt: { $shift: { output: '$createdAt', by: -1 } },
    prevPost: { $shift: { output: '$post', by: -1, default: 'none' } },
  } } },
  { $set: { start: { $cond: [{ $or: [
    { $eq: [{ $ifNull: ['$prevAt', null] }, null] },
    { $ne: [{ $ifNull: ['$post', null] }, { $ifNull: ['$prevPost', null] }] },
    { $and: [{ $eq: [{ $ifNull: ['$post', null] }, null] }, { $gt: [{ $subtract: ['$createdAt', '$prevAt'] }, BATCH_MS] }] },
  ] }, 1, 0] } } },
  { $setWindowFields: { sortBy: { createdAt: 1 }, output: { group: { $sum: '$start', window: { documents: ['unbounded', 'current'] } } } } },
  { $sort: { createdAt: -1 } },
  { $group: { _id: '$group', first: { $first: '$$ROOT' }, set: { $sum: 1 } } },
];

async function photoTiles(userId) {
  const [r] = await GalleryPhoto.aggregate([...tiles(userId), { $count: 'n' }]);
  return r ? r.n : 0;
}

// skip/limit — срез плиток. У плитки поста — его адрес, текст и оценки.
async function photos(userId, { skip = 0, limit = PAGE } = {}) {
  const rows = await GalleryPhoto.aggregate([...tiles(userId), { $sort: { 'first.createdAt': -1 } }, { $skip: skip }, { $limit: limit }]);
  const posts = new Map((await Post.find({ _id: { $in: rows.map((r) => r.first.post).filter(Boolean) } })
    .select('text likes comments').lean()).map((p) => [String(p._id), p]));
  return rows.map(({ first: p, set }) => {
    const post = p.post && posts.get(String(p.post));
    return post
      ? { _id: p._id, url: p.url, href: '/post/' + post._id, caption: post.text, likes: post.likes, comments: post.comments, set }
      : { _id: p._id, url: p.url, href: '/photo/' + p._id, caption: p.caption, likes: p.likes, comments: p.comments, set };
  });
}

// self — смотрит владелец: ему видны и ролики, которые ещё грузятся,
// ждут публикации, пережимаются или не вышли.
function videoFilter(owner, self) {
  return { ...whose(owner), ...(self ? {} : { status: 'ready' }) };
}

function videos(owner, self, { skip = 0, limit = PAGE } = {}) {
  return GalleryVideo.find(videoFilter(owner, self)).sort({ createdAt: -1 }).skip(skip).limit(limit).select(VIDEO_FIELDS).lean();
}

// Записи эфиров: чужому — только готовые, автору — и те, что ещё
// склеиваются или не склеились.
const REC_FIELDS = 'title status duration thumb isAdult createdAt views';
const recFilter = (owner, self) => ({ ...whose(owner), ...(self ? {} : { status: 'ready' }) });

function recordings(owner, self, { skip = 0, limit = PAGE } = {}) {
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

module.exports = { PAGE, BATCH_MS, page, photos, photoTiles, videos, counts, recordings, recordingsCount };
