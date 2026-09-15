// Личная переписка: список диалогов, история со звонками, отправка, пересылка,
// удаление, статусы «доставлено» и «прочитано». Журнал звонков для соседней
// вкладки — routes/calls.js.
//
// Новые сообщения и статусы приходят в браузер сокетом — в комнату
// `user:<id>`, куда входит каждая вкладка вошедшего (sockets/index.js).
// Раньше открытый диалог опрашивал сервер раз в три секунды.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const mongoose = require('mongoose');
const User = require('../../models/User');
const { requireAuthApi, requireNotBanned } = require('../../middleware/auth');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Notification = require('../../models/Notification');
const { validate } = require('../../middleware/validate');
const { commonDataMiddleware } = require('./shared');
const userView = require('../../utils/userView');
const callLog = require('../../utils/callLog');

const PAGE = 15;
const { ObjectId } = mongoose.Types;

// «5 минут назад» на языке страницы. То же считает public/chats.js, когда
// обновляет подписи и переключает язык.
const AGO_STEPS = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
function timeAgo(date, lang) {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  const [unit, size] = AGO_STEPS.find(([, s]) => sec >= s) || AGO_STEPS[AGO_STEPS.length - 1];
  return new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-Math.floor(sec / size), unit);
}

function findConversation(a, b) {
  return Conversation.findOne({
    $or: [{ userOne: a, userTwo: b }, { userOne: b, userTwo: a }],
  });
}

// Сообщение в том виде, в каком его получает браузер.
function view(m) {
  return {
    _id: String(m._id),
    sender: String(m.sender),
    recipient: String(m.recipient),
    content: m.content,
    sentAt: m.sentAt,
    deliveredAt: m.deliveredAt || null,
    readAt: m.readAt || null,
    forwardedFrom: m.forwardedFrom && m.forwardedFrom.name ? { name: m.forwardedFrom.name } : null,
  };
}

function person(user) {
  const displayName = userView.displayName(user);
  return { id: String(user._id), displayName, avatarStyle: userView.avatarStyle(user, displayName) };
}

const io = (req) => req.app.get('io');
const isOnline = (req, userId) => {
  const rooms = req.app.get('userRooms');
  return !!(rooms && rooms.has(String(userId)));
};

// Сохранить сообщение и разослать: получателю и остальным вкладкам
// отправителя. Общее у отправки и пересылки.
async function deliver(req, { conversation, sender, recipient, content, forwardedFrom }) {
  const now = new Date();
  const message = await Message.create({
    conversationId: conversation._id,
    sender: sender._id,
    recipient: recipient._id,
    content,
    sentAt: now,
    // Получатель на связи — сообщение дошло до его браузера сразу.
    deliveredAt: isOnline(req, recipient._id) ? now : null,
    forwardedFrom,
  });

  conversation.lastMessage = message._id;
  conversation.lastUpdated = now;
  conversation.hiddenFor = []; // удалённая переписка возвращается с новым сообщением
  await conversation.save();

  // Одно непрочитанное уведомление на отправителя: новое сообщение освежает его.
  await Notification.findOneAndUpdate(
    { recipient: recipient._id, sender: sender._id, type: 'message', isRead: false },
    { $set: { content, createdAt: now } },
    { upsert: true }
  );

  const out = view(message);
  const socket = io(req);
  if (socket) {
    socket.to(`user:${recipient._id}`).emit('message:new', { message: out, peer: person(sender) });
    socket.to(`user:${recipient._id}`).emit('notification:new');
    socket.to(`user:${sender._id}`).emit('message:new', { message: out, peer: person(recipient) });
  }
  return out;
}

