// Групповые чаты: правила ролей, выдача, доставка сообщений, непрочитанное.
// Модель — models/Group.js, маршруты — routes/groups.js; вложения и
// пересылка в группу — routes/streaming/messages.js через deliver() отсюда.
//
// Сообщения группы рассылаются в комнаты `user:<id>` всех участников одним
// emit: до сотни человек (MAX_MEMBERS) это ничего не стоит.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Group = require('../models/Group');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const User = require('../models/User');
const userView = require('./userView');
const privacy = require('./privacy');
const { view } = require('./messageView');
const { isPlainFileName, resolveWithin } = require('./safePath');

const MAX_MEMBERS = 100;
const TITLE_MAX = 64;
const PEOPLE = 'nickname login email avatar isOnline lastSeen role';

// Фото групп — рядом с аватарами людей, на своём сервере.
const PHOTOS = path.join(__dirname, '..', 'public', 'uploads', 'groups');

function removePhoto(url) {
  const prefix = '/uploads/groups/';
  if (typeof url !== 'string' || !url.startsWith(prefix)) return;
  const name = url.slice(prefix.length);
  const file = isPlainFileName(name) && resolveWithin(PHOTOS, name);
  if (file) fs.unlink(file, () => {});
}

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const same = (a, b) => String(a) === String(b);

function memberOf(group, userId) {
  return group.members.find((m) => same(m.user, userId)) || null;
}
function roleOf(group, userId) {
  const m = memberOf(group, userId);
  return m ? m.role : null;
}
const canManage = (role) => role === 'owner' || role === 'admin';

// Группа, в которой человек состоит. Чужая или несуществующая — null:
// снаружи не отличить «нет такой» от «вы не в ней».
function forMember(groupId, userId) {
  if (!mongoose.isValidObjectId(groupId)) return Promise.resolve(null);
  return Group.findOne({ _id: groupId, 'members.user': userId });
}

function person(user) {
  const displayName = userView.displayName(user);
  return { id: String(user._id), displayName, avatarStyle: userView.avatarStyle(user, displayName), isOnline: !!user.isOnline, ...(privacy.isOfficial(user) ? { official: true } : {}) };
}

// Кратко — для списка диалогов и сокета: фото или градиент с буквой названия.
function brief(group) {
  return {
    id: String(group._id),
    title: group.title,
    avatarStyle: userView.avatarStyle({ _id: group._id, avatar: group.avatar || null }, group.title),
    count: group.members.length,
  };
}

// Для экрана группы: участники с ролями — владелец, администраторы,
// остальные по имени. Код ссылки видят только те, кто ею управляет.
async function info(group, me) {
  const users = await User.find({ _id: { $in: group.members.map((m) => m.user) } }).select(PEOPLE).lean();
  await privacy.maskPresence(me, users);
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const rank = { owner: 0, admin: 1, member: 2 };
  const members = group.members
    .filter((m) => byId.has(String(m.user)))
    .map((m) => ({ ...person(byId.get(String(m.user))), role: m.role }))
    .sort((a, b) => rank[a.role] - rank[b.role] || a.displayName.localeCompare(b.displayName, ['ru', 'en'], { sensitivity: 'base' }));
  const myRole = roleOf(group, me);
  const mine = memberOf(group, me);
  return {
    ...brief(group),
    myRole,
    muted: !!(mine && mine.mutedUntil && mine.mutedUntil > new Date()),
    invite: canManage(myRole) ? group.invite : null,
    members,
  };
}

function rooms(group) {
  return group.members.map((m) => 'user:' + m.user);
}

function emit(io, group, event, payload) {
  if (io) io.to(rooms(group)).emit(event, payload);
}

