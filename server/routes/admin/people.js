// Вкладка «Люди»: список с фильтрами и досье на человека.
//
// Список намеренно лёгкий — имя, роль, состояние, последний выход на связь.
// Всё тяжёлое (часы эфира, гигабайты записей, переписка) считается только
// в досье и только для одного человека: те же подсчёты на каждую строку
// списка означали бы десяток обращений к базе на страницу.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const mongoose = require('mongoose');
const User = require('../../models/User');
const StreamSession = require('../../models/StreamSession');
const Recording = require('../../models/Recording');
const Establishments = require('../../models/Establishments');
const Report = require('../../models/Report');
const Subscription = require('../../models/Subscription');
const Message = require('../../models/Message');
const ChatMessage = require('../../models/ChatMessage');
const Call = require('../../models/Call');
const AuditLog = require('../../models/AuditLog');
const Stream = require('../../models/Stream');
const { audit } = require('../../utils/audit');
const { requireModerator, requireAdmin, paging, list, needle, personBrief } = require('./shared');

const OBJECT_ID = /^[a-f\d]{24}$/i;

// ── Список ───────────────────────────────────────────────────────────────────
//
// Сортировка по умолчанию — новые сверху. Отдельная по «забаненные сверху»
// нужна не для красоты: ограниченные аккаунты разбирают первыми.
const SORTS = {
  new: { _id: -1 },
  old: { _id: 1 },
  name: { login: 1, _id: -1 },
  seen: { lastSeen: -1, _id: -1 },
  banned: { banned: -1, _id: -1 },
};

router.get('/users', requireModerator, async (req, res) => {
  const p = paging(req);
  const filter = {};

  const q = needle(req.query.q);
  if (q) filter.$or = [{ login: q }, { email: q }];

  if (['user', 'moderator', 'admin'].includes(req.query.role)) filter.role = req.query.role;
  if (req.query.status === 'banned') filter.banned = true;
  if (req.query.status === 'online') filter.isOnline = true;
  if (req.query.status === 'adult') filter.adultConfirmedAt = { $ne: null };
  // Как человек входит: через Google или паролем. В схеме это одно поле
  // provider, пустое у входа по паролю.
  if (req.query.provider === 'google') filter.provider = 'google';
  if (req.query.provider === 'password') filter.provider = { $in: ['', null] };

  const sort = SORTS[req.query.sort] || SORTS.new;

  const [users, total] = await Promise.all([
    User.find(filter).select('login email role banned isOnline lastSeen avatar').sort(sort).skip(p.skip).limit(p.perPage).lean(),
    User.countDocuments(filter),
  ]);

  res.json(list(users.map(personBrief), total, p));
});

