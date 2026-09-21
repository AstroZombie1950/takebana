// Чат внутри эфира: отправка и дозагрузка новых сообщений.

const express = require('express');
const restriction = require('../../utils/restrict');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const User = require('../../models/User');
const ChatMessage = require('../../models/ChatMessage');
const Stream = require('../../models/Stream');
const { requireAuth, requireNotBanned } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const userView = require('../../utils/userView');

router.post('/chat/message', requireAuth, requireNotBanned, validate({
  streamId: { type: 'objectId', required: true, label: 'Эфир' },
  message: { type: 'string', required: true, min: 1, max: 2000, label: 'Сообщение' },
}), async (req, res) => {
  const { streamId, message } = req.body;

  // Автор берётся из сессии, а не из тела запроса: раньше userId и username
  // приходили от клиента, и любой вошедший писал в чат эфира от чужого имени.
  const author = await User.findById(req.session.userId).select('nickname login email');
  if (!author) {
      return res.status(401).json({ message: 'Необходима авторизация' });
  }
  const username = userView.displayName(author);

  // Рассылаем в комнату эфира. Комнаты именованы по ключу трансляции —
  // так к ним присоединяются обе страницы эфира (sockets/index.js), поэтому
  // ключ приходится достать. Заодно это проверка, что эфир вообще есть:
  // раньше сообщение писалось в базу с любым существующим ObjectId.
  const stream = await Stream.findById(streamId).select('streamKey userId').lean();
  if (!stream) {
      return res.status(404).json({ message: 'Эфир не найден' });
  }
  if (await restriction.isRestricted(stream.userId, author._id)) {
      return res.status(403).json({ message: 'Автор ограничил вам доступ к своему каналу' });
  }

  // Создаём новое сообщение
  const chatMessage = new ChatMessage({
      streamId,
      userId: author._id,
      username,
      message
  });

  // Сохраняем сообщение в базу данных
  await chatMessage.save();

  const io = req.app.get('io');
  if (io) {
      io.to(`stream:${stream.streamKey}`).emit('chat:message', {
          _id: chatMessage._id,
          streamId: String(streamId),
          userId: String(author._id),
          username,
          message,
          createdAt: chatMessage.createdAt,
      });
  }

  return res.status(200).json({ message: 'Сообщение успешно отправлено и сохранено' });
});


// Дозагрузка пропущенного. После перехода чата на сокеты этот маршрут вызывается
// не каждые две секунды, а дважды: один раз при открытии страницы и ещё раз при
// восстановлении разорванного соединения — добрать то, что пришло, пока связи не было.
router.get('/api/chat/messages/new', async (req, res) => {
  const { streamId, lastMessageTime } = req.query;


  const query = { streamId };

  // Если передано время последнего сообщения, возвращаем сообщения позже этого времени
  if (lastMessageTime && !isNaN(new Date(lastMessageTime).getTime())) {
    query.createdAt = { $gt: new Date(lastMessageTime) }; // Только сообщения, которые новее последнего сообщения
    // console.log("Запрос новых сообщений после времени:", lastMessageTime);
  }

  // Без populate. Он подставлял сюда весь документ User — вместе с email,
  // хешем пароля и streamKey, — и этот ответ отдавался кому угодно без входа.
  // Клиенту нужны только username, message и createdAt, а userId он сравнивает
  // со строкой (streamPageViewer.ejs:2330) — с populate сравнение не работало,
  // и свои сообщения не подсвечивались.
  const newMessages = await ChatMessage.find(query)
    .select('streamId userId username message createdAt')
    .sort({ createdAt: 1 })
    .lean();


  res.json(newMessages);
});


// Маршрут для поиска пользователей

module.exports = router;
