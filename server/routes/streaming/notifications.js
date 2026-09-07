// Уведомления мессенджера: список, отметка о прочтении, снятие при выходе из чата.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const Notification = require('../../models/Notification');
const { validate } = require('../../middleware/validate');

router.get('/api/notifications', async (req, res) => {
  const userId = req.session.userId;

  if (!userId) {
    return res.status(401).json({ message: 'Необходима авторизация' });
  }

  try {
    // Получаем последние 5 непрочитанных уведомлений, сортируем от новых к старым
    const notifications = await Notification.find({ recipient: userId })
      .sort({ createdAt: -1 }) // Сортировка по времени создания
      .limit(5) // Ограничиваем до 5 уведомлений
      .populate('sender', 'login email'); // Подгружаем имя отправителя

    res.json(notifications);
  } catch (error) {
    console.error('Ошибка при получении уведомлений:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});


router.put('/api/notifications/markAsRead', validate({
  senderId: { type: 'objectId', required: true, label: 'Отправитель' },
}), async (req, res) => {
  const { senderId } = req.body; // ID отправителя, с которым открыт диалог
  const userId = req.session.userId; // ID текущего пользователя

  if (!senderId || !userId) {
    return res.status(400).json({ message: 'Недостаточно данных' });
  }

  try {
    // Помечаем все уведомления от этого отправителя как прочитанные
    await Notification.updateMany(
      { recipient: userId, sender: senderId, isRead: false },
      { isRead: true }
    );
    res.json({ message: 'Уведомления помечены как прочитанные' });
  } catch (error) {
    console.error('Ошибка при обновлении уведомлений:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Удаление уведомлений о чате при входе в диалог
router.post('/removeChatNotifications', validate({
  recipientId: { type: 'objectId', required: true, label: 'Собеседник' },
}), async (req, res) => {
  const { recipientId } = req.body; // ID собеседника
  const userId = req.session.userId; // ID текущего пользователя

  if (!recipientId || !userId) {
    return res.status(400).json({ message: 'Недостаточно данных' });
  }

  try {
    // Удаляем все уведомления от этого пользователя
    await Notification.deleteMany({
      recipient: userId,
      sender: recipientId,
      type: 'message'
    });
    
    res.json({ message: 'Уведомления о чате удалены' });
  } catch (error) {
    console.error('Ошибка при удалении уведомлений о чате:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});


// Оптимизированный единый роут для всех категорий стриминга

module.exports = router;
