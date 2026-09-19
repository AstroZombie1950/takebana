// «Смотрите также» на странице записи. Без «умных» алгоритмов — на нашем
// объёме их нечем кормить: сначала другие записи того же автора (свежие),
// потом записи того же раздела у других (популярные), остаток — просто
// популярные. Записи 18+ — только подтвердившим возраст; авторов под
// ограничением модерации не советуем.

const Recording = require('../models/Recording');
const User = require('../models/User');
const userView = require('./userView');

const LIMIT = 12;
const SAME_AUTHOR = 4;
const FIELDS = 'title duration thumb isAdult createdAt recordedAt views userId';

async function forRecording(rec, { adultOk }) {
  const base = { status: 'ready', ...(adultOk ? {} : { isAdult: false }) };
  const banned = await User.distinct('_id', { banned: true });
  const authorId = rec.userId._id || rec.userId;
  const seen = [rec._id];
  const out = [];

  const take = async (filter, sort, limit) => {
    if (limit <= 0) return;
    const rows = await Recording.find({ ...base, ...filter, _id: { $nin: seen } })
      .sort(sort).limit(limit).select(FIELDS).populate('userId', 'nickname login email').lean();
    for (const r of rows) { seen.push(r._id); out.push(r); }
  };

  await take({ userId: authorId }, { createdAt: -1 }, SAME_AUTHOR);
  const others = { userId: { $nin: [authorId, ...banned] } };
  if (rec.category) await take({ ...others, category: rec.category }, { views: -1, createdAt: -1 }, LIMIT - out.length);
  await take(others, { views: -1, createdAt: -1 }, LIMIT - out.length);

  return out.filter((r) => r.userId).map((r) => ({ ...r, authorName: userView.displayName(r.userId) }));
}

module.exports = { forRecording };
