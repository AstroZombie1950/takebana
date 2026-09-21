// Подписка и отписка на автора эфиров.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const Subscription = require('../../models/Subscription');
const User = require('../../models/User');
const Stream = require('../../models/Stream');
const Notification = require('../../models/Notification');
const userView = require('../../utils/userView');
const push = require('../../utils/push');
const errorLog = require('../../utils/errorLog');
const restriction = require('../../utils/restrict');
const profileSignal = require('../../utils/profileSignal');

// Подписка и отписка туда-обратно — не повод звать человека каждый раз:
// от одного подписчика не чаще раза в сутки.
const FOLLOW_AGAIN_MS = 24 * 3600 * 1000;

// Новый подписчик: строка в колокольчик и пуш, если вкладки нет.
async function notifyFollow(io, subscriber, targetId) {
  const since = new Date(Date.now() - FOLLOW_AGAIN_MS);
  if (await Notification.exists({ recipient: targetId, sender: subscriber._id, type: 'follow', createdAt: { $gt: since } })) return;
  const link = '/userPage/' + String(subscriber._id);
  await Notification.create({ recipient: targetId, sender: subscriber._id, type: 'follow', link });
  if (io) io.to(`user:${targetId}`).emit('notification:new');
  if (push.online(targetId)) return;
  await push.send(targetId, {
    topic: 'follow',
    title: userView.displayName(subscriber),
    bodyKey: 'push.follow',
    tag: 'follow-' + String(subscriber._id),
    url: link,
  });
}
const { validate } = require('../../middleware/validate');
const { requireAuthApi } = require('../../middleware/auth');

router.post('/subscribe', validate({
  userId: { type: 'objectId', required: true, label: 'Пользователь' },
}), async (req, res) => {
  const { userId } = req.body; // Получаем ID пользователя для подписки
  const subscriberId = req.session.userId; // Предполагаем, что ID текущего пользователя хранится в сессии

  if (!subscriberId) {
    return res.status(401).json({ message: 'Необходимо войти в систему для подписки' });
  }

  // Проверка, существует ли уже такая подписка
  const existingSubscription = await Subscription.findOne({ subscriberId, subscribedToId: userId });

  if (existingSubscription) {
    return res.status(400).json({ message: 'Вы уже подписаны на этого пользователя' });
  }

  const target = await User.findById(userId).select('nickname login email avatar').lean();
  if (!target) {
    return res.status(404).json({ message: 'Пользователь не найден' });
  }
  if (await restriction.isRestricted(userId, subscriberId)) {
    return res.status(403).json({ message: 'Автор ограничил вам доступ к своему каналу' });
  }

  await Subscription.create({ subscriberId, subscribedToId: userId });
  profileSignal.counts([userId, subscriberId]);
  profileSignal.follow(subscriberId, userId, true);
  User.findById(subscriberId).select('nickname login email').lean()
    .then((me) => me && notifyFollow(req.app.get('io'), me, userId))
    .catch((e) => errorLog.server(e, 'subscribe.notify'));

  // Строка для левой панели: страница дорисовывает подписку без перезагрузки
  // (window.tkSubscriptions в public/tk-app.js). Поля — те же, что готовит
  // для панели commonDataMiddleware.
  const displayName = userView.displayName(target);
  res.status(200).json({
    message: 'Подписка успешно оформлена',
    // Свежее число подписчиков — страница профиля ставит его сразу.
    followers: await Subscription.countDocuments({ subscribedToId: userId }),
    user: {
      id: String(target._id),
      displayName,
      avatarStyle: userView.avatarStyle(target, displayName),
      // По идущему эфиру, а не по полю isStreaming: его нет ни в схеме User,
      // ни в базе — строка новой подписки всегда приходила «не в эфире»
      // (то же чинится в shared.js).
      status: (await Stream.exists({ userId, isActive: true })) ? 'online' : 'offline',
    },
  });
});


