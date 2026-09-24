// Чат внутри эфира: отправка и дозагрузка новых сообщений.

const express = require('express');
const rateLimit = require('express-rate-limit');
const restriction = require('../../utils/restrict');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const User = require('../../models/User');
const ChatMessage = require('../../models/ChatMessage');
const Stream = require('../../models/Stream');
const { requireAuth, requireNotBanned, canModerate } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const userView = require('../../utils/userView');

const OBJECT_ID = /^[a-f\d]{24}$/i;
// Сколько истории отдаём входящему зрителю. Больше на экране чата не
// помещается, а на большом эфире вся история — десятки тысяч строк на
// каждого входящего.
const HISTORY = 100;

// Пять сообщений за пять секунд с человека. Живому разговору хватает,
// а каждое сообщение уходит сокетом всем зрителям эфира: один скрипт
// на эфире с тысячами зрителей давал миллионы рассылок.
const chatLimiter = rateLimit({
  windowMs: 5 * 1000,
  limit: 5,
  keyGenerator: (req) => String(req.session.userId),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Слишком часто. Подождите пару секунд.' },
});

// Медленный режим: когда человек писал в чат эфира последний раз.
// «эфир:человек» → время. В памяти: это пауза в секунды, а не данные, и
// переживать перезапуск ей незачем. Раз в минуту старше минуты — вон:
// дольше минуты медленный режим не бывает.
const SLOW_STEPS = [0, 10, 30, 60];
const lastSaid = new Map();
setInterval(() => {
  const old = Date.now() - 60 * 1000;
  for (const [k, at] of lastSaid) if (at < old) lastSaid.delete(k);
}, 60 * 1000).unref();

// Эфир, чат которого этот человек вправе видеть: тот же доступ, что у
// страницы эфира (streamPages.js) — ограничение и гейт 18+. Ответ — эфир
// или код отказа с текстом.
async function chatStream(streamId, userId) {
  const stream = await Stream.findById(streamId).select('streamKey userId isActive isAdult slowMode').lean();
  if (!stream) return { status: 404, message: 'Эфир не найден' };
  if (String(stream.userId) === String(userId)) return { stream, own: true };
  if (await restriction.isRestricted(stream.userId, userId)) {
    return { status: 403, message: 'Автор ограничил вам доступ к своему каналу' };
  }
  if (stream.isAdult) {
    const u = userId ? await User.findById(userId).select('adultConfirmedAt').lean() : null;
    if (!u || !u.adultConfirmedAt) return { status: 403, message: 'Эфир для 18+: подтвердите возраст' };
  }
  return { stream };
}

router.post('/chat/message', requireAuth, requireNotBanned, chatLimiter, validate({
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
  const access = await chatStream(streamId, author._id);
  if (!access.stream) return res.status(access.status).json({ message: access.message });
  const { stream } = access;
  // Зрители пишут только в идущий эфир: в черновике, на паузе и после
  // остановки модерацией писать некому. Ведущий — всегда.
  if (!access.own && !stream.isActive) {
      return res.status(409).json({ message: 'Эфир сейчас не идёт' });
  }
  // Медленный режим — для зрителей; ведущий пишет без пауз. wait — сколько
  // секунд ждать: число клиент подставляет в подсказку на языке страницы.
  if (stream.slowMode && !access.own) {
      const key = `${streamId}:${author._id}`;
      const wait = Math.ceil(((lastSaid.get(key) || 0) + stream.slowMode * 1000 - Date.now()) / 1000);
      if (wait > 0) return res.status(429).json({ message: 'Включён медленный режим — подождите', wait });
      lastSaid.set(key, Date.now());
  }

  const chatMessage = new ChatMessage({
      streamId,
      userId: author._id,
      username,
      message
  });

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


// Медленный режим включает и выключает ведущий, и модератор — на чужом
// эфире. Зрителям уходит chat:slow: подсказка над полем меняется сразу.
router.post('/chat/slow-mode', requireAuth, validate({
  streamId: { type: 'objectId', required: true, label: 'Эфир' },
  seconds: { type: 'int', required: true, values: SLOW_STEPS, label: 'Пауза' },
}), async (req, res) => {
  const { streamId, seconds } = req.body;
  const stream = await Stream.findById(streamId).select('userId streamKey').lean();
  if (!stream) return res.status(404).json({ message: 'Эфир не найден' });
  if (String(stream.userId) !== String(req.session.userId)) {
    const me = await User.findById(req.session.userId).select('role').lean();
    if (!canModerate(me)) return res.status(403).json({ message: 'Нет прав на эту запись' });
  }
  await Stream.updateOne({ _id: streamId }, { slowMode: seconds });
  const io = req.app.get('io');
  if (io) io.to(`stream:${stream.streamKey}`).emit('chat:slow', { streamKey: stream.streamKey, seconds });
  res.json({ ok: true, seconds });
});

// Дозагрузка пропущенного. После перехода чата на сокеты этот маршрут вызывается
// не каждые две секунды, а дважды: один раз при открытии страницы и ещё раз при
// восстановлении разорванного соединения — добрать то, что пришло, пока связи не было.
router.get('/api/chat/messages/new', async (req, res) => {
  const { streamId, lastMessageTime } = req.query;
  // Строка нужной формы, а не что пришло: ?streamId[$ne]=… уходил в запрос
  // оператором и отдавал чаты всех эфиров.
  if (typeof streamId !== 'string' || !OBJECT_ID.test(streamId)) {
    return res.status(404).json({ message: 'Эфир не найден' });
  }
  const access = await chatStream(streamId, req.session.userId);
  if (!access.stream) return res.status(access.status).json({ message: access.message });

  const query = { streamId };
  const since = typeof lastMessageTime === 'string' && lastMessageTime ? new Date(lastMessageTime) : null;
  if (since && !isNaN(since.getTime())) query.createdAt = { $gt: since };

  // Без populate. Он подставлял сюда весь документ User — вместе с email,
  // хешем пароля и streamKey, — и этот ответ отдавался кому угодно без входа.
  // Последние HISTORY от новых к старым, клиенту — по порядку.
  const newMessages = await ChatMessage.find(query)
    .select('streamId userId username message createdAt')
    .sort({ createdAt: -1 })
    .limit(HISTORY)
    .lean();

  res.json(newMessages.reverse());
});

module.exports = router;
