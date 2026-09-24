// Групповые чаты (решение 24.09.2026): создание, участники и роли, ссылка-
// приглашение, выход и удаление, история, отправка, прочтение.
// Правила — utils/groups.js. Вложения в группу — /messages/attach с groupId,
// пересылка в группу — /messages/forward с groupIds, удаление сообщений —
// /messages/delete (routes/streaming/messages.js): там общий код с личной
// перепиской.
//
// Кто что может: создатель (owner) — всё, в том числе назначать
// администраторов и удалять группу; администратор — участники, название,
// фото, ссылка; участник — писать и выйти. До 100 человек в группе.
// Исчезающих сообщений в группах нет (решение 24.09).

const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router);
const { requireAuth, requireAuthApi, requireNotBanned } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const Group = require('../models/Group');
const Message = require('../models/Message');
const User = require('../models/User');
const groups = require('../utils/groups');
const restriction = require('../utils/restrict');
const privacy = require('../utils/privacy');
const turn = require('../utils/turn');
const attachments = require('../utils/attachments');
const { viewAll, QUOTED } = require('../utils/messageView');
const { audit } = require('../utils/audit');
const { saveImage, BadImageError } = require('../utils/image');
const { uploadAvatar } = require('./streaming/uploads');

const PAGE = 15;
const io = (req) => req.app.get('io');
const me = (req) => String(req.session.userId);

// Группа, где спрашивающий состоит, иначе 404 — ответ уже отправлен.
async function mine(req, res) {
  const group = await groups.forMember(req.params.id, req.session.userId);
  if (!group) res.status(404).json({ message: 'Группа не найдена' });
  return group;
}

// Нужна роль не ниже администратора — иначе 403, ответ отправлен.
function refuseUnlessManager(res, group, userId) {
  if (groups.canManage(groups.roleOf(group, userId))) return false;
  res.status(403).json({ message: 'Это могут только администраторы группы' });
  return true;
}

const actorOf = (req) => User.findById(req.session.userId).select(groups.PEOPLE).lean();

// Кого можно добавить: существующие, ещё не в группе, не ограничившие того,
// кто добавляет (utils/restrict.js — «добавить того, кто вас ограничил,
// нельзя»). Ответ — люди в порядке запроса.
// Кто запретил добавлять себя в группы (utils/privacy.js), тоже не
// добавляется — считается в closed: ему можно отправить ссылку-приглашение.
async function addable(group, adderId, ids) {
  const fresh = [...new Set(ids)].filter((id) => id !== String(adderId) && !groups.memberOf(group, id));
  const users = await User.find({ _id: { $in: fresh } }).select(groups.PEOPLE).lean();
  const [barred, rules] = await Promise.all([
    Promise.all(users.map((u) => restriction.isRestricted(u._id, adderId))),
    Promise.all(users.map((u) => privacy.decide('groups', u._id, adderId))),
  ]);
  const people = users.filter((u, i) => !barred[i] && rules[i].ok);
  people.closed = users.filter((u, i) => !barred[i] && !rules[i].ok).length;
  return people;
}

// ── Создание ─────────────────────────────────────────────────────────────────
router.post('/api/groups', requireAuthApi, requireNotBanned, validate({
  title: { type: 'string', required: true, max: groups.TITLE_MAX, label: 'Название' },
  memberIds: { type: 'array', default: [], max: groups.MAX_MEMBERS - 1, of: { type: 'objectId' }, label: 'Участники' },
}), async (req, res) => {
  const actor = await actorOf(req);
  if (!actor) return res.status(401).json({ message: 'Необходима авторизация' });
  const group = new Group({ title: req.body.title, members: [{ user: actor._id, role: 'owner' }] });
  const people = await addable(group, actor._id, req.body.memberIds);
  people.forEach((u) => group.members.push({ user: u._id, role: 'member', addedBy: actor._id }));
  await group.save();

  await groups.note(req, group, actor, 'created', { text: group.title });
  audit(req, 'group.create', { targetType: 'group', targetId: group._id, targetLabel: group.title, meta: { members: group.members.length } });
  res.json({ group: await groups.info(group, actor._id), skipped: req.body.memberIds.length - people.length, closed: people.closed });
});

