// Личная переписка: список диалогов, история со звонками, отправка, вложения,
// пересылка, удаление, статусы «доставлено» и «прочитано». Журнал звонков для соседней
// вкладки — routes/calls.js.
//
// Новые сообщения и статусы приходят в браузер сокетом — в комнату
// `user:<id>`, куда входит каждая вкладка вошедшего (sockets/index.js).
// Раньше открытый диалог опрашивал сервер раз в три секунды.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const fs = require('fs');
const mongoose = require('mongoose');
const User = require('../../models/User');
const { requireAuth, requireAuthApi, requireNotBanned } = require('../../middleware/auth');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Notification = require('../../models/Notification');
const { validate } = require('../../middleware/validate');
const { commonDataMiddleware } = require('./shared');
const userView = require('../../utils/userView');
const callLog = require('../../utils/callLog');
const errorLog = require('../../utils/errorLog');
const attachments = require('../../utils/attachments');
const { uploadAttachment } = require('./uploads');
const { attachLimiter } = require('../../middleware/rateLimit');
const limits = require('../../utils/messageLimit');
const { view } = require('../../utils/messageView');

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

// Сколько у человека непрочитанных после удаления — всего и в диалогах
// с peers. Уходит в событие: удалили непрочитанное — счётчики в шапке
// и в списке диалогов падают сразу, а не после перезагрузки.
async function unreadAfter(userId, peers) {
  // В aggregate mongoose типы не приводит — id сразу ObjectId.
  const oid = (id) => new mongoose.Types.ObjectId(String(id));
  const mine = { recipient: oid(userId), readAt: null, deletedFor: { $ne: oid(userId) } };
  const [unreadMessages, rows] = await Promise.all([
    Message.countDocuments(mine),
    peers.length
      ? Message.aggregate([
          { $match: { ...mine, sender: { $in: peers.map(oid) } } },
          { $group: { _id: '$sender', n: { $sum: 1 } } },
        ])
      : [],
  ]);
  const dialogs = Object.fromEntries(peers.map((p) => [String(p), 0]));
  rows.forEach((r) => { dialogs[String(r._id)] = r.n; });
  return { unreadMessages, dialogs };
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

// Сохранить сообщение и разослать: получателю и вкладкам отправителя.
// Общее у отправки, вложений и пересылки. ref — метка вкладки, отправившей
// файл: по ней она меняет свою заглушку загрузки на готовое сообщение.
async function deliver(req, { conversation, sender, recipient, content = '', attachments: files, forwardedFrom, ref, limit }) {
  const now = new Date();
  const message = await Message.create({
    conversationId: conversation._id,
    sender: sender._id,
    recipient: recipient._id,
    content,
    attachments: files || [],
    limit,
    sentAt: now,
    // Получатель на связи — сообщение дошло до его браузера сразу.
    deliveredAt: isOnline(req, recipient._id) ? now : null,
    forwardedFrom,
  });

  conversation.lastMessage = message._id;
  conversation.lastUpdated = now;
  conversation.hiddenFor = []; // удалённая переписка возвращается с новым сообщением
  await conversation.save();

  // В колокольчик сообщение не пишется (18.09.2026): о нём говорит счётчик
  // у иконки переписки в шапке, его ведёт tk-app.js по message:new.

  const out = view(message);
  const socket = io(req);
  if (socket) {
    socket.to(`user:${recipient._id}`).emit('message:new', { message: out, peer: person(sender) });
    socket.to(`user:${sender._id}`).emit('message:new', { message: out, peer: person(recipient), ...(ref ? { ref } : {}) });
  }
  return out;
}

router.get('/chatsPage', requireAuth, commonDataMiddleware, async (req, res) => {  const me = new ObjectId(String(res.locals.currentUser._id));

  const conversations = await Conversation.find({
    $or: [{ userOne: me }, { userTwo: me }],
    hiddenFor: { $ne: me },
  })
    .populate('userOne userTwo', 'nickname login email avatar isOnline lastSeen')
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
        last: last && {
          // У сообщения с ограничением текст закрыт — в списке только вид.
          content: last.limit && last.limit.mode ? '' : last.content || '',
          kind: last.attachments && last.attachments[0] ? last.attachments[0].kind : '',
          limited: !!(last.limit && last.limit.mode),
          expired: !!last.expiredAt,
          mine: String(last.sender) === String(me),
        },
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
  limit: { type: 'string', default: '', max: 8, label: 'Ограничение' },
}), async (req, res) => {
  const { recipientId, content } = req.body;
  if (!limits.OPTIONS.includes(req.body.limit)) return res.status(400).json({ message: 'Неверное ограничение' });
  const me = req.session.userId;

  const [conversation, sender, recipient] = await Promise.all([
    findConversation(me, recipientId),
    User.findById(me).select('nickname login email avatar').lean(),
    User.findById(recipientId).select('nickname login email avatar').lean(),
  ]);
  if (!conversation || !sender || !recipient) {
    return res.status(404).json({ message: 'Диалог не найден' });
  }

  res.json(await deliver(req, { conversation, sender, recipient, content, limit: limits.parse(req.body.limit, 'text') }));
});


