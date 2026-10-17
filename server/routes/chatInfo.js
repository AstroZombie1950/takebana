// Панель диалога (17.10): что показать о собеседнике, вкладки медиа,
// файлов, голосовых и публикаций, поиск по переписке, закреплённое
// сообщение, «без звука». Правила выдачи — utils/chatInfo.js, страница —
// public/tk-chatinfo.js.
//
// Чей диалог — ?peer=<id> (личный) или ?group=<id>; в теле POST — peerId
// или groupId. Чужой диалог не отличить от несуществующего: 404.

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router);
const { requireAuthApi } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const Conversation = require('../models/Conversation');
const Contact = require('../models/Contact');
const Group = require('../models/Group');
const User = require('../models/User');
const chatInfo = require('../utils/chatInfo');
const groups = require('../utils/groups');
const userView = require('../utils/userView');
const privacy = require('../utils/privacy');
const restriction = require('../utils/restrict');
const { profileUrl } = require('../utils/profileUrl');
const { audit } = require('../utils/audit');
const contactNames = require('../utils/contactNames');

const ID = /^[a-f\d]{24}$/i;
const io = (req) => req.app.get('io');
const me = (req) => String(req.session.userId);

function conversationOf(a, b) {
  return Conversation.findOne({ $or: [{ userOne: a, userTwo: b }, { userOne: b, userTwo: a }] });
}

// Диалог из запроса: { conversation, peerId } или { group }. Иначе ответ
// уже отправлен и вернётся null.
async function chatOf(req, res, src) {
  const peerId = src.peer || src.peerId;
  const groupId = src.group || src.groupId;
  const bad = () => { res.status(400).json({ message: 'Неверный запрос' }); return null; };
  if (!!peerId === !!groupId) return bad();
  if (groupId) {
    if (typeof groupId !== 'string' || !ID.test(groupId)) return bad();
    const group = await groups.forMember(groupId, req.session.userId);
    if (!group) { res.status(404).json({ message: 'Группа не найдена' }); return null; }
    return { group, id: group._id };
  }
  if (typeof peerId !== 'string' || !ID.test(peerId)) return bad();
  const conversation = await conversationOf(req.session.userId, peerId);
  if (!conversation) { res.status(404).json({ message: 'Диалог не найден' }); return null; }
  return { conversation, peerId, id: conversation._id };
}

// Авторы найденного в группе — с моими именами для них: история старше
// загруженной ленты, и в people страницы их может не быть.
async function peopleOf(chat, me, rows) {
  if (!chat.group || !rows.length) return undefined;
  const users = await User.find({ _id: { $in: [...new Set(rows.map((r) => r.sender))] } }).select(groups.PEOPLE).lean();
  const list = await contactNames.applyAll(me, users.map(groups.person));
  return Object.fromEntries(list.map((p) => [p.id, p]));
}

const time = (v) => {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return isNaN(d) ? undefined : d;
};

// ── О собеседнике ──────────────────────────────────────────────────────────
// Шапка панели и её список: своё имя и ник, описание целиком (до 300 знаков,
// страница показывает одну строку и раскрывает по нажатию), записан ли,
// без звука ли, общие группы, ограничение доступа.
router.get('/api/chat/peer/:id', requireAuthApi, async (req, res) => {
  const id = req.params.id;
  if (!ID.test(id) || id === me(req)) return res.status(400).json({ message: 'Неверный запрос' });
  const [user, contact, conversation, common, restricted] = await Promise.all([
    User.findById(id).select('nickname login email avatar bio role isOnline lastSeen').lean(),
    Contact.findOne({ owner: me(req), peer: id }).select('favorite name').lean(),
    conversationOf(req.session.userId, id).select('muted').lean(),
    Group.find({ 'members.user': { $all: [req.session.userId, id] } })
      .sort({ lastUpdated: -1 }).limit(20).select('title avatar members.user').lean(),
    restriction.between(me(req), id),
  ]);
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
  // «В сети» и «был» — только тем, кому человек их показывает.
  await privacy.maskPresence(me(req), [user]);
  const nick = userView.displayName(user);
  const name = (contact && contact.name) || '';
  res.json({
    peer: {
      id,
      displayName: name || nick,
      nickname: user.nickname || '',
      name,
      avatarStyle: userView.avatarStyle(user, name || nick),
      bio: String(user.bio || '').trim(),
      url: profileUrl(user),
      isOnline: !!user.isOnline,
      lastSeen: user.lastSeen || null,
      ...(privacy.isOfficial(user) ? { official: true } : {}),
    },
    contact: contact ? { favorite: !!contact.favorite } : null,
    muted: chatInfo.mutedUntil(conversation, me(req)),
    groups: common.map(groups.brief),
    restricted,
  });
});

// ── Вкладки ────────────────────────────────────────────────────────────────
router.get('/api/chat/tab', requireAuthApi, async (req, res) => {
  const name = req.query.tab;
  const before = time(req.query.before);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, chatInfo.QUERY_MAX) : '';
  if (typeof name !== 'string' || !Object.hasOwn(chatInfo.TAB_PAGE, name) || before === undefined) return res.status(400).json({ message: 'Неверный запрос' });
  const chat = await chatOf(req, res, req.query);
  if (!chat) return;
  try {
    const out = await chatInfo.tab(chat.id, req.session.userId, name, { before, q });
    res.json({ ...out, people: await peopleOf(chat, me(req), out.items) });
  } catch (e) {
    // Удачу вкладки не пишем — их листают; отказ пишем всегда.
    audit(req, 'chat.tab', { result: 'fail', targetType: chat.group ? 'group' : 'user', targetId: chat.group ? chat.id : chat.peerId,
      meta: { tab: name, q: q.length, error: e.message } });
    throw e;
  }
});

