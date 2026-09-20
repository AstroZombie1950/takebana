// С кем человек общается: кому писал, кому звонил и насколько давно.
//
// Заказчик просил список «с кем часто общался или общался в последнее время».
// Это одно число, а не два списка: частота, приглушённая давностью. Каждое
// событие весит 1 (сообщение) или 5 (звонок — событие крупнее), и вес падает
// вдвое за каждые две недели. Тот, с кем переписывались сто раз прошлой
// весной, уступит тому, с кем вчера был один разговор, — и это верно: список
// нужен, чтобы быстро написать, а не как статистика.
//
// Считается на открытии переписки. Ничего не хранится: пересчитать дешевле,
// чем держать в базе счётчик, который надо чинить после каждого удаления.
//
// Сообщения считаются по диалогам, а не по отправителю: под это есть индекс
// (conversationId, sentAt), а под «sender или recipient за период» — нет,
// и такой запрос перебирал бы всю переписку сайта.

const mongoose = require('mongoose');
const Message = require('../models/Message');
const Call = require('../models/Call');

const DAYS = 60;              // глубже смотреть незачем: вес там уже ничтожен
const HALF_LIFE_DAYS = 14;    // за две недели событие «весит» вдвое меньше
const CALL_WEIGHT = 5;
const LIMIT = 12;

const DAY_MS = 24 * 3600 * 1000;
const HALF_MS = HALF_LIFE_DAYS * DAY_MS;

// Вес события по давности, выражением Mongo: 0.5 ^ (возраст / полураспад).
// Сегодняшнее — 1, двухнедельной давности — 0.5, месячной — 0.25.
const weight = (field, now) => ({
  $pow: [0.5, { $divide: [{ $subtract: [now, field] }, HALF_MS] }],
});

// conversations — уже загруженные диалоги этого человека (_id и собеседники).
// Возвращает id собеседников по убыванию близости, не больше limit.
// Пустой массив — общаться ещё было не с кем.
async function rankPeers(userId, conversations, { limit = LIMIT } = {}) {
  const me = new mongoose.Types.ObjectId(String(userId));
  const mine = String(me);
  const since = new Date(Date.now() - DAYS * DAY_MS);
  const now = new Date();

  // Диалог → собеседник: по нему раскладываем счёт сообщений на людей.
  const peerOfConversation = new Map();
  for (const c of conversations) {
    if (!c.userOne || !c.userTwo) continue; // собеседник удалил аккаунт
    const one = String(c.userOne._id || c.userOne);
    const two = String(c.userTwo._id || c.userTwo);
    peerOfConversation.set(String(c._id), one === mine ? two : one);
  }
  const ids = [...peerOfConversation.keys()].map((id) => new mongoose.Types.ObjectId(id));

  const [byConversation, byCall] = await Promise.all([
    ids.length
      ? Message.aggregate([
          { $match: { conversationId: { $in: ids }, sentAt: { $gte: since }, deletedFor: { $ne: me } } },
          { $group: { _id: '$conversationId', score: { $sum: weight('$sentAt', now) }, last: { $max: '$sentAt' } } },
        ])
      : [],
    // Звонок засчитываем любой, даже непринятый: набирали — значит, общались.
    // Звонили не только тем, с кем есть переписка, поэтому источник отдельный.
    Call.aggregate([
      { $match: { $or: [{ caller: me }, { callee: me }], startedAt: { $gte: since }, deletedFor: { $ne: me } } },
      {
        $group: {
          _id: { $cond: [{ $eq: ['$caller', me] }, '$callee', '$caller'] },
          score: { $sum: { $multiply: [CALL_WEIGHT, weight('$startedAt', now)] } },
          last: { $max: '$startedAt' },
        },
      },
    ]),
  ]);

  const peers = new Map();
  const add = (id, score, last) => {
    const key = String(id);
    if (!key || key === mine) return; // записки самому себе в список не идут
    const cur = peers.get(key) || { score: 0, last: 0 };
    cur.score += score;
    cur.last = Math.max(cur.last, new Date(last).getTime());
    peers.set(key, cur);
  };

  for (const row of byConversation) add(peerOfConversation.get(String(row._id)), row.score, row.last);
  for (const row of byCall) add(row._id, row.score, row.last);

  return [...peers.entries()]
    .sort((a, b) => b[1].score - a[1].score || b[1].last - a[1].last)
    .slice(0, limit)
    .map(([id]) => id);
}

module.exports = { rankPeers, LIMIT };