// Вложение: один файл на сообщение, content — подпись к нему. voice=1 —
// голосовое, записанное на странице. Картинка, документ, звук и голосовое
// обрабатываются сразу, и ответ — готовое сообщение. Видео пережимается
// со знаком минуту-другую: ответ 202 сразу, сообщение уходит обоим, когда
// готово, а вкладка отправителя узнаёт своё по ref (message:new или
// message:failed).
router.post('/messages/attach', requireAuthApi, requireNotBanned, attachLimiter, uploadAttachment.single('file'), async (req, res) => {
  const file = req.file;
  const drop = () => file && fs.promises.rm(file.path, { force: true }).catch(() => {});
  const { recipientId } = req.body;
  const content = String(req.body.content || '').trim();
  const ref = String(req.body.ref || '').slice(0, 40);
  const special = ['voice', 'round'].includes(req.body.special) ? req.body.special : '';
  const option = String(req.body.limit || '');
  const me = req.session.userId;

  if (!file) return res.status(400).json({ message: 'Файл не пришёл' });
  if (typeof recipientId !== 'string' || !ObjectId.isValid(recipientId) || content.length > 5000 || !limits.OPTIONS.includes(option)) {
    drop();
    return res.status(400).json({ message: 'Неверный запрос' });
  }
  if (!attachments.enabled) {
    drop();
    return res.status(503).json({ message: 'Файлы сейчас не принимаются' });
  }

  const [conversation, sender, recipient] = await Promise.all([
    findConversation(me, recipientId),
    User.findById(me).select('nickname login email avatar').lean(),
    User.findById(recipientId).select('nickname login email avatar').lean(),
  ]);
  if (!conversation || !sender || !recipient) {
    drop();
    return res.status(404).json({ message: 'Диалог не найден' });
  }

  // Записанное на странице (голосовое, кружок) браузер собирает сам, и
  // телефоны пишут по-разному. Отказ по такому файлу — в журнал панели
  // с тем, что прислали: иначе причину с чужого телефона не узнать.
  const note = (e) => special && errorLog.record({ scope: 'media', err: e, route: `attach.${special}`, status: e.status || 500, req,
    meta: { name: file.originalname, type: file.mimetype, size: file.size, head: e.head, cause: e.cause && e.cause.message } });

  let info;
  try {
    info = await attachments.inspect(file, { special });
  } catch (e) {
    note(e);
    drop();
    throw e;
  }

  // У вложения с ограничением подписи нет: она ушла бы вместе с файлом
  // в корзину. Текст уходит отдельным обычным сообщением перед ним.
  const limit = limits.parse(option, info.kind);
  if (limit && content) await deliver(req, { conversation, sender, recipient, content });
  const send = async () => {
    const stored = await attachments.store(info, conversation._id);
    return deliver(req, { conversation, sender, recipient, content: limit ? '' : content, attachments: [stored], ref, limit });
  };

  if (!attachments.SLOW.has(info.kind)) {
    try {
      return res.json(await send());
    } catch (e) {
      note(e);
      throw e;
    }
  }

  res.status(202).json({ pending: true, ref });
  send().catch((e) => {
    if (special) note(e);
    else if (!e.expose) errorLog.media(e, 'attachments.video', { conversation: String(conversation._id) });
    const socket = io(req);
    if (socket) socket.to(`user:${me}`).emit('message:failed', { ref, message: e.expose ? e.message : 'Не удалось обработать видео' });
  });
});


