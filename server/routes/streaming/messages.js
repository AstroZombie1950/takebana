// Личная переписка: список диалогов, история со звонками, отправка, вложения,
// пересылка, удаление, статусы «доставлено» и «прочитано». Журнал звонков для соседней
// вкладки — routes/calls.js.
//
// Новые сообщения и статусы приходят в браузер сокетом — в комнату
// `user:<id>`, куда входит каждая вкладка вошедшего (sockets/index.js).
// Раньше открытый диалог опрашивал сервер раз в три секунды.

const express = require('express');
const rateLimit = require('express-rate-limit');
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
const push = require('../../utils/push');
const { rankPeers } = require('../../utils/recentPeers');
const { audit } = require('../../utils/audit');
const { view } = require('../../utils/messageView');
const restriction = require('../../utils/restrict');
const { tr, langOf } = require('../../utils/i18n');

// Ограничение доступа закрывает и переписку (utils/restrict.js): 403
// с объяснением, кто кого ограничил. true — ответ уже отправлен.
async function refuseRestricted(res, me, peerId) {
  const who = await restriction.between(me, peerId);
  if (!who) return false;
  res.status(403).json({ success: false, restricted: who, message: restriction.BLOCKED[who] });
  return true;
}

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

// Диалог двоих — найти или завести. Заводится одной операцией по ключу
// пары (models/Conversation.js): при гонке второй запрос получает тот же
// диалог, а не свой.
async function openConversation(a, b) {
  const found = await findConversation(a, b);
  if (found) return found;
  const pair = [String(a), String(b)].sort().join(':');
  return Conversation.findOneAndUpdate(
    { pair },
    { $setOnInsert: { userOne: a, userTwo: b, pair } },
    { upsert: true, returnDocument: 'after' }
  );
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

// Сколько ждём, прежде чем будить телефон человека, у которого открыта
// вкладка. Правило «есть сокет — молчим» было бы неверным: вкладка, забытая
// открытой на рабочем ноутбуке, навсегда отключила бы пуши на телефон.
// Поэтому ждём полминуты и смотрим, прочитано ли. Прочитал — будить незачем.
const PUSH_WAIT_MS = 30000;

// Что показать в пуше вместо текста, когда текста нет, и когда показывать
// его нельзя вовсе. Правило то же, что у уведомления открытой вкладки
// (public/tk-notify.js), кроме исчезающих: их не видно и в самой переписке,
// пока не откроешь, — тем более незачем показывать на заблокированном экране.
function pushText(m) {
  // Исчезающее — так и говорим: «новое сообщение» про него сбивало с толку.
  if (m.limit) return { bodyKey: 'push.disappearing' };
  // Именно .name, а не сам forwardedFrom: это вложенный объект схемы, и у
  // обычного сообщения он не пустой, а пустой объект — то есть истина.
  // Так же его проверяет utils/messageView.js.
  if (m.forwardedFrom && m.forwardedFrom.name) return { previewKey: 'notify.forwarded' };
  const content = String(m.content || '').trim();
  if (content) return { preview: content };
  const kind = m.attachments && m.attachments[0] && m.attachments[0].kind;
  return kind ? { previewKey: 'chats.att.' + kind } : {};
}

// Пуш о сообщении: на устройства получателя, когда он не читает его прямо
// сейчас. Ничего не ждёт и ничего не роняет — пуш не важнее сообщения.
function pushMessage({ message, sender, recipient, online }) {
  const note = Object.assign({
    topic: 'message',
    title: userView.displayName(sender),
    bodyKey: 'push.newMessage',
    // Метка по собеседнику: пять сообщений подряд — одно уведомление
    // на экране, а не стопка из пяти.
    tag: 'msg-' + String(sender._id),
    url: '/chatsPage?peer=' + String(sender._id),
  }, pushText(message));

  const fire = () => Message.findById(message._id).select('readAt').lean()
    .then((fresh) => (fresh && !fresh.readAt ? push.send(recipient._id, note) : null))
    .catch((e) => errorLog.server(e, 'push.message'));

  if (!online) return fire();
  // unref: недоотправленный пуш не повод держать процесс живым при остановке.
  setTimeout(fire, PUSH_WAIT_MS).unref();
}

// Сохранить сообщение и разослать: получателю и вкладкам отправителя.
// Общее у отправки, вложений и пересылки. ref — метка вкладки, отправившей
// файл: по ней она меняет свою заглушку загрузки на готовое сообщение.
async function deliver(req, { conversation, sender, recipient, content = '', attachments: files, forwardedFrom, ref, limit, silent }) {
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
  // silent — пересылка пачкой: двадцать писем за секунду это одно действие
  // человека, и будить телефон двадцать раз незачем. Пуш уходит с последним.
  if (!silent) pushMessage({ message, sender, recipient, online: isOnline(req, recipient._id) });
  return out;
}

// Список переписок — страницами по DIALOGS_PAGE, от свежих к старым по
// lastUpdated (его двигает каждое новое сообщение, deliver). before —
// lastUpdated последнего уже показанного. Раньше список отдавался целиком:
// у человека с сотнями диалогов — сотни строк и запросов на каждое открытие.
const DIALOGS_PAGE = 30;
async function dialogPage(me, before) {
  const conversations = await Conversation.find({
    $or: [{ userOne: me }, { userTwo: me }],
    hiddenFor: { $ne: me },
    ...(before ? { lastUpdated: { $lt: before } } : {}),
  })
    .sort({ lastUpdated: -1 })
    .limit(DIALOGS_PAGE + 1)
    .populate('userOne userTwo', 'nickname login email avatar isOnline lastSeen')
    .lean();
  const more = conversations.length > DIALOGS_PAGE;
  if (more) conversations.pop();

  const ids = conversations.map((c) => c._id);
  // Последнее сообщение диалога хранится в нём самом (deliver). Перебирать
  // все сообщения всех диалогов, как раньше, незачем: у активного человека
  // это секунды на каждое открытие страницы. Своё «последнее» ищем только
  // там, где хранимое удалено или удалено у меня, — по индексу, по одному.
  const [stored, unreadRows] = await Promise.all([
    Message.find({ _id: { $in: conversations.map((c) => c.lastMessage).filter(Boolean) } }).lean(),
    Message.aggregate([
      { $match: { conversationId: { $in: ids }, recipient: me, readAt: null, deletedFor: { $ne: me } } },
      { $group: { _id: '$conversationId', n: { $sum: 1 } } },
    ]),
  ]);
  const visible = new Map(stored
    .filter((m) => !(m.deletedFor || []).some((id) => String(id) === String(me)))
    .map((m) => [String(m.conversationId), m]));
  const lastRows = await Promise.all(conversations.map(async (c) => ({
    _id: c._id,
    last: visible.get(String(c._id)) || await Message.findOne({ conversationId: c._id, deletedFor: { $ne: me } })
      .sort({ sentAt: -1 }).lean(),
  })));
  const lastBy = new Map(lastRows.filter((r) => r.last).map((r) => [String(r._id), r.last]));
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
    });

  return { list, more, before: more ? conversations[conversations.length - 1].lastUpdated : null };
}

