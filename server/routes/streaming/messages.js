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
const Group = require('../../models/Group');
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
const { view, viewAll, QUOTED } = require('../../utils/messageView');
const restriction = require('../../utils/restrict');
const privacy = require('../../utils/privacy');
const groups = require('../../utils/groups');
const { tr, langOf } = require('../../utils/i18n');

// Ограничение доступа закрывает и переписку (utils/restrict.js): 403
// с объяснением, кто кого ограничил. true — ответ уже отправлен.
async function refuseRestricted(res, me, peerId) {
  const who = await restriction.between(me, peerId);
  if (!who) return false;
  res.status(403).json({ success: false, restricted: who, message: restriction.BLOCKED[who] });
  return true;
}

// Правило получателя «кто может писать» (utils/privacy.js). Отказ — 403
// и null. Иначе решение: заявку ставим, ответ на чужую заявку её принимает —
// поле диалога меняется здесь, сохраняет его deliver.
async function gate(res, conversation, me, peerId) {
  const g = await privacy.messageGate(conversation, me, peerId);
  if (!g.ok) {
    res.status(403).json({ success: false, privacy: g.rule, message: g.message });
    return null;
  }
  if (conversation && g.request && !conversation.requestFor) conversation.requestFor = peerId;
  if (conversation && g.accept) conversation.requestFor = undefined;
  return g;
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
    groups.unreadTotal(userId),
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
  return { id: String(user._id), displayName, avatarStyle: userView.avatarStyle(user, displayName), ...(privacy.isOfficial(user) ? { official: true } : {}) };
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
async function deliver(req, { conversation, sender, recipient, content = '', attachments: files, forwardedFrom, ref, limit, silent, reply }) {
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
    replyTo: reply ? reply._id : null,
  });

  conversation.lastMessage = message._id;
  conversation.lastUpdated = now;
  conversation.hiddenFor = []; // удалённая переписка возвращается с новым сообщением
  await conversation.save();
  // Заявка (utils/privacy.js): получатель видит её в своей папке, без пуша
  // и звука, и в счётчик она не идёт.
  const request = !!conversation.requestFor && String(conversation.requestFor) === String(recipient._id);

  // В колокольчик сообщение не пишется (18.09.2026): о нём говорит счётчик
  // у иконки переписки в шапке, его ведёт tk-app.js по message:new.

  const out = view(message, reply);
  const socket = io(req);
  if (socket) {
    socket.to(`user:${recipient._id}`).emit('message:new', { message: out, peer: person(sender), ...(request ? { request: true } : {}) });
    socket.to(`user:${sender._id}`).emit('message:new', { message: out, peer: person(recipient), ...(ref ? { ref } : {}) });
  }
  // silent — пересылка пачкой: двадцать писем за секунду это одно действие
  // человека, и будить телефон двадцать раз незачем. Пуш уходит с последним.
  if (!silent && !request) pushMessage({ message, sender, recipient, online: isOnline(req, recipient._id) });
  return out;
}

// Список переписок — страницами по DIALOGS_PAGE, от свежих к старым по
// lastUpdated (его двигает каждое новое сообщение, deliver). before —
// lastUpdated последнего уже показанного. Раньше список отдавался целиком:
// у человека с сотнями диалогов — сотни строк и запросов на каждое открытие.
const DIALOGS_PAGE = 30;
// requests — папка «Заявки» (utils/privacy.js): только они и без групп.
// Обычный список заявки к себе не показывает.
async function dialogPage(me, before, { requests = false } = {}) {
  const conversations = await Conversation.find({
    $or: [{ userOne: me }, { userTwo: me }],
    hiddenFor: { $ne: me },
    requestFor: requests ? me : { $ne: me },
    ...(before ? { lastUpdated: { $lt: before } } : {}),
  })
    .sort({ lastUpdated: -1 })
    .limit(DIALOGS_PAGE + 1)
    .populate('userOne userTwo', 'nickname login email avatar isOnline lastSeen role')
    .lean();
  const more = conversations.length > DIALOGS_PAGE;
  if (more) conversations.pop();
  // «В сети» — только тем, кому человек его показывает.
  await privacy.maskPresence(me, conversations.map((c) => (String(c.userOne && c.userOne._id) === String(me) ? c.userTwo : c.userOne)));

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
        sortAt: c.lastUpdated,
      };
    });

  // Группы — в тот же список, по тому же времени (models/Group.js). Две
  // выборки по странице каждая, общий порядок, срез: отрезанное придёт
  // следующей страницей — у него lastUpdated раньше нового before.
  const rows = list.concat(requests ? [] : await groupRows(me, before)).sort((a, b) => b.sortAt - a.sortAt);
  const page = rows.slice(0, DIALOGS_PAGE);
  const cut = more || rows.length > DIALOGS_PAGE;
  page.forEach((r) => { delete r.sortAt; });
  return { list: page, more: cut, before: cut ? rows[DIALOGS_PAGE - 1].sortAt : null };
}