// ── Экран группы ─────────────────────────────────────────────────────────────
router.get('/api/groups/:id', requireAuthApi, async (req, res) => {
  const group = await mine(req, res);
  if (group) res.json({ group: await groups.info(group, me(req)) });
});

router.post('/api/groups/:id/title', requireAuthApi, requireNotBanned, validate({
  title: { type: 'string', required: true, max: groups.TITLE_MAX, label: 'Название' },
}), async (req, res) => {
  const group = await mine(req, res);
  if (!group || refuseUnlessManager(res, group, me(req))) return;
  if (group.title === req.body.title) return res.json({ group: await groups.info(group, me(req)) });
  group.title = req.body.title;
  await group.save();
  await groups.note(req, group, await actorOf(req), 'title', { text: group.title });
  groups.emit(io(req), group, 'group:updated', { group: groups.brief(group) });
  res.json({ group: await groups.info(group, me(req)) });
});

// Фото: как аватар человека — сжатое, на своём сервере. Без файла — убрать.
router.post('/api/groups/:id/photo', requireAuthApi, requireNotBanned, uploadAvatar.single('photo'), async (req, res) => {
  const group = await mine(req, res);
  if (!group || refuseUnlessManager(res, group, me(req))) return;
  const old = group.avatar;
  if (req.file) {
    let name;
    try {
      name = await saveImage(req.file.buffer, 'avatar', groups.PHOTOS);
    } catch (e) {
      if (!(e instanceof BadImageError)) throw e;
      return res.status(400).json({ message: e.message });
    }
    group.avatar = `/uploads/groups/${name}`;
  } else {
    group.avatar = '';
  }
  await group.save();
  groups.removePhoto(old);
  if (req.file) await groups.note(req, group, await actorOf(req), 'photo');
  groups.emit(io(req), group, 'group:updated', { group: groups.brief(group) });
  res.json({ group: await groups.info(group, me(req)) });
});

// ── Участники ────────────────────────────────────────────────────────────────
router.post('/api/groups/:id/members/add', requireAuthApi, requireNotBanned, validate({
  userIds: { type: 'array', required: true, max: groups.MAX_MEMBERS, of: { type: 'objectId' }, label: 'Участники' },
}), async (req, res) => {
  const group = await mine(req, res);
  if (!group || refuseUnlessManager(res, group, me(req))) return;
  const people = await addable(group, me(req), req.body.userIds);
  if (group.members.length + people.length > groups.MAX_MEMBERS) {
    return res.status(409).json({ message: 'В группе не больше 100 участников' });
  }
  const actor = await actorOf(req);
  people.forEach((u) => group.members.push({ user: u._id, role: 'member', addedBy: actor._id }));
  await group.save();
  for (const u of people) await groups.note(req, group, actor, 'added', { target: u });
  groups.emit(io(req), group, 'group:updated', { group: groups.brief(group) });
  res.json({ group: await groups.info(group, me(req)), added: people.length, skipped: req.body.userIds.length - people.length, closed: people.closed });
});

// Удалить участника: администратор — рядовых, создатель — любого, кроме себя.
router.post('/api/groups/:id/members/remove', requireAuthApi, validate({
  userId: { type: 'objectId', required: true, label: 'Участник' },
}), async (req, res) => {
  const group = await mine(req, res);
  if (!group || refuseUnlessManager(res, group, me(req))) return;
  const target = groups.memberOf(group, req.body.userId);
  if (!target) return res.status(404).json({ message: 'Такого участника в группе нет' });
  const myRole = groups.roleOf(group, me(req));
  if (target.role === 'owner' || (target.role === 'admin' && myRole !== 'owner')) {
    return res.status(403).json({ message: 'Удалить администратора может только создатель группы' });
  }
  const [actor, user] = await Promise.all([actorOf(req), User.findById(req.body.userId).select(groups.PEOPLE).lean()]);
  group.members = group.members.filter((m) => String(m.user) !== req.body.userId);
  await group.save();
  // Удалённому — отдельно: в рассылку группы он уже не попадает.
  if (io(req)) io(req).to('user:' + req.body.userId).emit('group:removed', { groupId: String(group._id), reason: 'removed' });
  await groups.note(req, group, actor, 'removed', { target: user || { _id: req.body.userId } });
  groups.emit(io(req), group, 'group:updated', { group: groups.brief(group) });
  res.json({ group: await groups.info(group, me(req)) });
});