router.get('/chatsPage', commonDataMiddleware, async (req, res) => {
  if (!req.session.userId || !res.locals.currentUser) {
    return res.redirect('/');
  }
  const me = new ObjectId(String(res.locals.currentUser._id));

  const conversations = await Conversation.find({
    $or: [{ userOne: me }, { userTwo: me }],
    hiddenFor: { $ne: me },
  })
    .populate('userOne userTwo', 'login email avatar isOnline lastSeen')
    .lean();

  const ids = conversations.map((c) => c._id);

  // Последнее видимое мне сообщение и число непрочитанных — по каждому диалогу
  // одним запросом, а не по запросу на диалог.
  const [lastRows, unreadRows] = await Promise.all([
    Message.aggregate([
      { $match: { conversationId: { $in: ids }, deletedFor: { $ne: me } } },
      { $sort: { sentAt: -1 } },
      { $group: { _id: '$conversationId', last: { $first: '$$ROOT' } } },
    ]),
    Message.aggregate([
      { $match: { conversationId: { $in: ids }, recipient: me, readAt: null, deletedFor: { $ne: me } } },
      { $group: { _id: '$conversationId', n: { $sum: 1 } } },
    ]),
  ]);
  const lastBy = new Map(lastRows.map((r) => [String(r._id), r.last]));
  const unreadBy = new Map(unreadRows.map((r) => [String(r._id), r.n]));

  const list = conversations
    // Собеседник мог удалить аккаунт — такой диалог не показать.
    .filter((c) => c.userOne && c.userTwo)
    .map((c) => {
      const peer = String(c.userOne._id) === String(me) ? c.userTwo : c.userOne;
      const last = lastBy.get(String(c._id)) || null;
      return {
        interlocutor: {
          ...person(peer),
          _id: peer._id,
          isOnline: !!peer.isOnline,
        },
        last: last && { content: last.content, mine: String(last.sender) === String(me) },
        unread: unreadBy.get(String(c._id)) || 0,
        lastActivity: last ? last.sentAt : c.createdAt,
      };
    })
    .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  // Вкладка «Звонки» открывается и адресом: из уведомления о пропущенном.
  res.render('chatsPage', { conversations: list, timeAgo, tab: req.query.tab === 'calls' ? 'calls' : 'messages' });
});


router.post('/start-conversation', requireAuthApi, requireNotBanned, validate({
  recipientId: { type: 'objectId', required: true, label: 'Собеседник' },
}), async (req, res) => {
  const me = req.session.userId;
  const { recipientId } = req.body;
  if (recipientId === String(me)) {
    return res.status(400).json({ success: false, message: 'Нельзя написать самому себе' });
  }

  let conversation = await findConversation(me, recipientId);
  if (!conversation) {
    conversation = await Conversation.create({ userOne: me, userTwo: recipientId });
  } else if (conversation.hiddenFor.some((id) => String(id) === String(me))) {
    // Написать тому, с кем переписку удалили, — значит вернуть диалог в список.
    conversation.hiddenFor.pull(me);
    await conversation.save();
  }

  res.json({ success: true, conversationId: conversation._id });
});


// История: страница по 15 сообщений от конца. before — время самого старого
// из уже загруженных; без него — последние. Прежде страница отсчитывалась
// сдвигом offset, и новое или удалённое сообщение сдвигало её: одно
// сообщение приходило дважды или пропадало.
//
// Вместе со страницей — звонки двоих за тот же отрезок: лента показывает их
// между сообщениями. Страница неполная — дальше сообщений нет, и звонки
// берутся до самого начала.
router.get('/getMessages', requireAuthApi, async (req, res) => {
  const { recipientId } = req.query;
  const before = req.query.before ? new Date(req.query.before) : null;
  const me = req.session.userId;

  if (typeof recipientId !== 'string' || !ObjectId.isValid(recipientId) || (before && isNaN(before))) {
    return res.status(400).json({ message: 'Не указан ID получателя' });
  }

  const conversation = await findConversation(me, recipientId);
  if (!conversation) {
    return res.status(404).json({ message: 'Диалог не найден' });
  }

  const messages = await Message.find({
    conversationId: conversation._id,
    deletedFor: { $ne: me },
    ...(before ? { sentAt: { $lt: before } } : {}),
  })
    .sort({ sentAt: -1 })
    .limit(PAGE)
    .lean();

  const from = messages.length === PAGE ? messages[messages.length - 1].sentAt : null;
  const calls = await callLog.between(me, recipientId, { from, to: before });

  res.json({ messages: messages.reverse().map(view), calls });
});


