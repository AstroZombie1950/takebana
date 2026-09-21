// Уведомления: список и отметка о прочтении. Уведомления о сообщениях
// снимает вход в диалог — routes/streaming/messages.js, /messages/read.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const Notification = require('../../models/Notification');
const { displayName } = require('../../utils/userView');

router.get('/api/notifications', async (req, res) => {
  const userId = req.session.userId;

  if (!userId) {
    return res.status(401).json({ message: 'Необходима авторизация' });
  }

  // Последние десять, от новых к старым; прочитанные тоже — они просто
  // не подсвечены. Отправитель — с _id: строка ведёт в переписку с ним.
  // Имя — как везде на сайте: логин, иначе часть почты до @ (displayName).
  // Саму почту в браузер не отдаём: раньше она уходила получателю целиком
  // и показывалась, если логина нет.
  const notifications = await Notification.find({ recipient: userId, type: { $ne: 'message' } })
    .sort({ createdAt: -1 })
    .limit(10)
    .populate('sender', 'nickname login email')
    .lean();

  res.json(notifications.map((n) => ({
    ...n,
    sender: n.sender ? { _id: n.sender._id, name: displayName(n.sender) } : null,
  })));
});

// Список открыт — всё в нём прочитано: точка на колокольчике гаснет.
router.put('/api/notifications/read', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: 'Необходима авторизация' });
  }
  await Notification.updateMany({ recipient: userId, isRead: false, type: { $ne: 'message' } }, { isRead: true });
  res.json({ success: true });
});

// Очистить ленту. Строки о сообщениях не трогаем: их в ленте и нет, а снимает
// их вход в диалог (messages.js).
router.delete('/api/notifications', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: 'Необходима авторизация' });
  }
  await Notification.deleteMany({ recipient: userId, type: { $ne: 'message' } });
  res.json({ success: true });
});

module.exports = router;