// Роль: назначает только создатель. owner — передать группу: прежний
// создатель становится администратором.
router.post('/api/groups/:id/members/role', requireAuthApi, requireNotBanned, validate({
  userId: { type: 'objectId', required: true, label: 'Участник' },
  role: { type: 'string', required: true, values: ['admin', 'member', 'owner'], label: 'Роль' },
}), async (req, res) => {
  const group = await mine(req, res);
  if (!group) return;
  if (groups.roleOf(group, me(req)) !== 'owner') return res.status(403).json({ message: 'Роли назначает создатель группы' });
  const target = groups.memberOf(group, req.body.userId);
  if (!target || req.body.userId === me(req)) return res.status(404).json({ message: 'Такого участника в группе нет' });
  if (target.role === req.body.role) return res.json({ group: await groups.info(group, me(req)) });
  target.role = req.body.role;
  if (req.body.role === 'owner') groups.memberOf(group, me(req)).role = 'admin';
  await group.save();
  const user = await User.findById(req.body.userId).select(groups.PEOPLE).lean();
  const kind = { admin: 'admin', member: 'unadmin', owner: 'owner' }[req.body.role];
  await groups.note(req, group, await actorOf(req), kind, { target: user || { _id: req.body.userId } });
  groups.emit(io(req), group, 'group:updated', { group: groups.brief(group) });
  res.json({ group: await groups.info(group, me(req)) });
});

// Выйти. Уходит создатель — группа переходит старейшему администратору,
// иначе старейшему участнику; последний ушёл — группы больше нет.
router.post('/api/groups/:id/leave', requireAuthApi, async (req, res) => {
  const group = await mine(req, res);
  if (!group) return;
  const actor = await actorOf(req);
  const was = groups.memberOf(group, me(req));
  if (was.role === 'owner') {
    const next = groups.successor(group);
    if (next) next.role = 'owner';
  }
  group.members = group.members.filter((m) => String(m.user) !== me(req));
  if (io(req)) io(req).to('user:' + me(req)).emit('group:removed', { groupId: String(group._id), reason: 'left' });
  if (!group.members.length) {
    await attachments.deleteMessages({ conversationId: group._id });
    await group.deleteOne();
    groups.removePhoto(group.avatar);
    return res.json({ success: true, deleted: true });
  }
  await group.save();
  await groups.note(req, group, actor, 'left');
  const heir = group.members.find((m) => m.role === 'owner');
  if (was.role === 'owner' && heir) {
    const user = await User.findById(heir.user).select(groups.PEOPLE).lean();
    if (user) await groups.note(req, group, user, 'owner', { target: user });
  }
  groups.emit(io(req), group, 'group:updated', { group: groups.brief(group) });
  res.json({ success: true });
});

// Удалить группу целиком — только создатель. Сообщения и файлы — вместе с ней.
router.post('/api/groups/:id/delete', requireAuthApi, async (req, res) => {
  const group = await mine(req, res);
  if (!group) return;
  if (groups.roleOf(group, me(req)) !== 'owner') return res.status(403).json({ message: 'Удалить группу может только создатель' });
  await attachments.deleteMessages({ conversationId: group._id });
  await group.deleteOne();
  groups.removePhoto(group.avatar);
  groups.emit(io(req), group, 'group:removed', { groupId: String(group._id), reason: 'deleted' });
  audit(req, 'group.delete', { targetType: 'group', targetId: group._id, targetLabel: group.title, meta: { members: group.members.length } });
  res.json({ success: true });
});

// Без звука: until — до какого времени, null — снова со звуком.
router.post('/api/groups/:id/mute', requireAuthApi, validate({
  hours: { type: 'int', required: true, min: 0, max: 24 * 365, label: 'Срок' },
}), async (req, res) => {
  const group = await mine(req, res);
  if (!group) return;
  const until = req.body.hours ? new Date(Date.now() + req.body.hours * 3600e3) : null;
  await Group.updateOne({ _id: group._id }, { $set: { 'members.$[me].mutedUntil': until } }, { arrayFilters: [{ 'me.user': req.session.userId }] });
  res.json({ muted: !!until, until });
});

