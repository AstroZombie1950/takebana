// «Смотрите также» на странице записи эфира и видео галереи (routes/watch.js).
// Без «умных» алгоритмов — на нашем объёме их нечем кормить: сначала другие
// ролики того же автора (свежие), потом того же вида у других (у записи —
// сначала из того же раздела; популярные), остаток — популярное другого
// вида. Записи 18+ — только подтвердившим возраст; авторов под ограничением
// модерации не советуем.

const Recording = require('../models/Recording');
const GalleryVideo = require('../models/GalleryVideo');
const User = require('../models/User');
const userView = require('./userView');

const LIMIT = 12;
const SAME_AUTHOR = 4;
const KINDS = {
  recording: { Model: Recording, href: '/recording/', fields: 'title duration thumb isAdult createdAt recordedAt views userId' },
  video: { Model: GalleryVideo, href: '/video/', fields: 'title duration thumb createdAt views userId' },
};

// kind — вид открытого ролика: 'recording' или 'video'.
async function forItem(item, kind, { adultOk }) {
  const other = kind === 'video' ? 'recording' : 'video';
  const banned = await User.distinct('_id', { banned: true });
  const authorId = item.userId._id || item.userId;
  const seen = [item._id];
  const out = [];

  const take = async (k, filter, sort, limit) => {
    if (limit <= 0) return;
    const { Model, href, fields } = KINDS[k];
    const base = { status: 'ready', ...(k === 'recording' && !adultOk ? { isAdult: false } : {}) };
    const rows = await Model.find({ ...base, ...filter, _id: { $nin: seen } })
      .sort(sort).limit(limit).select(fields).populate('userId', 'nickname login email').lean();
    for (const r of rows) { seen.push(r._id); out.push({ ...r, kind: k, href: href + r._id }); }
  };

  const others = { userId: { $nin: [authorId, ...banned] } };
  const popular = { views: -1, createdAt: -1 };
  await take(kind, { userId: authorId }, { createdAt: -1 }, SAME_AUTHOR);
  if (item.category) await take(kind, { ...others, category: item.category }, popular, LIMIT - out.length);
  await take(kind, others, popular, LIMIT - out.length);
  await take(other, others, popular, LIMIT - out.length);

  return out.filter((r) => r.userId).map((r) => ({ ...r, authorName: userView.displayName(r.userId) }));
}

module.exports = { forItem };