// ── Досье ────────────────────────────────────────────────────────────────────
//
// Открытие досье пишется в журнал: панель, показывающая чужую жизнь, обязана
// сама оставлять след — иначе она дыра в приватность, а не инструмент.
router.get('/users/:id', requireModerator, async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: 'Пользователь не найден' });

  const id = new mongoose.Types.ObjectId(req.params.id);
  const user = await User.findById(id).lean();
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });

  const isAdmin = req.userRole === 'admin';

  const [streams, recordings, venues, reportsOn, reportsBy, subscribers, subscriptions,
         messagesSent, messagesGot, chatMessages, calls, sessions, live, journal] = await Promise.all([
    // Эфиры: часы, пик, средний зритель. Один проход по отрезкам вместо
    // десятка счётчиков.
    StreamSession.aggregate([
      { $match: { user: id } },
      { $group: {
        _id: null,
        count: { $sum: 1 },
        seconds: { $sum: '$duration' },
        peak: { $max: '$peakViewers' },
        viewerSeconds: { $sum: '$viewerSeconds' },
        chat: { $sum: '$chatMessages' },
        last: { $max: '$startedAt' },
        web: { $sum: { $cond: [{ $eq: ['$source', 'web'] }, 1, 0] } },
        obs: { $sum: { $cond: [{ $eq: ['$source', 'obs'] }, 1, 0] } },
        stopped: { $sum: { $cond: [{ $eq: ['$endedBy', 'moderation'] }, 1, 0] } },
      } },
    ]),
    Recording.aggregate([
      { $match: { userId: id } },
      { $group: {
        _id: null,
        count: { $sum: 1 },
        seconds: { $sum: '$duration' },
        bytes: { $sum: '$size' },
        ready: { $sum: { $cond: [{ $eq: ['$status', 'ready'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
      } },
    ]),
    Establishments.find({ owner: id }).select('name city type status online').lean(),
    Report.aggregate([
      { $match: { targetType: 'user', targetId: id } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    Report.countDocuments({ reporter: id }),
    Subscription.countDocuments({ subscribedToId: id }),
    Subscription.countDocuments({ subscriberId: id }),
    Message.countDocuments({ sender: id }),
    Message.countDocuments({ recipient: id }),
    ChatMessage.countDocuments({ userId: id }),
    // Звонки в обе стороны: сколько всего и сколько минут разговора.
    Call.aggregate([
      { $match: { $or: [{ caller: id }, { callee: id }] } },
      { $group: {
        _id: null,
        count: { $sum: 1 },
        answered: { $sum: { $cond: [{ $eq: ['$status', 'answered'] }, 1, 0] } },
        seconds: { $sum: { $cond: [
          { $and: ['$answeredAt', '$endedAt'] },
          { $divide: [{ $subtract: ['$endedAt', '$answeredAt'] }, 1000] },
          0,
        ] } },
      } },
    ]),
    // Открытые сеансы: их хранит connect-mongodb-session отдельной коллекцией.
    mongoose.connection.collection('mySessions')
      .find({ 'session.userId': String(id) }).project({ expires: 1 }).toArray(),
    Stream.findOne({ userId: id, isActive: true }).select('title startedAt viewers streamProvider isAdult').lean(),
    // Лента действий — только администратору: в ней адреса и почты.
    isAdmin ? AuditLog.find({ actor: id }).sort({ at: -1 }).limit(30).lean() : [],
  ]);

  const one = (rows) => (rows && rows[0]) || {};
  const s = one(streams);
  const r = one(recordings);
  const c = one(calls);

  audit(req, 'admin.view', { targetType: 'user', target: user, targetLabel: user.login || user.email || '' });

  res.json({
    person: personBrief(user),
    account: {
      // Почта — персональные данные, и модератору для его работы не нужна.
      email: isAdmin ? user.email || '' : '',
      provider: user.provider === 'google' ? 'google' : 'password',
      adultConfirmedAt: user.adultConfirmedAt || null,
      // Ключ вещания не показываем никому: по нему пишут в чужой эфир.
      hasStreamKey: !!user.streamKey,
      gallery: (user.gallery || []).length,
      banReason: user.banReason || '',
      bannedAt: user.bannedAt || null,
      bannedBy: user.bannedBy ? String(user.bannedBy) : null,
      sessions: sessions.length,
      sessionUntil: sessions.length ? sessions.map((x) => x.expires).sort((a, b) => b - a)[0] : null,
    },
    streams: {
      count: s.count || 0,
      seconds: s.seconds || 0,
      peak: s.peak || 0,
      viewerSeconds: s.viewerSeconds || 0,
      chat: s.chat || 0,
      last: s.last || null,
      web: s.web || 0,
      obs: s.obs || 0,
      stoppedByModeration: s.stopped || 0,
    },
    recordings: {
      count: r.count || 0,
      seconds: r.seconds || 0,
      bytes: r.bytes || 0,
      ready: r.ready || 0,
      failed: r.failed || 0,
    },
    venues: venues.map((v) => ({ id: String(v._id), name: v.name || '', city: v.city || '', type: v.type || '', status: !!v.status, online: !!v.online })),
    reports: {
      on: reportsOn.reduce((acc, row) => ({ ...acc, [row._id]: row.n }), {}),
      by: reportsBy,
    },
    social: {
      subscribers,
      subscriptions,
      messagesSent,
      messagesGot,
      chatMessages,
      calls: c.count || 0,
      callsAnswered: c.answered || 0,
      callSeconds: Math.round(c.seconds || 0),
    },
    live: live ? { id: String(live._id), title: live.title, startedAt: live.startedAt, viewers: live.viewers || 0, source: live.streamProvider === 'obs' ? 'obs' : 'web', isAdult: !!live.isAdult } : null,
    journal: journal.map((a) => ({
      at: a.at, action: a.action, result: a.result,
      targetType: a.targetType, targetLabel: a.targetLabel, ip: a.ip, meta: a.meta,
    })),
  });
});

// ── Сеансы ───────────────────────────────────────────────────────────────────
//
// Закрыть чужие сеансы — не то же самое, что ограничить аккаунт: пароль увели,
// человек забыл выйти на чужом компьютере. Только администратору.
router.post('/users/:id/sessions/kill', requireAdmin, async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: 'Пользователь не найден' });

  const user = await User.findById(req.params.id).select('login email').lean();
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });

  const { deletedCount } = await mongoose.connection.collection('mySessions')
    .deleteMany({ 'session.userId': String(req.params.id) });

  audit(req, 'admin.session.kill', {
    targetType: 'user', target: user,
    targetLabel: user.login || user.email || '',
    meta: { sessions: deletedCount },
  });

  res.json({ ok: true, sessions: deletedCount });
});

module.exports = router;