// ── Ссылка-приглашение ───────────────────────────────────────────────────────
// on: true — новая ссылка (прежняя перестаёт работать), false — выключить.
router.post('/api/groups/:id/invite', requireAuthApi, requireNotBanned, validate({
  on: { type: 'bool', required: true, label: 'Ссылка' },
}), async (req, res) => {
  const group = await mine(req, res);
  if (!group || refuseUnlessManager(res, group, me(req))) return;
  group.invite = req.body.on ? groups.inviteCode() : null;
  await group.save();
  res.json({ invite: group.invite });
});

// Ссылка-приглашение: гостю — вход с возвратом сюда же (requireAuth),
// вошедшему — переписка с экраном вступления (public/tk-groups.js, join).
router.get('/g/:code', requireAuth, (req, res) => {
  if (!/^[\w-]{12}$/.test(req.params.code)) return res.redirect('/chatsPage');
  res.redirect('/chatsPage?join=' + req.params.code);
});

// Что за группа по ссылке — для страницы вступления.
router.get('/api/groups/invite/:code', requireAuthApi, async (req, res) => {
  const group = typeof req.params.code === 'string' && /^[\w-]{12}$/.test(req.params.code) ? await Group.findOne({ invite: req.params.code }) : null;
  if (!group) return res.status(404).json({ message: 'Ссылка не работает: её выключили или перевыпустили' });
  res.json({ group: groups.brief(group), member: !!groups.memberOf(group, me(req)) });
});

// Вступить по ссылке — сразу, без одобрения (решение 24.09).
router.post('/api/groups/join', requireAuthApi, requireNotBanned, validate({
  code: { type: 'string', required: true, max: 20, pattern: /^[\w-]{12}$/, label: 'Ссылка' },
}), async (req, res) => {
  const group = await Group.findOne({ invite: req.body.code });
  if (!group) return res.status(404).json({ message: 'Ссылка не работает: её выключили или перевыпустили' });
  if (groups.memberOf(group, me(req))) return res.json({ groupId: String(group._id) });
  if (group.members.length >= groups.MAX_MEMBERS) return res.status(409).json({ message: 'В группе не больше 100 участников' });
  const actor = await actorOf(req);
  group.members.push({ user: actor._id, role: 'member' });
  await group.save();
  await groups.note(req, group, actor, 'joined');
  groups.emit(io(req), group, 'group:updated', { group: groups.brief(group) });
  res.json({ groupId: String(group._id) });
});

// ── Переписка ────────────────────────────────────────────────────────────────
// История страницами по PAGE от конца, как у личной. people — авторы
// страницы (и тех, кто уже вышел), seenUntil — докуда дочитал хоть кто-то
// из остальных: до этого места свои сообщения «прочитаны».
router.get('/api/groups/:id/messages', requireAuthApi, async (req, res) => {
  const group = await mine(req, res);
  if (!group) return;
  const before = req.query.before ? new Date(req.query.before) : null;
  if (before && isNaN(before)) return res.status(400).json({ message: 'Неверный запрос' });
  const list = await Message.find({
    conversationId: group._id,
    deletedFor: { $ne: req.session.userId },
    ...(before ? { sentAt: { $lt: before } } : {}),
  }).sort({ sentAt: -1 }).limit(PAGE).lean();
  const authors = await User.find({ _id: { $in: [...new Set(list.map((m) => String(m.sender)))] } }).select(groups.PEOPLE).lean();
  const others = group.members.filter((m) => String(m.user) !== me(req)).map((m) => m.readAt);
  res.json({
    messages: await viewAll(list.reverse()),
    people: Object.fromEntries(authors.map((u) => [String(u._id), groups.person(u)])),
    seenUntil: others.length ? new Date(Math.max(...others)) : null,
    group: await groups.info(group, me(req)),
  });
});