// Пересылка сообщений — одного или выделенных пачкой — одному или нескольким
// собеседникам. Подпись «переслано от» — изначальный автор, даже если
// пересылают пересланное. comment — своё сообщение к пересылке: уходит
// первым, над пересланными, как подпись к ним.
router.post('/messages/forward', requireAuthApi, requireNotBanned, validate({
  messageIds: { type: 'array', required: true, max: 50, of: { type: 'objectId' }, label: 'Сообщения' },
  recipientIds: { type: 'array', required: true, max: 20, of: { type: 'objectId' }, label: 'Кому' },
  comment: { type: 'string', max: 5000, default: '', label: 'Комментарий' },
}), async (req, res) => {
  const me = String(req.session.userId);
  const { comment } = req.body;
  const recipientIds = [...new Set(req.body.recipientIds)].filter((id) => id !== me);
  if (!recipientIds.length) {
    return res.status(400).json({ message: 'Выберите, кому переслать' });
  }

  // Порядок — как в переписке, по времени, а не как их выделяли.
  // Сообщение с ограничением не пересылается: иначе его копия жила бы
  // без ограничения.
  const originals = await Message.find({
    _id: { $in: [...new Set(req.body.messageIds)] },
    $or: [{ sender: me }, { recipient: me }],
    deletedFor: { $ne: me },
    'limit.mode': { $exists: false },
  }).sort({ sentAt: 1 }).lean();
  if (!originals.length) {
    return res.status(404).json({ message: 'Сообщение не найдено' });
  }

  const [sender, recipients] = await Promise.all([
    User.findById(me).select('nickname login email avatar').lean(),
    User.find({ _id: { $in: recipientIds } }).select('nickname login email avatar').lean(),
  ]);

  // Автор каждого — один раз на всю пачку: в выделении обычно два человека.
  const authors = new Map([[me, sender]]);
  // Пересланное дальше — с исходным автором и временем, но в новой пачке.
  const batchId = new ObjectId().toString();
  const origin = async (m) => {
    if (m.forwardedFrom && m.forwardedFrom.name) {
      return { user: m.forwardedFrom.user, name: m.forwardedFrom.name, sentAt: m.forwardedFrom.sentAt || m.sentAt, batch: batchId };
    }
    const id = String(m.sender);
    if (!authors.has(id)) authors.set(id, await User.findById(id).select('nickname login email').lean());
    const author = authors.get(id);
    return author
      ? { user: author._id, name: userView.displayName(author), sentAt: m.sentAt, batch: batchId }
      : { user: m.sender, name: '#' + id.slice(-6), sentAt: m.sentAt, batch: batchId };
  };
  const batch = [];
  for (const m of originals) batch.push({ content: m.content, attachments: m.attachments, forwardedFrom: await origin(m) });

  const sent = [];
  for (const recipient of recipients) {
    let conversation = await findConversation(me, recipient._id);
    if (!conversation) conversation = await Conversation.create({ userOne: me, userTwo: recipient._id });
    if (comment) sent.push(await deliver(req, { conversation, sender, recipient, content: comment }));
    for (const item of batch) sent.push(await deliver(req, { conversation, sender, recipient, ...item }));
  }

  res.json({ success: true, messages: sent });
});


// ── Сообщения с ограничением (utils/messageLimit.js) ──
// Открыть: засчитать раз, отдать текст и адреса файла на время. Открывает
// только получатель; исчерпано или истекло — 410.
router.post('/messages/:id/open', requireAuthApi, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Сообщение не найдено' });
  const m = await limits.open(req.params.id, req.session.userId);
  if (!m) return res.status(410).json({ message: 'Сообщение больше недоступно', expired: true });
  const a = m.attachments[0];
  const file = `/messages/${m._id}/file`;
  const out = view(m);
  if (io(req)) io(req).to(`user:${m.sender}`).emit('message:limit', { id: String(m._id), limit: out.limit });
  res.json({
    content: m.content || '',
    attachment: a ? { ...out.attachments[0], url: file, preview: a.preview ? file + '?part=preview' : '' } : null,
    limit: out.limit,
    until: m.limit.mode === 'timer' ? m.limit.expiresAt : m.limit.grantUntil,
  });
});

