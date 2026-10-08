// Вкладка «Люди»: список с фильтрами, профиль человека, удаление аккаунта.
//
// Список намеренно лёгкий — имя, роль, состояние, последний выход на связь.
// Всё тяжёлое (часы эфира, гигабайты записей, переписка) считается только
// в профиле и только для одного человека: те же подсчёты на каждую строку
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
const GalleryPhoto = require('../../models/GalleryPhoto');
const { audit } = require('../../utils/audit');
const { validate } = require('../../middleware/validate');
const { PASSWORD_PROVIDER, PASSWORD_MIN, PASSWORD_MAX, hashPassword } = require('../../utils/password');
const { removeUser } = require('../../utils/userDelete');
const retention = require('../../utils/retention');
const age = require('../../utils/age');
const profileLinks = require('../../utils/profileLinks');
const { requireModerator, requireAdmin, paging, list, needle, personBrief, csvRoute } = require('./shared');

const OBJECT_ID = /^[a-f\d]{24}$/i;

// ── Список ───────────────────────────────────────────────────────────────────
//
// Сортировка по умолчанию — новые сверху. Отдельная по «забаненные сверху»
// нужна не для красоты: ограниченные аккаунты разбирают первыми.
const SORTS = {
  new: { _id: -1 },
  old: { _id: 1 },
  name: { nickname: 1, _id: -1 },
  seen: { lastSeen: -1, _id: -1 },
  banned: { banned: -1, _id: -1 },
};

async function loadUsers(req) {
  const p = paging(req);
  const filter = {};

  const q = needle(req.query.q);
  if (q) filter.$or = [{ nickname: q }, { login: q }, { email: q }];

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
    User.find(filter).select('nickname login email role banned isOnline lastSeen avatar provider adultConfirmedAt').sort(sort).skip(p.skip).limit(p.perPage).lean(),
    User.countDocuments(filter),
  ]);

  // Почта в списке не нужна никому (shared.js, personBrief), а в выгрузке
  // администратору — нужна: ради неё выгрузку людей и делают.
  const withMail = req.csv && req.userRole === 'admin';
  return list(users.map((u) => ({
    ...personBrief(u),
    ...(req.csv ? { provider: u.provider === 'google' ? 'Google' : 'пароль', adult: !!u.adultConfirmedAt } : {}),
    ...(withMail ? { email: u.email || '' } : {}),
  })), total, p);
}

router.get('/users', requireModerator, async (req, res) => res.json(await loadUsers(req)));
csvRoute(router, '/users', requireModerator, 'people', loadUsers, (req) => [
  ['Идентификатор', (u) => u.id],
  ['Никнейм', (u) => u.nickname],
  ['Имя', (u) => u.login],
  ...(req.userRole === 'admin' ? [['Почта', (u) => u.email]] : []),
  ['Роль', (u) => ({ admin: 'администратор', moderator: 'модератор' }[u.role] || 'пользователь')],
  ['Вход', (u) => u.provider],
  ['Ограничен', (u) => (u.banned ? 'да' : '')],
  ['18+', (u) => (u.adult ? 'да' : '')],
  ['На связи', (u) => (u.isOnline ? 'да' : '')],
  ['Заведён', (u) => u.createdAt],
  ['Был на связи', (u) => u.lastSeen],
]);