// ── Поиск ──────────────────────────────────────────────────────────────────
// Поиск просматривает переписку целиком — потолок на человека, чтобы
// скрипт не гонял его без конца.
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  keyGenerator: (req) => String(req.session.userId),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Слишком много поисков. Подождите минуту.' },
});

router.get('/api/chat/search', requireAuthApi, searchLimiter, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const before = time(req.query.before);
  if (!q || q.length > chatInfo.QUERY_MAX || before === undefined) return res.status(400).json({ message: 'Неверный запрос' });
  const chat = await chatOf(req, res, req.query);
  if (!chat) return;
  const startedAt = Date.now();
  const target = { targetType: chat.group ? 'group' : 'user', targetId: chat.group ? chat.id : chat.peerId };
  try {
    const out = await chatInfo.search(chat.id, req.session.userId, q, before);
    // Первая страница — в журнал: сколько нашлось и сколько шло. Текст
    // запроса не пишем — это чужая переписка.
    if (!before) audit(req, 'chat.search', { ...target, meta: { len: q.length, hits: out.hits.length, more: !!out.before, ms: Date.now() - startedAt } });
    res.json({ ...out, people: await peopleOf(chat, me(req), out.hits) });
  } catch (e) {
    const slow = e.code === 50 || e.codeName === 'MaxTimeMSExpired';
    audit(req, 'chat.search', { result: 'fail', ...target, meta: { len: q.length, ms: Date.now() - startedAt, error: slow ? 'timeout' : e.message } });
    if (slow) return res.status(503).json({ message: 'Поиск занял слишком много времени — уточните запрос' });
    throw e;
  }
});

// ── Закреплённое ───────────────────────────────────────────────────────────
// messageId — закрепить (прежнее снимается), без него — открепить. В личном
// диалоге — любой из двоих, в группе — администраторы. Полоса меняется
// у всех сразу (chat:pinned): у двоих — с id собеседника каждого.
router.post('/api/chat/pin', requireAuthApi, validate({
  peerId: { type: 'objectId', label: 'Собеседник' },
  groupId: { type: 'objectId', label: 'Группа' },
  messageId: { type: 'objectId', label: 'Сообщение' },
}), async (req, res) => {
  const chat = await chatOf(req, res, req.body);
  if (!chat) return;
  const userId = req.session.userId;
  if (chat.group && !groups.canManage(groups.roleOf(chat.group, userId))) {
    return res.status(403).json({ message: 'Это могут только администраторы группы' });
  }
  const { messageId } = req.body;
  const target = { targetType: chat.group ? 'group' : 'user', targetId: chat.group ? chat.id : chat.peerId };
  let pinned = null;
  if (messageId) {
    const m = await chatInfo.pinnable(chat.id, userId, messageId);
    if (!m) {
      audit(req, 'chat.pin', { result: 'fail', ...target, meta: { error: 'not pinnable' } });
      return res.status(404).json({ message: 'Это сообщение нельзя закрепить' });
    }
    pinned = await chatInfo.pinnedView(chat.id, userId, m._id);
  }
  const Model = chat.group ? Group : Conversation;
  await Model.updateOne({ _id: chat.id }, { $set: { pinned: messageId || null } });
  audit(req, 'chat.pin', { ...target, meta: { on: !!messageId } });

  const socket = io(req);
  if (socket) {
    if (chat.group) groups.emit(socket, chat.group, 'chat:pinned', { groupId: String(chat.id), pinned });
    else {
      socket.to(`user:${me(req)}`).emit('chat:pinned', { peerId: chat.peerId, pinned });
      socket.to(`user:${chat.peerId}`).emit('chat:pinned', { peerId: me(req), pinned });
    }
  }
  res.json({ pinned });
});

// ── Без звука ──────────────────────────────────────────────────────────────
// hours — один из вариантов панели (chatInfo.MUTE_HOURS), 0 — снова со
// звуком. Группа — тем же полем, что и раньше (models/Group.js, mutedUntil).
router.post('/api/chat/mute', requireAuthApi, validate({
  peerId: { type: 'objectId', label: 'Собеседник' },
  groupId: { type: 'objectId', label: 'Группа' },
  hours: { type: 'int', required: true, min: 0, max: 24 * 365, label: 'Срок' },
}), async (req, res) => {
  const { hours } = req.body;
  if (!chatInfo.MUTE_HOURS.includes(hours)) return res.status(400).json({ message: 'Неверный срок' });
  const chat = await chatOf(req, res, req.body);
  if (!chat) return;
  const userId = req.session.userId;
  const until = hours ? new Date(Date.now() + hours * 3600e3) : null;
  if (chat.group) {
    await Group.updateOne({ _id: chat.id }, { $set: { 'members.$[me].mutedUntil': until } }, { arrayFilters: [{ 'me.user': userId }] });
  } else {
    await Conversation.updateOne({ _id: chat.id }, { $pull: { muted: { user: userId } } });
    if (until) await Conversation.updateOne({ _id: chat.id }, { $push: { muted: { user: userId, until } } });
  }
  audit(req, 'chat.mute', { targetType: chat.group ? 'group' : 'user', targetId: chat.group ? chat.id : chat.peerId, meta: { hours } });
  // Другие вкладки этого человека: значок в строке списка.
  const socket = io(req);
  if (socket) socket.to(`user:${me(req)}`).emit('chat:muted', { ...(chat.group ? { groupId: String(chat.id) } : { peerId: chat.peerId }), until });
  res.json({ muted: !!until, until });
});

module.exports = router;