// Сообщение в группу: сохранить, поднять группу в списках, разослать всем
// участникам. Своё сообщение автор прочитал — его отметка сдвигается.
// fields — как у личного deliver: content, attachments, forwardedFrom,
// reply, ref; или system — служебная строка. silent — без пуша: пересылка
// пачкой будит один раз, с последним сообщением.
async function deliver(req, group, sender, { content = '', attachments: files, forwardedFrom, reply, ref, system, silent }) {
  const now = new Date();
  const message = await Message.create({
    conversationId: group._id,
    sender: sender._id,
    content,
    attachments: files || [],
    sentAt: now,
    forwardedFrom,
    replyTo: reply ? reply._id : null,
    system,
  });
  await Group.updateOne(
    { _id: group._id },
    { $set: { lastMessage: message._id, lastUpdated: now, 'members.$[me].readAt': now } },
    { arrayFilters: [{ 'me.user': sender._id }] },
  );
  const out = view(message, reply);
  // Двумя рассылками: у кого звук выключен, вкладка не пищит и не
  // показывает уведомление (public/tk-app.js), счётчик — растёт.
  const io = req.app.get('io');
  if (io) {
    const payload = { groupId: String(group._id), message: out, sender: person(sender), group: brief(group), ...(ref ? { ref } : {}) };
    const quiet = group.members.filter((m) => m.mutedUntil && m.mutedUntil > now);
    const loud = group.members.filter((m) => !quiet.includes(m));
    if (loud.length) io.to(loud.map((m) => 'user:' + m.user)).emit('group:message', { ...payload, muted: false });
    if (quiet.length) io.to(quiet.map((m) => 'user:' + m.user)).emit('group:message', { ...payload, muted: true });
  }
  if (!silent) require('./groupPush').send(req, group, message, sender);
  return out;
}

// Служебная строка: кто что сделал. Имена — снимком.
function note(req, group, actor, kind, { target, text } = {}) {
  return deliver(req, group, actor, {
    system: {
      kind,
      actor: actor._id,
      actorName: userView.displayName(actor),
      ...(target ? { target: target._id, targetName: userView.displayName(target) } : {}),
      ...(text ? { text } : {}),
    },
  });
}

// Преемник владельца, когда тот уходит: старейший администратор, иначе
// старейший участник. null — в группе никого не осталось.
function successor(group) {
  const rest = group.members.filter((m) => m.role !== 'owner');
  const pick = (list) => list.sort((a, b) => a.joinedAt - b.joinedAt)[0];
  return pick(rest.filter((m) => m.role === 'admin')) || pick(rest) || null;
}

const inviteCode = () => crypto.randomBytes(9).toString('base64url');

// Непрочитанное по группам: всего и по каждой. Служебные строки и свои
// сообщения не считаются; удалённые у себя — тоже.
async function unread(me) {
  const groups = await Group.find({ 'members.user': me }).select({ 'members.$': 1 }).lean();
  const byGroup = {};
  if (!groups.length) return { total: 0, byGroup };
  const rows = await Message.aggregate([
    { $match: {
      $or: groups.map((g) => ({ conversationId: g._id, sentAt: { $gt: g.members[0].readAt } })),
      sender: { $ne: oid(me) },
      system: { $exists: false },
      deletedFor: { $ne: oid(me) },
    } },
    { $group: { _id: '$conversationId', n: { $sum: 1 } } },
  ]);
  let total = 0;
  rows.forEach((r) => { byGroup[String(r._id)] = r.n; total += r.n; });
  return { total, byGroup };
}

// Непрочитанных сообщений всего: личные и в группах. Одно число на значок
// в шапке — его считают страница (routes/streaming/shared.js), сверка
// (/api/badge) и ответы на прочтение и удаление.
//
// Заявки на переписку (utils/privacy.js) в число не входят: незнакомый
// не должен зажигать значок тому, кто от незнакомых закрылся.
async function unreadTotal(me) {
  const requests = await Conversation.find({ requestFor: me }).distinct('_id');
  const [direct, groups] = await Promise.all([
    Message.countDocuments({ recipient: me, readAt: null, deletedFor: { $ne: me }, ...(requests.length ? { conversationId: { $nin: requests } } : {}) }),
    unread(me),
  ]);
  return direct + groups.total;
}

// Аккаунт удаляется (utils/userDelete.js): из всех групп он уходит молча,
// владение переходит преемнику, опустевшая группа удаляется целиком.
async function forgetUser(userId, removeMessages) {
  const groups = await Group.find({ 'members.user': userId });
  for (const group of groups) {
    const was = memberOf(group, userId);
    group.members = group.members.filter((m) => !same(m.user, userId));
    if (!group.members.length) {
      await removeMessages({ conversationId: group._id });
      await group.deleteOne();
      removePhoto(group.avatar);
      continue;
    }
    if (was.role === 'owner') successor(group).role = 'owner';
    await group.save();
  }
}

module.exports = {
  MAX_MEMBERS, TITLE_MAX, PEOPLE, PHOTOS,
  removePhoto, memberOf, roleOf, canManage, forMember, person, brief, info, emit, deliver, note, successor, inviteCode, unread, unreadTotal, forgetUser,
};