// ── Профиль ──────────────────────────────────────────────────────────────────
//
// Открытие профиля пишется в журнал: панель, показывающая чужую жизнь, обязана
// сама оставлять след — иначе она дыра в приватность, а не инструмент.
router.get('/users/:id', requireModerator, async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: 'Пользователь не найден' });

  const id = new mongoose.Types.ObjectId(req.params.id);
  const user = await User.findById(id).lean();
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });

  const isAdmin = req.userRole === 'admin';

  const [streams, recordings, venues, reportsOn, reportsBy, subscribers, subscriptions,
         messagesSent, messagesGot, chatMessages, calls, sessions, live, journal, photos] = await Promise.all([
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
    Establishments.find({ owner: id }).select('name city cityOther type typeOther status online').lean(),
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
    // Открытые сеансы: отдельная коллекция mySessions (config/session.js).
    mongoose.connection.collection('mySessions')
      .find({ 'session.userId': String(id) }).project({ expires: 1 }).toArray(),
    Stream.findOne({ userId: id, isActive: true }).select('title startedAt viewers streamProvider isAdult').lean(),
    // Лента действий — только администратору: в ней адреса и почты.
    isAdmin ? AuditLog.find({ actor: id }).sort({ at: -1 }).limit(30).lean() : [],
    GalleryPhoto.countDocuments({ userId: id }),
  ]);

  const one = (rows) => (rows && rows[0]) || {};
  const s = one(streams);
  const r = one(recordings);
  const c = one(calls);

  audit(req, 'admin.view', { targetType: 'user', target: user, targetLabel: user.nickname || user.login || user.email || '' });
  // Сроки хранения файлов — только администратору (routes/admin/retention.js):
  // общие и личные поверх них.
  const policy = isAdmin ? await retention.policy() : null;

  res.json({
    person: personBrief(user),
    account: {
      // Почта — персональные данные, и модератору для его работы не нужна.
      email: isAdmin ? user.email || '' : '',
      provider: user.provider === 'google' ? 'google' : 'password',
      adultConfirmedAt: user.adultConfirmedAt || null,
      // Дата рождения (utils/age.js): модерации — разбирать жалобы на встречи
      // и аккаунты младше 18 (условия: платформа — с 18 лет).
      birthDate: age.iso(user.birthDate),
      age: user.birthDate ? age.ageOf(user.birthDate) : null,
      // Ключ вещания не показываем никому: по нему пишут в чужой эфир.
      hasStreamKey: !!user.streamKey,
      gallery: photos,
      banReason: user.banReason || '',
      bannedAt: user.bannedAt || null,
      bannedBy: user.bannedBy ? String(user.bannedBy) : null,
      sessions: sessions.length,
      sessionUntil: sessions.length ? sessions.map((x) => x.expires).sort((a, b) => b - a)[0] : null,
      // Описание и ссылки — на виду у модерации: сюда в первую очередь
      // понесут рекламу.
      bio: user.bio || '',
      links: profileLinks.list(user.links).map((l) => ({ kind: l.kind, url: l.url })),
      linksFollow: !!user.linksFollow,
    },
    retention: policy ? { all: policy, own: retention.own(user) } : null,
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

  const user = await User.findById(req.params.id).select('nickname login email').lean();
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });

  const { deletedCount } = await mongoose.connection.collection('mySessions')
    .deleteMany({ 'session.userId': String(req.params.id) });

  audit(req, 'admin.session.kill', {
    targetType: 'user', target: user,
    targetLabel: user.nickname || user.login || user.email || '',
    meta: { sessions: deletedCount },
  });

  res.json({ ok: true, sessions: deletedCount });
});

// ── Дата рождения и описание: заменить ──────────────────────────────────────
//
// Дату рождения человек указывает один раз (routes/userRoutes.js). Ошибся —
// не сбрасываем, чтобы он вписал заново что угодно (решение Ивана 07.10):
// просим подтвердить документом и вписываем дату сами. Она же решает 18+,
// как у человека. В журнал — и прежняя, и новая: замена — по документу.
router.post('/users/:id/birthdate', requireAdmin, validate({
  birthDate: { type: 'string', required: true, max: 10, label: 'Дата рождения' },
}), async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: 'Пользователь не найден' });
  const birthDate = age.parse(req.body.birthDate);
  if (!birthDate) return res.status(400).json({ message: 'Дата рождения указана неверно' });
  const adult = age.ageOf(birthDate) >= age.ADULT;
  const user = await User.findByIdAndUpdate(req.params.id,
    [{ $set: { birthDate, adultConfirmedAt: adult ? { $ifNull: ['$adultConfirmedAt', '$$NOW'] } : null } }],
    { updatePipeline: true }).select('nickname login email birthDate').lean();
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
  audit(req, 'admin.birthdate.set', {
    targetType: 'user', target: user,
    targetLabel: user.nickname || user.login || user.email || '',
    meta: { was: age.iso(user.birthDate) || null, now: age.iso(birthDate), adult },
  });
  res.json({ ok: true, birthDate: age.iso(birthDate), age: age.ageOf(birthDate) });
});