// Окно закрыто — последний раз стирается сразу.
router.post('/messages/:id/close', requireAuthApi, async (req, res) => {
  if (ObjectId.isValid(req.params.id)) await limits.close(req.params.id, req.session.userId);
  res.json({ success: true });
});

// Файл открытого сообщения — через сервер, пока идёт окно выдачи.
router.get('/messages/:id/file', requireAuthApi, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(404).end();
  const m = await Message.findOne({
    _id: req.params.id, recipient: req.session.userId, expiredAt: null,
    'limit.grantUntil': { $gt: new Date() },
  }).lean();
  if (!m || !m.attachments[0]) return res.status(410).end();
  // Документ скачан последний раз целиком — стираем, не дожидаясь срока.
  // Оборванное скачивание (close без finish) не считается: можно повторить,
  // пока идёт срок выдачи.
  if (m.limit.mode === 'downloads' && m.limit.used >= m.limit.n) {
    res.on('finish', () => { limits.expire(m._id).catch(() => {}); });
  }
  await limits.pipe(req, res, m, req.query.part === 'preview' ? 'preview' : 'main');
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

  const [unread, unreadMessages] = await Promise.all([
    Notification.countDocuments({ recipient: me, isRead: false, type: { $ne: 'message' } }),
    Message.countDocuments({ recipient: me, readAt: null, deletedFor: { $ne: me } }),
  ]);
  res.json({ success: true, unread, unreadMessages });
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
    await attachments.deleteMessages({ _id: { $in: [...mineIds] } });
    const peers = new Set(mine.map((m) => String(m.recipient)));
    if (io(req)) {
      const ids = [...mineIds];
      io(req).to(`user:${me}`).emit('message:deleted', { ids });
      // У собеседника могли пропасть его непрочитанные.
      for (const p of peers) {
        io(req).to(`user:${p}`).emit('message:deleted', { ids, ...(await unreadAfter(p, [me])) });
      }
    }
  }

  if (rest.length) {
    const restIds = rest.map((m) => m._id);
    await Message.updateMany({ _id: { $in: restIds } }, { $addToSet: { deletedFor: me } });
    await attachments.deleteMessages({ _id: { $in: restIds }, 'deletedFor.1': { $exists: true } });
    if (io(req)) {
      const senders = [...new Set(rest.filter((m) => String(m.recipient) === me).map((m) => String(m.sender)))];
      io(req).to(`user:${me}`).emit('message:deleted', { ids: restIds.map(String), ...(await unreadAfter(me, senders)) });
    }
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
      attachments.deleteMessages({ conversationId: conversation._id }),
      Notification.deleteMany({ type: 'message', $or: [{ recipient: me, sender: peerId }, { recipient: peerId, sender: me }] }),
    ]);
    await conversation.deleteOne();
    if (io(req)) {
      io(req).to(`user:${me}`).emit('conversation:deleted', { peerId, ...(await unreadAfter(me, [])) });
      io(req).to(`user:${peerId}`).emit('conversation:deleted', { peerId: me, ...(await unreadAfter(peerId, [])) });
    }
  } else {
    await Message.updateMany({ conversationId: conversation._id }, { $addToSet: { deletedFor: me } });
    await attachments.deleteMessages({ conversationId: conversation._id, 'deletedFor.1': { $exists: true } });
    conversation.hiddenFor.addToSet(me);
    await conversation.save();
    await Notification.deleteMany({ recipient: me, sender: peerId, type: 'message' });
    if (io(req)) io(req).to(`user:${me}`).emit('conversation:deleted', { peerId, ...(await unreadAfter(me, [])) });
  }

  res.json({ success: true });
});

module.exports = router;