// Строки групп для списка диалогов: последнее видимое мне сообщение с его
// автором, непрочитанное. Страница — как у личных, по lastUpdated.
async function groupRows(me, before) {
  const list = await Group.find({ 'members.user': me, ...(before ? { lastUpdated: { $lt: before } } : {}) })
    .sort({ lastUpdated: -1 })
    .limit(DIALOGS_PAGE + 1)
    .lean();
  if (!list.length) return [];
  const [stored, unread] = await Promise.all([
    Message.find({ _id: { $in: list.map((g) => g.lastMessage).filter(Boolean) }, deletedFor: { $ne: me } }).lean(),
    groups.unread(me),
  ]);
  const byGroup = new Map(stored.map((m) => [String(m.conversationId), m]));
  const lasts = await Promise.all(list.map((g) => byGroup.get(String(g._id))
    || Message.findOne({ conversationId: g._id, deletedFor: { $ne: me } }).sort({ sentAt: -1 }).lean()));
  const authors = await User.find({ _id: { $in: lasts.filter(Boolean).map((m) => m.sender) } }).select('nickname login email').lean();
  const nameOf = new Map(authors.map((u) => [String(u._id), userView.displayName(u)]));
  return list.map((g, i) => {
    const last = lasts[i];
    return {
      group: groups.brief(g),
      last: last && {
        content: last.content || '',
        kind: last.attachments && last.attachments[0] ? last.attachments[0].kind : '',
        system: last.system && last.system.kind ? view(last).system : null,
        mine: String(last.sender) === String(me),
        author: nameOf.get(String(last.sender)) || '',
      },
      unread: unread.byGroup[String(g._id)] || 0,
      lastActivity: last ? last.sentAt : g.createdAt,
      sortAt: g.lastUpdated,
    };
  });
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
    requestFor: { $ne: me },
    lastUpdated: { $gte: new Date(Date.now() - 60 * 24 * 3600 * 1000) },
  }).select('userOne userTwo').lean();
  const order = await rankPeers(me, recentConversations);
  // Строки групп собеседника не несут — в «недавние» идут только люди.
  const known = new Map(list.filter((c) => c.interlocutor).map((c) => [String(c.interlocutor.id), c.interlocutor]));
  const unknown = order.filter((id) => !known.has(id));
  if (unknown.length) {
    const users = await User.find({ _id: { $in: unknown } })
      .select('nickname login email avatar isOnline role')
      .lean();
    await privacy.maskPresence(me, users);
    for (const user of users) known.set(String(user._id), { ...person(user), isOnline: !!user.isOnline });
  }
  const recent = order.map((id) => known.get(id)).filter(Boolean);

  // Вкладки «Звонки» и «Контакты» открываются и адресом: из уведомления
  // о пропущенном и из ссылок «в контакты» на других страницах.
  const tabs = ['calls', 'contacts'];
  // Заявки — кто их прислал: счётчик папки считает людей, а не сообщения.
  const requests = (await Conversation.find({ requestFor: me, hiddenFor: { $ne: me } }).select('userOne userTwo').limit(500).lean())
    .map((c) => String(String(c.userOne) === String(me) ? c.userTwo : c.userOne));
  res.render('chatsPage', { conversations: list, dialogsBefore: before ? before.toISOString() : '', recent, requests, timeAgo, tab: tabs.includes(req.query.tab) ? req.query.tab : 'messages' });
});


// Следующая страница списка переписок — прокрутка до конца (public/chats.js).
router.get('/api/dialogs', requireAuthApi, async (req, res) => {
  const before = typeof req.query.before === 'string' ? new Date(req.query.before) : null;
  if (!before || isNaN(before)) return res.status(400).json({ message: 'Неверный запрос' });
  const page = await dialogPage(new ObjectId(String(req.session.userId)), before);
  res.json({ dialogs: page.list, before: page.before });
});

