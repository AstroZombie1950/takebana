// Вкладки «Поддержка» и «Рассылка»: переписка официального аккаунта
// и рассылки от его имени (utils/support.js). Только администратору:
// здесь чужая личная переписка и письмо сразу всем.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const mongoose = require('mongoose');
const User = require('../../models/User');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Broadcast = require('../../models/Broadcast');
const support = require('../../utils/support');
const { viewAll } = require('../../utils/messageView');
const { audit } = require('../../utils/audit');
const { validate } = require('../../middleware/validate');
const { requireAdmin, paging, list, personBrief, namesFor } = require('./shared');

const OBJECT_ID = /^[a-f\d]{24}$/i;
const MESSAGES_PAGE = 30;

// Аккаунт поддержки или 409: без него вкладкам нечего показать.
async function senderOr409(res) {
  const sender = await support.account();
  if (!sender) res.status(409).json({ message: 'Аккаунт поддержки не выбран' });
  return sender;
}

// Непрочитанное поддержкой — для счётчика у вкладки.
function unreadCount(senderId) {
  return Message.countDocuments({ recipient: senderId, readAt: null, deletedFor: { $ne: senderId } });
}

// ── Состояние: чей аккаунт, приветствие, заготовки ───────────────────────────
router.get('/support', requireAdmin, async (req, res) => {
  const [sender, admins] = await Promise.all([
    support.account(),
    User.find({ role: 'admin' }).select('nickname login email avatar role').sort({ _id: 1 }).lean(),
  ]);
  res.json({
    account: sender ? { ...personBrief(sender), welcome: !!sender.supportWelcome } : null,
    admins: admins.map(personBrief),
    templates: support.templates(),
    unread: sender ? await unreadCount(sender._id) : 0,
  });
});

// Выбрать аккаунт поддержки — одного из администраторов. Отметка одна:
// прежний аккаунт её теряет, его переписка остаётся ему.
router.post('/support/account', requireAdmin, validate({
  userId: { type: 'objectId', required: true, label: 'Аккаунт' },
}), async (req, res) => {
  const user = await User.findOne({ _id: req.body.userId, role: 'admin' }).select('nickname login email role').lean();
  if (!user) return res.status(400).json({ message: 'Аккаунтом поддержки может быть только администратор' });
  await User.updateMany({ support: true, _id: { $ne: user._id } }, { $unset: { support: 1, supportWelcome: 1 } });
  await User.updateOne({ _id: user._id }, { $set: { support: true } });
  audit(req, 'support.account', { targetType: 'user', target: user });
  res.json({ success: true });
});

router.post('/support/welcome', requireAdmin, validate({
  on: { type: 'bool', required: true, label: 'Приветствие' },
}), async (req, res) => {
  const sender = await senderOr409(res);
  if (!sender) return;
  await User.updateOne({ _id: sender._id }, req.body.on ? { $set: { supportWelcome: true } } : { $unset: { supportWelcome: 1 } });
  audit(req, 'support.welcome', { targetType: 'user', target: sender, meta: { on: req.body.on } });
  res.json({ success: true, welcome: req.body.on });
});

