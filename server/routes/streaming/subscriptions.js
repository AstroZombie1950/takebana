// Подписка и отписка на автора эфиров.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const Subscription = require('../../models/Subscription');
const User = require('../../models/User');
const userView = require('../../utils/userView');
const { validate } = require('../../middleware/validate');

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

  const target = await User.findById(userId).select('nickname login email avatar isStreaming').lean();
  if (!target) {
    return res.status(404).json({ message: 'Пользователь не найден' });
  }

  await Subscription.create({ subscriberId, subscribedToId: userId });

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
      status: target.isStreaming ? 'online' : 'offline',
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

  res.status(200).json({
    message: 'Отписка успешно выполнена',
    followers: await Subscription.countDocuments({ subscribedToId: userId }),
  });
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
