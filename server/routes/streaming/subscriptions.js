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

  try {
    // Проверка, существует ли уже такая подписка
    const existingSubscription = await Subscription.findOne({ subscriberId, subscribedToId: userId });

    if (existingSubscription) {
      return res.status(400).json({ message: 'Вы уже подписаны на этого пользователя' });
    }

    const target = await User.findById(userId).select('login email avatar isStreaming').lean();
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
      user: {
        id: String(target._id),
        displayName,
        avatarStyle: userView.avatarStyle(target, displayName),
        status: target.isStreaming ? 'online' : 'offline',
      },
    });
  } catch (error) {
    console.error('Ошибка при подписке:', error);
    res.status(500).json({ message: 'Ошибка сервера при попытке подписаться' });
  }
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

  try {
    // Поиск и удаление подписки
    const subscription = await Subscription.findOneAndDelete({ subscriberId, subscribedToId: userId });

    if (!subscription) {
      return res.status(400).json({ message: 'Вы не подписаны на этого пользователя' });
    }

    res.status(200).json({ message: 'Отписка успешно выполнена' });
  } catch (error) {
    console.error('Ошибка при отписке:', error);
    res.status(500).json({ message: 'Ошибка сервера при попытке отписаться' });
  }
});


// Маршрут для страницы профиля пользователя /userPage/:id

module.exports = router;