router.post('/sendMessage', requireAuthApi, requireNotBanned, validate({
  recipientId: { type: 'objectId', required: true, label: 'Собеседник' },
  content: { type: 'string', required: true, min: 1, max: 5000, label: 'Сообщение' },
}), async (req, res) => {
  const { recipientId, content } = req.body;
  const me = req.session.userId;

  const [conversation, sender, recipient] = await Promise.all([
    findConversation(me, recipientId),
    User.findById(me).select('login email avatar').lean(),
    User.findById(recipientId).select('login email avatar').lean(),
  ]);
  if (!conversation || !sender || !recipient) {
    return res.status(404).json({ message: 'Диалог не найден' });
  }

  res.json(await deliver(req, { conversation, sender, recipient, content }));
});


// Пересылка одного сообщения одному или нескольким собеседникам. Подпись
// «переслано от» — изначальный автор, даже если пересылают пересланное.
router.post('/messages/forward', requireAuthApi, requireNotBanned, validate({
  messageId: { type: 'objectId', required: true, label: 'Сообщение' },
  recipientIds: { type: 'array', required: true, max: 20, of: { type: 'objectId' }, label: 'Кому' },
}), async (req, res) => {
  const me = String(req.session.userId);
  const { messageId } = req.body;
  const recipientIds = [...new Set(req.body.recipientIds)].filter((id) => id !== me);
  if (!recipientIds.length) {
    return res.status(400).json({ message: 'Выберите, кому переслать' });
  }

  const original = await Message.findOne({
    _id: messageId,
    $or: [{ sender: me }, { recipient: me }],
    deletedFor: { $ne: me },
  }).lean();
  if (!original) {
    return res.status(404).json({ message: 'Сообщение не найдено' });
  }

  const [sender, recipients] = await Promise.all([
    User.findById(me).select('login email avatar').lean(),
    User.find({ _id: { $in: recipientIds } }).select('login email avatar').lean(),
  ]);

  let forwardedFrom = original.forwardedFrom && original.forwardedFrom.name ? original.forwardedFrom : null;
  if (!forwardedFrom) {
    const author = String(original.sender) === me
      ? sender
      : await User.findById(original.sender).select('login email').lean();
    forwardedFrom = author
      ? { user: author._id, name: userView.displayName(author) }
      : { user: original.sender, name: '#' + String(original.sender).slice(-6) };
  }

  const sent = [];
  for (const recipient of recipients) {
    let conversation = await findConversation(me, recipient._id);
    if (!conversation) conversation = await Conversation.create({ userOne: me, userTwo: recipient._id });
    sent.push(await deliver(req, { conversation, sender, recipient, content: original.content, forwardedFrom }));
  }

  res.json({ success: true, messages: sent });
});


// Диалог открыт — входящие в нём прочитаны. Отправителю уходит «прочитано»,
// уведомления об этом диалоге снимаются. В ответе — остались ли другие
// непрочитанные уведомления: от этого зависит точка на колокольчике.
router.post('/messages/read', requireAuthApi, validate({
  peerId: { type: 'objectId', required: true, label: 'Собеседник' },
}), async (req, res) => {
  const me = req.session.userId;
  const { peerId } = req.body;

  const conversation = await findConversation(me, peerId);
  if (conversation) {
    const now = new Date();
    const result = await Message.updateMany(
      { conversationId: conversation._id, recipient: me, readAt: null },
      [{ $set: { readAt: now, deliveredAt: { $ifNull: ['$deliveredAt', now] } } }]
    );
    if (result.modifiedCount && io(req)) {
      io(req).to(`user:${peerId}`).emit('message:read', { readerId: String(me), at: now });
    }
    await Notification.deleteMany({ recipient: me, sender: peerId, type: 'message' });
  }

  const unread = await Notification.countDocuments({ recipient: me, isRead: false });
  res.json({ success: true, unread });
});