router.get('/chatsPage', requireAuth, commonDataMiddleware, async (req, res) => {
  const me = new ObjectId(String(res.locals.currentUser._id));
  const { list, before } = await dialogPage(me, null);

  // Лента «Недавние» над списком диалогов: с кем чаще и ближе к сегодняшнему
  // дню общались — письмами и звонками (utils/recentPeers.js). Звонить можно
  // и тому, с кем переписки нет, — таких собеседников догружаем отдельно.
  // «Недавние» смотрят на два месяца назад (utils/recentPeers.js) — им
  // нужны диалоги этого срока, а не вся первая страница списка.
  const recentConversations = await Conversation.find({
    $or: [{ userOne: me }, { userTwo: me }],
    hiddenFor: { $ne: me },
    lastUpdated: { $gte: new Date(Date.now() - 60 * 24 * 3600 * 1000) },
  }).select('userOne userTwo').lean();
  const order = await rankPeers(me, recentConversations);
  const known = new Map(list.map((c) => [String(c.interlocutor.id), c.interlocutor]));
  const unknown = order.filter((id) => !known.has(id));
  if (unknown.length) {
    const users = await User.find({ _id: { $in: unknown } })
      .select('nickname login email avatar isOnline')
      .lean();
    for (const user of users) known.set(String(user._id), { ...person(user), isOnline: !!user.isOnline });
  }
  const recent = order.map((id) => known.get(id)).filter(Boolean);

  // Вкладки «Звонки» и «Контакты» открываются и адресом: из уведомления
  // о пропущенном и из ссылок «в контакты» на других страницах.
  const tabs = ['calls', 'contacts'];
  res.render('chatsPage', { conversations: list, dialogsBefore: before ? before.toISOString() : '', recent, timeAgo, tab: tabs.includes(req.query.tab) ? req.query.tab : 'messages' });
});