// Тридцать сообщений в минуту с человека — как в личной переписке.
const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => String(req.session.userId),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Слишком много сообщений. Подождите минуту.' },
});

router.post('/api/groups/:id/send', requireAuthApi, requireNotBanned, sendLimiter, validate({
  content: { type: 'string', required: true, min: 1, max: 5000, label: 'Сообщение' },
  replyTo: { type: 'objectId', label: 'Ответ' },
}), async (req, res) => {
  const group = await mine(req, res);
  if (!group) return;
  const [sender, reply] = await Promise.all([
    actorOf(req),
    req.body.replyTo ? Message.findOne({ _id: req.body.replyTo, conversationId: group._id }).select(QUOTED).lean() : null,
  ]);
  res.json(await groups.deliver(req, group, sender, { content: req.body.content, reply }));
});

// Открыл группу — прочитано до сейчас. Остальным — докуда дочитал: у авторов
// загораются «прочитано».
router.post('/api/groups/:id/read', requireAuthApi, async (req, res) => {
  const group = await mine(req, res);
  if (!group) return;
  const at = new Date();
  await Group.updateOne({ _id: group._id }, { $set: { 'members.$[me].readAt': at } }, { arrayFilters: [{ 'me.user': req.session.userId }] });
  groups.emit(io(req), group, 'group:read', { groupId: String(group._id), userId: me(req), at });
  res.json({ success: true, unreadMessages: await groups.unreadTotal(req.session.userId) });
});

// ── Звонок группе ────────────────────────────────────────────────────────────
// Звонит всем участникам, кто сейчас в сети. Разговор — сеткой через свой
// сервер (sockets/index.js, до четырёх вместе со звонящим): первый ответивший
// начинает разговор, остальные остаются приглашёнными и входят, пока есть
// место. В ленте группы — строка «начал(а) звонок»: её видят и те, кого не было.
const callLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: (req) => String(req.session.userId),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Слишком много звонков. Подождите минуту.' },
});

router.post('/api/groups/:id/call', requireAuthApi, requireNotBanned, callLimiter, validate({
  type: { type: 'string', required: true, values: ['audio', 'video'], label: 'Тип звонка' },
}), async (req, res) => {
  const group = await mine(req, res);
  if (!group) return;
  if (!turn.configured()) return res.status(503).json({ message: 'Звонки в группах сейчас недоступны' });
  const rooms = req.app.get('userRooms');
  const pendingCalls = req.app.get('pendingCalls');
  const caller = me(req);
  const online = group.members.map((m) => String(m.user)).filter((id) => id !== caller && rooms && rooms.has(id));
  // С кем стоит ограничение доступа — тому не звоним (utils/restrict.js).
  // И тому, кто не принимает звонки от звонящего (utils/privacy.js).
  const [barred, rules] = await Promise.all([
    Promise.all(online.map((id) => restriction.between(caller, id))),
    Promise.all(online.map((id) => privacy.decide('calls', id, caller))),
  ]);
  const callees = online.filter((id, i) => !barred[i] && rules[i].ok);
  if (!callees.length || !pendingCalls) return res.status(409).json({ message: 'Сейчас никого из группы нет в сети' });

  const callId = crypto.randomUUID();
  pendingCalls.set(callId, { callerId: caller, calleeIds: new Set(callees), groupId: String(group._id), type: req.body.type, own: true, createdAt: Date.now() });
  const actor = await actorOf(req);
  const from = { userId: caller, displayName: groups.person(actor).displayName, avatarUrl: actor.avatar || null };
  io(req).to(callees.map((id) => 'user:' + id)).emit('incoming_call', {
    callId, type: req.body.type, group: true, from, peers: [from], chat: { id: String(group._id), title: group.title },
  });
  // Никто не ответил за полминуты — у всех гаснет.
  setTimeout(() => {
    const call = pendingCalls.get(callId);
    if (!call) return;
    pendingCalls.delete(callId);
    io(req).to(['user:' + caller, ...[...call.calleeIds].map((id) => 'user:' + id)]).emit('call:timeout', { callId });
  }, 30000).unref();
  await groups.note(req, group, actor, 'call');
  res.json({ success: true, callId, ringing: callees.length });
});

module.exports = router;