// Папка «Заявки»: первая страница без before, дальше — как у списка.
router.get('/api/requests', requireAuthApi, async (req, res) => {
  const before = typeof req.query.before === 'string' ? new Date(req.query.before) : null;
  if (before && isNaN(before)) return res.status(400).json({ message: 'Неверный запрос' });
  const page = await dialogPage(new ObjectId(String(req.session.userId)), before, { requests: true });
  res.json({ dialogs: page.list, before: page.before });
});

// Принять заявку: диалог переходит в обычный список. Отклонить — удалить
// переписку у себя (/conversations/delete): новое сообщение вернёт её в заявки.
router.post('/requests/accept', requireAuthApi, validate({
  peerId: { type: 'objectId', required: true, label: 'Собеседник' },
}), async (req, res) => {
  const me = req.session.userId;
  const conversation = await findConversation(me, req.body.peerId);
  if (!conversation || String(conversation.requestFor) !== String(me)) {
    return res.status(404).json({ message: 'Диалог не найден' });
  }
  conversation.requestFor = undefined;
  await conversation.save();
  res.json({ success: true, unreadMessages: await groups.unreadTotal(me) });
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
  // Закрытую личку видно сразу, по кнопке «Написать», а не после текста.
  if (!(await gate(res, await findConversation(me, recipientId), me, recipientId))) return;

  const conversation = await openConversation(me, recipientId);
  // «Написать» тому, кто прислал мне заявку, — значит принять её: иначе
  // переписка открылась бы из общего списка, а её там нет.
  if (String(conversation.requestFor) === String(me)) conversation.requestFor = undefined;
  if (conversation.hiddenFor.some((id) => String(id) === String(me))) {
    // Написать тому, с кем переписку удалили, — значит вернуть диалог в список.
    conversation.hiddenFor.pull(me);
  }
  if (conversation.isModified()) await conversation.save();

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

  // Заявка: 'in' — ко мне (показать «Принять»), 'out' — моя, ждёт ответа.
  const request = conversation.requestFor ? (String(conversation.requestFor) === String(me) ? 'in' : 'out') : null;
  res.json({ messages: await viewAll(messages.reverse()), calls, restricted: await restriction.between(me, recipientId), request });
});


