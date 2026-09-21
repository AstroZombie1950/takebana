// «Ограничить доступ к каналу»: владелец закрывает от человека свои эфиры,
// записи и галерею, и подписаться на него тот больше не может.
//
// С 21.09.2026 (решение заказчика) закрываются и переписка со звонками —
// в обе стороны: ограниченный не пишет и не звонит владельцу, владелец —
// ему, пока не вернёт доступ. Иначе ограничение выглядело нелогичным:
// канал закрыт, а написать и позвонить можно.
//
// Список лежит у владельца (User.restricted): ограничивают немногих, а
// спрашивают всегда про пару «чей канал — кто смотрит».

const User = require('../models/User');
const Subscription = require('../models/Subscription');

function isRestricted(ownerId, viewerId) {
  if (!ownerId || !viewerId || String(ownerId) === String(viewerId)) return Promise.resolve(false);
  return User.exists({ _id: ownerId, restricted: viewerId }).then(Boolean);
}

// Ограничить — значит и убрать из подписчиков: иначе он продолжал бы
// получать «вышел в эфир» на канал, куда его не пустят.
async function restrict(ownerId, userId) {
  await Promise.all([
    User.updateOne({ _id: ownerId }, { $addToSet: { restricted: userId } }),
    Subscription.deleteOne({ subscriberId: userId, subscribedToId: ownerId }),
  ]);
}

function unrestrict(ownerId, userId) {
  return User.updateOne({ _id: ownerId }, { $pull: { restricted: userId } });
}

// Между двумя людьми стоит ограничение — всё равно, кто кого ограничил.
// Для переписки и звонков. Ответ — кто ограничил: 'me' (a ограничил b),
// 'them' (b ограничил a) или null.
async function between(a, b) {
  if (!a || !b || String(a) === String(b)) return null;
  const owner = await User.findOne({
    $or: [{ _id: a, restricted: b }, { _id: b, restricted: a }],
  }).select('_id').lean();
  if (!owner) return null;
  return String(owner._id) === String(a) ? 'me' : 'them';
}

// Текст отказа для маршрутов переписки и звонков (перевод — utils/i18n.js).
const BLOCKED = {
  me: 'Вы ограничили доступ этому человеку — сначала верните его',
  them: 'Автор ограничил вам доступ — написать и позвонить нельзя',
};

module.exports = { isRestricted, restrict, unrestrict, between, BLOCKED };
