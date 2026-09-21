// «Ограничить доступ к каналу»: владелец закрывает от человека свои эфиры,
// записи и галерею, и подписаться на него тот больше не может. Переписку
// и звонки это не трогает — канал, а не личное общение.
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

module.exports = { isRestricted, restrict, unrestrict };