// ── Переписка ────────────────────────────────────────────────────────────────
//
// По умолчанию — диалоги, где человек хоть раз написал сам: после рассылки
// у поддержки тысячи диалогов из одного её сообщения, и обращения в них
// тонут. show=unread — только с непрочитанным, show=all — все.
router.get('/support/dialogs', requireAdmin, async (req, res) => {
  const p = paging(req);
  const sender = await support.account();
  // Без аккаунта — пустой список: панель предложит его выбрать.
  if (!sender) return res.json({ ...list([], 0, p), account: null });
  const S = sender._id;
  const show = ['unread', 'all'].includes(req.query.show) ? req.query.show : 'replied';

  const where = { $or: [{ userOne: S }, { userTwo: S }] };
  if (show !== 'all') {
    where._id = { $in: await Message.distinct('conversationId', show === 'unread'
      ? { recipient: S, readAt: null, deletedFor: { $ne: S } }
      : { recipient: S }) };
  }
  const [rows, total] = await Promise.all([
    Conversation.find(where).sort({ lastUpdated: -1 }).skip(p.skip).limit(p.perPage).lean(),
    Conversation.countDocuments(where),
  ]);
  const ids = rows.map((c) => c._id);
  const [names, lasts, unread] = await Promise.all([
    namesFor(rows.map((c) => (String(c.userOne) === String(S) ? c.userTwo : c.userOne))),
    Message.find({ _id: { $in: rows.map((c) => c.lastMessage).filter(Boolean) } }).select('sender content attachments sentAt').lean(),
    Message.aggregate([
      { $match: { conversationId: { $in: ids }, recipient: S, readAt: null } },
      { $group: { _id: '$conversationId', n: { $sum: 1 } } },
    ]),
  ]);
  const lastBy = new Map(lasts.map((m) => [String(m._id), m]));
  const unreadBy = new Map(unread.map((r) => [String(r._id), r.n]));
  const items = rows.map((c) => {
    const peerId = String(String(c.userOne) === String(S) ? c.userTwo : c.userOne);
    const last = c.lastMessage && lastBy.get(String(c.lastMessage));
    return {
      peer: names.get(peerId) || { id: peerId, displayName: '#' + peerId.slice(-6), avatar: {} },
      last: last ? {
        mine: String(last.sender) === String(S),
        text: String(last.content || '').slice(0, 140),
        kind: last.attachments && last.attachments[0] ? last.attachments[0].kind : '',
      } : null,
      unread: unreadBy.get(String(c._id)) || 0,
      at: c.lastUpdated,
    };
  });
  res.json({ ...list(items, total, p), account: personBrief(sender) });
});

// Лента одного диалога страницами от конца, как в переписке.
router.get('/support/dialogs/:peerId', requireAdmin, async (req, res) => {
  if (!OBJECT_ID.test(req.params.peerId)) return res.status(404).json({ message: 'Диалог не найден' });
  const sender = await senderOr409(res);
  if (!sender) return;
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  if (before && isNaN(before)) return res.status(400).json({ message: 'Неверный запрос' });

  const [peer, conversation] = await Promise.all([
    User.findById(req.params.peerId).select('nickname login email avatar role banned').lean(),
    require('../streaming/messages').findConversation(sender._id, req.params.peerId),
  ]);
  if (!peer) return res.status(404).json({ message: 'Пользователь не найден' });
  const messages = conversation
    ? await Message.find({ conversationId: conversation._id, deletedFor: { $ne: sender._id }, ...(before ? { sentAt: { $lt: before } } : {}) })
      .sort({ sentAt: -1 }).limit(MESSAGES_PAGE + 1).lean()
    : [];
  const more = messages.length > MESSAGES_PAGE;
  res.json({
    peer: personBrief(peer),
    account: personBrief(sender),
    messages: await viewAll(messages.slice(0, MESSAGES_PAGE).reverse()),
    more,
  });
});

// Прочитано поддержкой: человеку — «прочитано», как в обычной переписке.
router.post('/support/dialogs/:peerId/read', requireAdmin, async (req, res) => {
  if (!OBJECT_ID.test(req.params.peerId)) return res.status(404).json({ message: 'Диалог не найден' });
  const sender = await senderOr409(res);
  if (!sender) return;
  const conversation = await require('../streaming/messages').findConversation(sender._id, req.params.peerId);
  if (conversation) {
    const now = new Date();
    const r = await Message.updateMany(
      { conversationId: conversation._id, recipient: sender._id, readAt: null },
      [{ $set: { readAt: now, deliveredAt: { $ifNull: ['$deliveredAt', now] } } }],
      { updatePipeline: true },
    );
    const io = req.app.get('io');
    if (r.modifiedCount && io) io.to(`user:${req.params.peerId}`).emit('message:read', { readerId: String(sender._id), at: now });
  }
  res.json({ success: true, unread: await unreadCount(sender._id) });
});