// Маршрут для отписки от пользователя
router.delete('/unsubscribe', validate({
  userId: { type: 'objectId', required: true, label: 'Пользователь' },
}), async (req, res) => {
  const { userId } = req.body; // ID стримера, от которого отписываемся
  const subscriberId = req.session.userId; // ID текущего пользователя из сессии

  if (!subscriberId) {
    return res.status(401).json({ message: 'Необходимо войти в систему для отписки' });
  }

  // Поиск и удаление подписки
  const subscription = await Subscription.findOneAndDelete({ subscriberId, subscribedToId: userId });

  if (!subscription) {
    return res.status(400).json({ message: 'Вы не подписаны на этого пользователя' });
  }
  profileSignal.counts([userId, subscriberId]);
  profileSignal.follow(subscriberId, userId, false);

  res.status(200).json({
    message: 'Отписка успешно выполнена',
    followers: await Subscription.countDocuments({ subscribedToId: userId }),
  });
});

// Убрать человека из своих подписчиков. Подписаться снова он может —
// чтобы не мог, есть «Ограничить доступ» ниже.
router.post('/followers/remove', requireAuthApi, validate({
  userId: { type: 'objectId', required: true, label: 'Пользователь' },
}), async (req, res) => {
  const me = req.session.userId;
  await Subscription.deleteOne({ subscriberId: req.body.userId, subscribedToId: me });
  profileSignal.counts([me, req.body.userId]);
  profileSignal.follow(req.body.userId, me, false);
  res.json({ success: true, followers: await Subscription.countDocuments({ subscribedToId: me }) });
});

// Ограничить доступ к своему каналу или вернуть его (utils/restrict.js).
router.post('/restrict', requireAuthApi, validate({
  userId: { type: 'objectId', required: true, label: 'Пользователь' },
  on: { type: 'bool', required: true, label: 'Ограничение' },
}), async (req, res) => {
  const me = req.session.userId;
  const { userId, on } = req.body;
  if (String(userId) === String(me)) return res.status(400).json({ message: 'Себе ограничить доступ нельзя' });
  if (!(await User.exists({ _id: userId }))) return res.status(404).json({ message: 'Пользователь не найден' });
  if (on) await restriction.restrict(me, userId);
  else await restriction.unrestrict(me, userId);
  profileSignal.access(me, userId, on);
  if (on) profileSignal.follow(userId, me, false);
  profileSignal.counts([me, userId]);
  res.json({ success: true, restricted: on, followers: await Subscription.countDocuments({ subscribedToId: me }) });
});

// Списки человека: кто на него подписан (/followers) и на кого подписан он
// (/following). Открыты гостю, как и сама страница человека. Новые подписки
// сверху, по LIST_PAGE на страницу. Карточки — те же, что в поиске
// (utils/search.js, partials/personCard.ejs).
const { commonDataMiddleware } = require('./shared');
const { peopleCards } = require('../../utils/search');
const LIST_PAGE = 48;

router.get(['/userPage/:id/followers', '/userPage/:id/following'], commonDataMiddleware, async (req, res) => {
  const { id } = req.params;
  if (!/^[a-f\d]{24}$/i.test(id)) return res.status(404).send('Пользователь не найден');
  const owner = await User.findById(id).select('nickname login email avatar').lean();
  if (!owner) return res.status(404).send('Пользователь не найден');

  const list = req.path.endsWith('/following') ? 'following' : 'followers';
  // В одной коллекции обе стороны: подписчики — те, кто подписан на него,
  // подписки — те, на кого подписан он.
  const [mine, other] = list === 'followers' ? ['subscribedToId', 'subscriberId'] : ['subscriberId', 'subscribedToId'];
  const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));

  const [links, followersCount, followingCount] = await Promise.all([
    Subscription.find({ [mine]: id }).sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * LIST_PAGE).limit(LIST_PAGE + 1).select(other).lean(),
    Subscription.countDocuments({ subscribedToId: id }),
    Subscription.countDocuments({ subscriberId: id }),
  ]);
  const more = links.length > LIST_PAGE;
  const ids = links.slice(0, LIST_PAGE).map((l) => l[other]);

  // Порядок подписок сохраняем: find по $in отдаёт в своём порядке.
  // Удалённых аккаунтов в списке нет — их карточке некуда вести.
  const users = await User.find({ _id: { $in: ids } }).select('nickname login email avatar isOnline').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const people = await peopleCards(ids.map((i) => byId.get(String(i))).filter(Boolean));

  const displayName = userView.displayName(owner);
  res.render('followers', {
    owner: { _id: owner._id, displayName, avatarStyle: userView.avatarStyle(owner, displayName) },
    list, people, page, more, followersCount, followingCount,
  });
});

module.exports = router;