// Сообщение, на которое отвечают: только из этого же диалога. Нет его
// (удалили, пока писали ответ) — уходит обычное сообщение, без цитаты.
function replyOf(conversation, id) {
  return id ? Message.findOne({ _id: id, conversationId: conversation._id }).select(QUOTED).lean() : null;
}

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
  replyTo: { type: 'objectId', label: 'Ответ' },
}), async (req, res) => {
  const { recipientId, content } = req.body;
  if (!limits.OPTIONS.includes(req.body.limit)) return res.status(400).json({ message: 'Неверное ограничение' });
  const me = req.session.userId;
  if (await refuseRestricted(res, me, recipientId)) return;

  const [conversation, sender, recipient] = await Promise.all([
    findConversation(me, recipientId),
    User.findById(me).select('nickname login email avatar role').lean(),
    User.findById(recipientId).select('nickname login email avatar role').lean(),
  ]);
  if (!conversation || !sender || !recipient) {
    return res.status(404).json({ message: 'Диалог не найден' });
  }
  if (!(await gate(res, conversation, me, recipientId))) return;

  try {
    const reply = await replyOf(conversation, req.body.replyTo);
    res.json(await deliver(req, { conversation, sender, recipient, content, limit: limits.parse(req.body.limit, 'text'), reply }));
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
  const replyTo = req.body.replyTo || undefined;
  // В группу (routes/groups.js) — groupId вместо собеседника.
  const groupId = req.body.groupId || undefined;
  const me = req.session.userId;

  if (!file) return res.status(400).json({ message: 'Файл не пришёл' });
  const target = groupId !== undefined
    ? typeof groupId === 'string' && ObjectId.isValid(groupId)
    : typeof recipientId === 'string' && ObjectId.isValid(recipientId);
  if (!target || content.length > 5000 || !limits.OPTIONS.includes(option)
    || (replyTo !== undefined && (typeof replyTo !== 'string' || !ObjectId.isValid(replyTo)))) {
    drop();
    return res.status(400).json({ message: 'Неверный запрос' });
  }
  if (groupId && option) {
    drop();
    return res.status(400).json({ message: 'В группах нет исчезающих сообщений' });
  }
  if (!attachments.enabled) {
    drop();
    return res.status(503).json({ message: 'Файлы сейчас не принимаются' });
  }
  if (!groupId && await restriction.between(me, recipientId)) {
    drop();
    return refuseRestricted(res, me, recipientId);
  }

  // conversation — диалог двоих или группа: у обеих _id, по нему ключи
  // файлов в хранилище и поиск сообщения, на которое отвечают.
  const [conversation, sender, recipient] = await Promise.all([
    groupId ? groups.forMember(groupId, me) : findConversation(me, recipientId),
    User.findById(me).select('nickname login email avatar role').lean(),
    groupId ? null : User.findById(recipientId).select('nickname login email avatar role').lean(),
  ]);
  if (!conversation || !sender || (!groupId && !recipient)) {
    drop();
    return res.status(404).json({ message: groupId ? 'Группа не найдена' : 'Диалог не найден' });
  }
  if (!groupId && !(await gate(res, conversation, me, recipientId))) {
    drop();
    return;
  }
  const post = (fields) => (groupId
    ? groups.deliver(req, conversation, sender, fields)
    : deliver(req, { conversation, sender, recipient, ...fields }));

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
    result, targetType: groupId ? 'group' : 'user', targetId: groupId ? conversation._id : recipient._id,
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
  // Ответ — на первом из ушедших: на подписи, если она идёт отдельно.
  const limit = limits.parse(option, info.kind);
  let reply = await replyOf(conversation, replyTo);
  if (limit && content) {
    await post({ content, reply });
    reply = null;
  }
  const send = async () => {
    const stored = await attachments.store(info, conversation._id);
    return post({ content: limit ? '' : content, attachments: [stored], ref, limit, reply });
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
  recipientIds: { type: 'array', default: [], max: 20, of: { type: 'objectId' }, label: 'Кому' },
  // Группы, где пересылающий состоит (routes/groups.js).
  groupIds: { type: 'array', default: [], max: 20, of: { type: 'objectId' }, label: 'Кому' },
  comment: { type: 'string', max: 5000, default: '', label: 'Комментарий' },
}), async (req, res) => {
  const me = String(req.session.userId);
  const { comment } = req.body;
  const chosen = [...new Set(req.body.recipientIds)].filter((id) => id !== me);
  const [targetGroups, myGroups] = await Promise.all([
    req.body.groupIds.length ? Group.find({ _id: { $in: req.body.groupIds }, 'members.user': me }) : [],
    Group.find({ 'members.user': me }).select('_id').lean(),
  ]);
  if (!chosen.length && !targetGroups.length) {
    return res.status(400).json({ message: 'Выберите, кому переслать' });
  }
  // Тем, с кем стоит ограничение доступа, не пересылается (utils/restrict.js).
  const barred = await Promise.all(chosen.map((id) => restriction.between(me, id)));
  const recipientIds = chosen.filter((id, i) => !barred[i]);
  if (!recipientIds.length && !targetGroups.length) {
    return res.status(403).json({ restricted: barred[0], message: restriction.BLOCKED[barred[0]] });
  }

  // Порядок — как в переписке, по времени, а не как их выделяли.
  // Сообщение с ограничением не пересылается: иначе его копия жила бы
  // без ограничения.
  const originals = await Message.find({
    _id: { $in: [...new Set(req.body.messageIds)] },
    $or: [{ sender: me }, { recipient: me }, { conversationId: { $in: myGroups.map((g) => g._id) } }],
    system: { $exists: false },
    deletedFor: { $ne: me },
    'limit.mode': { $exists: false },
  }).sort({ sentAt: 1 }).lean();
  if (!originals.length) {
    return res.status(404).json({ message: 'Сообщение не найдено' });
  }

  const [sender, recipients] = await Promise.all([
    User.findById(me).select('nickname login email avatar role').lean(),
    User.find({ _id: { $in: recipientIds } }).select('nickname login email avatar role').lean(),
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
  let closed = null;
  for (const recipient of recipients) {
    // Закрытая личка (utils/privacy.js) — мимо, как и ограничение выше.
    const g = await privacy.messageGate(await findConversation(me, recipient._id), me, recipient._id);
    if (!g.ok) { closed = closed || g; continue; }
    const conversation = await openConversation(me, recipient._id);
    if (g.request && !conversation.requestFor) conversation.requestFor = recipient._id;
    if (g.accept) conversation.requestFor = undefined;
    // Пуш — один на всю пересылку, с последним сообщением пачки.
    if (comment) sent.push(await deliver(req, { conversation, sender, recipient, content: comment, silent: batch.length > 0 }));
    for (let i = 0; i < batch.length; i++) {
      sent.push(await deliver(req, { conversation, sender, recipient, ...batch[i], silent: i < batch.length - 1 }));
    }
  }
  // Не ушло никому — личка закрыта у всех: отказ с причиной, а не «успех».
  if (!sent.length && !targetGroups.length && closed) {
    return res.status(403).json({ privacy: closed.rule, message: closed.message });
  }
  for (const group of targetGroups) {
    if (comment) sent.push(await groups.deliver(req, group, sender, { content: comment, silent: batch.length > 0 }));
    for (let i = 0; i < batch.length; i++) sent.push(await groups.deliver(req, group, sender, { ...batch[i], silent: i < batch.length - 1 }));
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
  // Заявку можно читать, но отправитель об этом не узнает, пока её не
  // приняли (utils/privacy.js): «прочитано» — уже ответ ему.
  if (conversation && String(conversation.requestFor) !== String(me)) {
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
    groups.unreadTotal(me),
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
  // его у собеседника (в Telegram его тоже уже не достать). Сообщения
  // групп — отдельно (deleteInGroups): у них нет получателя.
  const [messages, inGroups] = await Promise.all([
    Message.find({ _id: { $in: ids }, recipient: { $ne: null }, $or: [{ sender: me }, { recipient: me }], deletedFor: { $ne: me } })
      .select('sender recipient')
      .lean(),
    deleteInGroups(req, me, ids, forAll),
  ]);
  if (!messages.length) return res.json({ success: true, deleted: inGroups });
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

  res.json({ success: true, deleted: messages.length + inGroups });
});

// Сообщения групп, где я состою. «У всех» — своё, а администратору
// и создателю — любое; чужое без таких прав уходит только у меня, как
// и просили бы «у меня». Остальным участникам — событие с id: счётчики
// они сверяют сами (/api/badge). Сколько удалено — в ответ.
async function deleteInGroups(req, me, ids, forAll) {
  const list = await Message.find({ _id: { $in: ids }, recipient: null, deletedFor: { $ne: me } }).select('sender conversationId').lean();
  if (!list.length) return 0;
  const mine = await Group.find({ _id: { $in: [...new Set(list.map((m) => String(m.conversationId)))] }, 'members.user': me });
  const byId = new Map(mine.map((g) => [String(g._id), g]));
  const visible = list.filter((m) => byId.has(String(m.conversationId)));
  const forEveryone = forAll ? visible.filter((m) => String(m.sender) === me || groups.canManage(groups.roleOf(byId.get(String(m.conversationId)), me))) : [];
  const justMine = visible.filter((m) => !forEveryone.includes(m));

  if (forEveryone.length) {
    await attachments.deleteMessages({ _id: { $in: forEveryone.map((m) => m._id) } });
    for (const g of mine) {
      const gone = forEveryone.filter((m) => String(m.conversationId) === String(g._id)).map((m) => String(m._id));
      if (gone.length) groups.emit(io(req), g, 'message:deleted', { ids: gone, groupId: String(g._id) });
    }
  }
  if (justMine.length) {
    await Message.updateMany({ _id: { $in: justMine.map((m) => m._id) } }, { $addToSet: { deletedFor: me } });
    if (io(req)) io(req).to(`user:${me}`).emit('message:deleted', { ids: justMine.map((m) => String(m._id)), unreadMessages: await groups.unreadTotal(me) });
  }
  return visible.length;
}


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
// Доставка личной переписки нужна и поддержке (utils/support.js): рассылка
// и ответы из панели — те же сообщения, что пишут люди.
router.openConversation = openConversation;
router.findConversation = findConversation;
router.deliver = deliver;