// Описание профиля — модерация меняет его на своё (реклама, оскорбления),
// а не только читает: пустое — убрать совсем. Те же правила, что у человека.
router.post('/users/:id/bio', requireModerator, validate({
  bio: { type: 'string', max: 300, allowEmpty: true, default: '', label: 'Описание' },
}), async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: 'Пользователь не найден' });
  const bio = req.body.bio.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const user = await User.findByIdAndUpdate(req.params.id, { $set: { bio } }).select('nickname login email bio').lean();
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
  audit(req, 'admin.bio.set', {
    targetType: 'user', target: user,
    targetLabel: user.nickname || user.login || user.email || '',
    meta: { was: (user.bio || '').slice(0, 300), now: bio },
  });
  res.json({ ok: true, bio });
});

// ── Ссылка на сайт для поисковиков ──────────────────────────────────────────
//
// По умолчанию ссылки профиля уходят с nofollow: иначе страницы людей
// быстро стали бы площадкой для чужого SEO. Своим и партнёрам ссылку на
// сайт открывает администратор — ставит этот флаг (userPage.ejs).
router.post('/users/:id/links-follow', requireAdmin, validate({
  on: { type: 'bool', required: true, label: 'Индексировать' },
}), async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: 'Пользователь не найден' });
  const user = await User.findByIdAndUpdate(req.params.id, { $set: { linksFollow: req.body.on } }, { returnDocument: 'after' })
    .select('nickname login email linksFollow').lean();
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
  audit(req, 'admin.links.follow', {
    targetType: 'user', target: user,
    targetLabel: user.nickname || user.login || user.email || '',
    meta: { on: req.body.on },
  });
  res.json({ ok: true, linksFollow: user.linksFollow });
});

// ── Пароль ───────────────────────────────────────────────────────────────────
//
// Новый пароль без старого: человек забыл его, а письма восстановления нет
// или не доходят. Только администратору и только аккаунту со входом по
// паролю — у вошедшего через Google пароля нет, и заведённый здесь не
// пустил бы его никуда. Чужому администратору нельзя: иначе панель
// отдаёт один администраторский аккаунт другому. Прежние сеансы человека
// закрываются — пароль меняют и тогда, когда его увели.
router.post('/users/:id/password', requireAdmin, validate({
  password: { type: 'string', required: true, min: PASSWORD_MIN, max: PASSWORD_MAX, trim: false, label: 'Пароль' },
}), async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: 'Пользователь не найден' });

  const user = await User.findById(req.params.id).select('nickname login email role provider');
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
  if (user.provider !== PASSWORD_PROVIDER) return res.status(400).json({ message: 'Аккаунт входит через Google, пароля у него нет' });
  const self = req.params.id === String(req.session.userId);
  if (user.role === 'admin' && !self) return res.status(403).json({ message: 'Пароль другого администратора сменить нельзя' });

  user.password = await hashPassword(req.body.password);
  user.passwordReset = undefined;
  await user.save();

  // Свой текущий сеанс оставляем: сменил себе пароль — не выкидывать же.
  const { deletedCount } = await mongoose.connection.collection('mySessions')
    .deleteMany({ 'session.userId': String(user._id), _id: { $ne: req.sessionID } });

  audit(req, 'admin.password.set', {
    targetType: 'user', target: user,
    targetLabel: user.nickname || user.login || user.email || '',
    meta: { sessions: deletedCount },
  });
  res.json({ ok: true, sessions: deletedCount });
});

// ── Удаление ─────────────────────────────────────────────────────────────────
//
// Насовсем: эфиры, записи в хранилище, заведения, переписка, подписки,
// файлы (utils/userDelete.js). Только администратору. Себя и другого
// администратора удалить нельзя — как и ограничить: иначе панель
// разбирается изнутри одним нажатием. Сначала роль снимают отдельно.
router.delete('/users/:id', requireAdmin, async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: 'Пользователь не найден' });
  if (req.params.id === String(req.session.userId)) return res.status(400).json({ message: 'Себя удалить нельзя' });

  const user = await User.findById(req.params.id).select('nickname login email role avatar ogCard').lean();
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
  if (user.role === 'admin') return res.status(403).json({ message: 'Администратора удалить нельзя — сначала смените роль' });

  const removed = await removeUser(user, req.app.get('io'));

  audit(req, 'admin.user.delete', {
    targetType: 'user', target: user,
    targetLabel: user.nickname || user.login || user.email || '',
    meta: removed,
  });
  res.json({ ok: true, removed });
});

module.exports = router;