// Удаление сообщений. «У всех» — только своих: документ стирается, и у
// собеседника сообщение пропадает сразу. «У меня» — остаётся у собеседника;
// когда удалили оба, стирается совсем.
router.post('/messages/delete', requireAuthApi, validate({
  ids: { type: 'array', required: true, max: 100, of: { type: 'objectId' }, label: 'Сообщения' },
  forAll: { type: 'bool', default: false, label: 'У всех' },
}), async (req, res) => {
  const me = String(req.session.userId);
  const { ids, forAll } = req.body;

  const messages = await Message.find({ _id: { $in: ids }, $or: [{ sender: me }, { recipient: me }] })
    .select('sender recipient')
    .lean();
  const mine = forAll ? messages.filter((m) => String(m.sender) === me) : [];
  const mineIds = new Set(mine.map((m) => String(m._id)));
  const rest = messages.filter((m) => !mineIds.has(String(m._id)));

  if (mine.length) {
    await Message.deleteMany({ _id: { $in: [...mineIds] } });
    const peers = new Set(mine.map((m) => String(m.recipient)));
    if (io(req)) {
      let room = io(req).to(`user:${me}`);
      peers.forEach((p) => { room = room.to(`user:${p}`); });
      room.emit('message:deleted', { ids: [...mineIds] });
    }
  }

  if (rest.length) {
    const restIds = rest.map((m) => m._id);
    await Message.updateMany({ _id: { $in: restIds } }, { $addToSet: { deletedFor: me } });
    await Message.deleteMany({ _id: { $in: restIds }, 'deletedFor.1': { $exists: true } });
    if (io(req)) io(req).to(`user:${me}`).emit('message:deleted', { ids: restIds.map(String) });
  }

  res.json({ success: true, deleted: messages.length });
});


// Удаление переписки целиком. «У меня» — диалог уходит из моего списка
// и вернётся с новым сообщением; «у обоих» — стирается у двоих.
router.post('/conversations/delete', requireAuthApi, validate({
  peerId: { type: 'objectId', required: true, label: 'Собеседник' },
  forAll: { type: 'bool', default: false, label: 'У всех' },
}), async (req, res) => {
  const me = String(req.session.userId);
  const { peerId, forAll } = req.body;

  const conversation = await findConversation(me, peerId);
  if (!conversation) {
    return res.status(404).json({ message: 'Диалог не найден' });
  }

  if (forAll) {
    await Promise.all([
      Message.deleteMany({ conversationId: conversation._id }),
      Notification.deleteMany({ type: 'message', $or: [{ recipient: me, sender: peerId }, { recipient: peerId, sender: me }] }),
    ]);
    await conversation.deleteOne();
    if (io(req)) {
      io(req).to(`user:${me}`).emit('conversation:deleted', { peerId });
      io(req).to(`user:${peerId}`).emit('conversation:deleted', { peerId: me });
    }
  } else {
    await Message.updateMany({ conversationId: conversation._id }, { $addToSet: { deletedFor: me } });
    await Message.deleteMany({ conversationId: conversation._id, 'deletedFor.1': { $exists: true } });
    conversation.hiddenFor.addToSet(me);
    await conversation.save();
    await Notification.deleteMany({ recipient: me, sender: peerId, type: 'message' });
    if (io(req)) io(req).to(`user:${me}`).emit('conversation:deleted', { peerId });
  }

  res.json({ success: true });
});

module.exports = router;