// Следующая страница списка переписок — прокрутка до конца (public/chats.js).
router.get('/api/dialogs', requireAuthApi, async (req, res) => {
  const before = typeof req.query.before === 'string' ? new Date(req.query.before) : null;
  if (!before || isNaN(before)) return res.status(400).json({ message: 'Неверный запрос' });
  const page = await dialogPage(new ObjectId(String(req.session.userId)), before);
  res.json({ dialogs: page.list, before: page.before });
});

router.post('/start-conversation', requireAuthApi, requireNotBanned, validate({
  recipientId: { type: 'objectId', required: true, label: 'Собеседник' },
}), async (req, res) => {
  const me = req.session.userId;
  const { recipientId } = req.body;
  if (recipientId === String(me)) {
    return res.status(400).json({ success: false, message: 'Нельзя написать самому себе' });
  }
  if (await refuseRestricted(res, me, recipientId)) return;

  // Диалог с тем, кого нет, заводился: аккаунт удалён или id выдуман.
  if (!(await User.exists({ _id: recipientId }))) {
    return res.status(404).json({ success: false, message: 'Пользователь не найден' });
  }

  const conversation = await openConversation(me, recipientId);
  if (conversation.hiddenFor.some((id) => String(id) === String(me))) {
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

  res.json({ messages: messages.reverse().map(view), calls, restricted: await restriction.between(me, recipientId) });
});


// Тридцать сообщений в минуту с человека: переписке хватает, а скрипт,
// забрасывающий собеседника, упирается сразу.
const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => String(req.session.userId),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Слишком много сообщений. Подождите минуту.' },
});