router.post('/support/dialogs/:peerId/send', requireAdmin, validate({
  content: { type: 'string', required: true, min: 1, max: 5000, label: 'Сообщение' },
}), async (req, res) => {
  if (!OBJECT_ID.test(req.params.peerId)) return res.status(404).json({ message: 'Диалог не найден' });
  const sender = await senderOr409(res);
  if (!sender) return;
  const peer = await User.findById(req.params.peerId).select('nickname login email avatar role').lean();
  if (!peer) return res.status(404).json({ message: 'Пользователь не найден' });
  if (String(peer._id) === String(sender._id)) return res.status(400).json({ message: 'Нельзя написать самому себе' });
  const message = await support.send(req, sender, peer, req.body.content);
  audit(req, 'support.reply', { targetType: 'user', target: peer, meta: { len: req.body.content.length } });
  res.json({ message });
});

// ── Рассылка ─────────────────────────────────────────────────────────────────
const AUDIENCE = {
  kind: { type: 'string', required: true, values: ['all', 'recent', 'nopush', 'self'], label: 'Кому' },
  days: { type: 'int', min: 1, max: 365, default: 7, label: 'Дней' },
};

router.get('/support/audience', requireAdmin, async (req, res) => {
  const sender = await senderOr409(res);
  if (!sender) return;
  const kind = ['all', 'recent', 'nopush', 'self'].includes(req.query.kind) ? req.query.kind : 'all';
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 7));
  res.json({ count: await support.audienceCount(kind, days, new mongoose.Types.ObjectId(String(req.session.userId)), sender._id) });
});

router.post('/support/broadcast', requireAdmin, validate({
  text: { type: 'object', required: true, label: 'Текст', schema: {
    ru: { type: 'string', max: 5000, allowEmpty: true, default: '' },
    en: { type: 'string', max: 5000, allowEmpty: true, default: '' },
  } },
  template: { type: 'string', max: 32, allowEmpty: true, default: '', label: 'Заготовка' },
  audience: { type: 'object', required: true, label: 'Кому', schema: AUDIENCE },
  push: { type: 'bool', default: true, label: 'Пуш' },
}), async (req, res) => {
  const sender = await senderOr409(res);
  if (!sender) return;
  const text = { ru: req.body.text.ru.trim(), en: req.body.text.en.trim() };
  if (!text.ru && !text.en) return res.status(400).json({ message: 'Напишите текст рассылки' });
  // Проверка «только мне» от самого аккаунта поддержки — письмо самому себе.
  if (req.body.audience.kind === 'self' && String(sender._id) === String(req.session.userId)) {
    return res.status(400).json({ message: 'Проверку отправьте из личного аккаунта администратора: этот — аккаунт поддержки' });
  }
  const busy = await Broadcast.exists({ status: 'running' });
  if (busy && req.body.audience.kind !== 'self') return res.status(409).json({ message: 'Предыдущая рассылка ещё идёт' });
  const doc = await support.broadcast(req, sender, {
    by: new mongoose.Types.ObjectId(String(req.session.userId)),
    template: req.body.template,
    text,
    audience: { kind: req.body.audience.kind, ...(req.body.audience.kind === 'recent' ? { days: req.body.audience.days } : {}) },
    push: req.body.push,
  });
  audit(req, 'support.broadcast', { targetType: 'broadcast', targetId: doc._id, meta: { audience: doc.audience.kind, total: doc.total, template: doc.template } });
  res.json({ success: true, id: String(doc._id), total: doc.total });
});

router.get('/support/broadcasts', requireAdmin, async (req, res) => {
  const p = paging(req);
  const [rows, total] = await Promise.all([
    Broadcast.find().sort({ createdAt: -1 }).skip(p.skip).limit(p.perPage).lean(),
    Broadcast.estimatedDocumentCount(),
  ]);
  const names = await namesFor(rows.map((b) => b.by));
  res.json(list(rows.map((b) => ({
    id: String(b._id),
    by: names.get(String(b.by)) || null,
    template: b.template,
    text: b.text,
    audience: b.audience,
    push: b.push,
    total: b.total,
    sent: b.sent,
    failed: b.failed,
    status: b.status,
    createdAt: b.createdAt,
    finishedAt: b.finishedAt,
  })), total, p));
});

module.exports = router;
