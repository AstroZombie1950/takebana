// Подписка и отписка на автора эфиров.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const Subscription = require('../../models/Subscription');
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

    // Создание новой подписки
    const subscription = new Subscription({ subscriberId, subscribedToId: userId });
    await subscription.save();

    res.status(200).json({ message: 'Подписка успешно оформлена' });
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