router.post('/sendMessage', requireAuthApi, requireNotBanned, sendLimiter, validate({
  recipientId: { type: 'objectId', required: true, label: 'Собеседник' },
  content: { type: 'string', required: true, min: 1, max: 5000, label: 'Сообщение' },
  limit: { type: 'string', default: '', max: 8, label: 'Ограничение' },
}), async (req, res) => {
  const { recipientId, content } = req.body;
  if (!limits.OPTIONS.includes(req.body.limit)) return res.status(400).json({ message: 'Неверное ограничение' });
  const me = req.session.userId;
  if (await refuseRestricted(res, me, recipientId)) return;

  const [conversation, sender, recipient] = await Promise.all([
    findConversation(me, recipientId),
    User.findById(me).select('nickname login email avatar').lean(),
    User.findById(recipientId).select('nickname login email avatar').lean(),
  ]);
  if (!conversation || !sender || !recipient) {
    return res.status(404).json({ message: 'Диалог не найден' });
  }

  try {
    res.json(await deliver(req, { conversation, sender, recipient, content, limit: limits.parse(req.body.limit, 'text') }));
  } catch (e) {
    // Удачу текстового сообщения не пишем — их тысячи; отказ пишем всегда.
    // Без этого «сообщение не отправилось» не оставляло следа нигде.
    audit(req, 'msg.send', { result: 'fail', targetType: 'user', targetId: recipient._id,
      meta: { error: e.message, len: content.length } });
    throw e;
  }
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
  if (await restriction.between(me, recipientId)) {
    drop();
    return refuseRestricted(res, me, recipientId);
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

  // Что именно прислали — в журнал в обоих исходах, и начиная с проверки
  // файла: отказы «такие файлы не принимаем» и «содержимое не совпадает
  // с типом» случаются раньше всего и до 20.09.2026 не оставляли следа
  // нигде, кроме ответа одному человеку. Это первое место, куда смотреть,
  // когда говорят «кружок не отправляется».
  const startedAt = Date.now();
  const mark = (result, extra = {}) => audit(req, 'msg.attach', {
    result, targetType: 'user', targetId: recipient._id,
    meta: {
      kind: special || 'file', ext: String(file.originalname || '').split('.').pop().slice(0, 8).toLowerCase(),
      mb: +(file.size / 1048576).toFixed(2), ms: Date.now() - startedAt, ...extra,
    },
  });

  let info;
  try {
    info = await attachments.inspect(file, { special });
  } catch (e) {
    note(e);
    mark('fail', { error: e.message, stage: 'inspect' });
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
      const out = await send();
      mark('ok', { kind: info.kind, ext: info.ext });
      return res.json(out);
    } catch (e) {
      note(e);
      mark('fail', { kind: info.kind, ext: info.ext, error: e.message, stage: 'store' });
      throw e;
    }
  }

  res.status(202).json({ pending: true, ref });
  send().then(
    () => mark('ok', { kind: info.kind, ext: info.ext }),
    (e) => {
      if (special) note(e);
      else if (!e.expose) errorLog.media(e, 'attachments.video', { conversation: String(conversation._id) });
      // Пережатие идёт уже после ответа 202: отказ здесь человек видит
      // заглушкой, а мы — только отсюда.
      mark('fail', { kind: info.kind, ext: info.ext, error: e.message, stage: 'encode' });
      const socket = io(req);
      // Ответ уже ушёл, и перевод JSON-ответов (utils/i18n.js) сюда не
      // дотягивается — переводим сами, на язык отправителя.
      const text = e.expose ? e.message : 'Не удалось обработать видео';
      if (socket) socket.to(`user:${me}`).emit('message:failed', { ref, message: tr(langOf(req), text) });
    }
  );
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
  const chosen = [...new Set(req.body.recipientIds)].filter((id) => id !== me);
  if (!chosen.length) {
    return res.status(400).json({ message: 'Выберите, кому переслать' });
  }
  // Тем, с кем стоит ограничение доступа, не пересылается (utils/restrict.js).
  const barred = await Promise.all(chosen.map((id) => restriction.between(me, id)));
  const recipientIds = chosen.filter((id, i) => !barred[i]);
  if (!recipientIds.length) {
    return res.status(403).json({ restricted: barred[0], message: restriction.BLOCKED[barred[0]] });
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
    const conversation = await openConversation(me, recipient._id);
    // Пуш — один на всю пересылку, с последним сообщением пачки.
    if (comment) sent.push(await deliver(req, { conversation, sender, recipient, content: comment, silent: batch.length > 0 }));
    for (let i = 0; i < batch.length; i++) {
      sent.push(await deliver(req, { conversation, sender, recipient, ...batch[i], silent: i < batch.length - 1 }));
    }
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
      [{ $set: { readAt: now, deliveredAt: { $ifNull: ['$deliveredAt', now] } } }],
      { updatePipeline: true }
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


// Удаление сообщений — как в Telegram (решение 24.09.2026): «у всех» можно
// любое сообщение переписки, своё и собеседника, — документ стирается,
// и у второго оно пропадает сразу. «У меня» — остаётся у собеседника;
// когда удалили оба, стирается совсем.
router.post('/messages/delete', requireAuthApi, validate({
  ids: { type: 'array', required: true, max: 100, of: { type: 'objectId' }, label: 'Сообщения' },
  forAll: { type: 'bool', default: false, label: 'У всех' },
}), async (req, res) => {
  const me = String(req.session.userId);
  const { ids, forAll } = req.body;

  // Только то, что я вижу: удалённое у себя больше не моё, чтобы стирать
  // его у собеседника (в Telegram его тоже уже не достать).
  const messages = await Message.find({ _id: { $in: ids }, $or: [{ sender: me }, { recipient: me }], deletedFor: { $ne: me } })
    .select('sender recipient')
    .lean();
  if (!messages.length) return res.json({ success: true, deleted: 0 });
  const found = messages.map((m) => m._id);
  const peerOf = (m) => (String(m.sender) === me ? String(m.recipient) : String(m.sender));
  // Собеседники, чьи входящие мне могли быть непрочитанными.
  const senders = [...new Set(messages.filter((m) => String(m.recipient) === me).map((m) => String(m.sender)))];

  if (forAll) {
    await attachments.deleteMessages({ _id: { $in: found } });
    if (io(req)) {
      const out = found.map(String);
      io(req).to(`user:${me}`).emit('message:deleted', { ids: out, ...(await unreadAfter(me, senders)) });
      // У собеседника могли пропасть его непрочитанные.
      for (const p of new Set(messages.map(peerOf))) {
        io(req).to(`user:${p}`).emit('message:deleted', { ids: out, ...(await unreadAfter(p, [me])) });
      }
    }
  } else {
    await Message.updateMany({ _id: { $in: found } }, { $addToSet: { deletedFor: me } });
    await attachments.deleteMessages({ _id: { $in: found }, 'deletedFor.1': { $exists: true } });
    if (io(req)) {
      io(req).to(`user:${me}`).emit('message:deleted', { ids: found.map(String), ...(await unreadAfter(me, senders)) });
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
