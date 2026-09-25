// routes/userRoutes.js
const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
const { authLimiter, registerLimiter } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
const { safeNext, signIn } = require('../middleware/auth');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const User = require('../models/User');
const { PASSWORD_PROVIDER, PASSWORD_MIN, PASSWORD_MAX, hashPassword } = require('../utils/password');
const { audit } = require('../utils/audit');
const loginGuard = require('../utils/loginGuard');
const nickname = require('../utils/nickname');
const profileLinks = require('../utils/profileLinks');
const privacy = require('../utils/privacy');
const support = require('../utils/support');
const { langOf } = require('../utils/i18n');
const errorLog = require('../utils/errorLog');
// Подтверждение почты после регистрации (router.sendVerify есть, когда настроена почта).
const emailRoutes = require('./emailChange');
const { requireAuthApi } = require('../middleware/auth');

const NICK_ERRORS = {
  format: 'Ник: 3–20 знаков — латинские буквы, цифры и «_», первая — буква',
  reserved: 'Этот ник зарезервирован',
  taken: 'Этот ник уже занят',
};

// Хеш для сверки, когда учётки нет: ответ идёт столько же, сколько с
// неверным паролем, и по времени не видно, зарегистрирована ли почта.
// Стоимость — та же, что у настоящих (utils/password.js).
const TIMING_HASH = bcrypt.hashSync('timing-only', 10);

// Маршрут входа
router.post('/login', authLimiter, validate({
  email: { type: 'email', required: true, label: 'Почта' },
  // На входе длину не проверяем: пароли старых учёток могут быть короче
  // нынешнего минимума, и человек должен суметь войти и сменить его.
  password: { type: 'string', required: true, max: PASSWORD_MAX, trim: false, label: 'Пароль' },
  next: { type: 'string', max: 500, default: '', label: 'Возврат' },
  // Решённая задача против подбора (utils/loginGuard.js), после трёх ошибок.
  task: { type: 'string', max: 100, default: '', label: 'Проверка' },
}), async (req, res) => {
  const { email, password } = req.body;
  const attempt = await loginGuard.start(req, res, email);
  if (!attempt) return;
  const provider = PASSWORD_PROVIDER;
  const user = await User.findOne({ email: email, provider: provider });
  if (!user) {
    // Учётки нет. Ответ такой же, как при неверном пароле, но в журнале
    // это разные случаи: перебор почты и перебор пароля выглядят по-разному.
    audit(req, 'auth.login.fail', { result: 'fail', actorLogin: email, meta: { reason: 'no-account' } });
    await bcrypt.compare(password, TIMING_HASH);
    return attempt.fail('Неверная почта или пароль');
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    audit(req, 'auth.login.fail', { result: 'fail', actor: user, actorLogin: email, meta: { reason: 'bad-password' } });
    return attempt.fail('Неверная почта или пароль');
  }

  await attempt.ok();
  await signIn(req, user);

  // Туда, откуда пришёл на вход (?next= страницы входа), иначе на витрину.
  const redirectUrl = safeNext(req.body.next) || '/';
  audit(req, 'auth.login', { actor: user });
  res.status(200).json({ message: 'Вход выполнен', redirectUrl });
});

// Маршрут регистрации
router.post('/register', registerLimiter, validate({
  email: { type: 'email', required: true, label: 'Почта' },
  password: { type: 'string', required: true, min: PASSWORD_MIN, max: PASSWORD_MAX, trim: false, label: 'Пароль' },
  login: { type: 'string', max: 64, default: '', label: 'Логин' },
  next: { type: 'string', max: 500, default: '', label: 'Возврат' },
}), async (req, res) => {
  const { email, password, login } = req.body;
  const provider = PASSWORD_PROVIDER; // см. комментарий выше
  const existingUser = await User.findOne({ email: email, provider: provider });
  if (existingUser) {
    audit(req, 'auth.register', { result: 'fail', actorLogin: email, meta: { reason: 'email-taken' } });
    return res.status(400).json({ message: 'Пользователь с такой почтой уже есть' });
  }

  const hashedPassword = await hashPassword(password);
  const lang = langOf(req);
  const user = new User({ email: email, login: login, password: hashedPassword, provider: provider, lang });
  await user.save();
  // Приветствие от поддержки, если оно включено в панели (utils/support.js).
  support.welcome(req, user, lang);

  await signIn(req, user);

  // Туда, откуда пришёл на вход (?next= страницы входа), иначе на витрину.
  const redirectUrl = safeNext(req.body.next) || '/';
  // Письмо для подтверждения почты. Не ждём и не держим регистрацию:
  // не дошло — человек повторит из настроек.
  if (emailRoutes.sendVerify) {
    emailRoutes.sendVerify(req, user).catch((e) => errorLog.external(e, 'mail.verify.register'));
  }

  audit(req, 'auth.register', { actor: user });
  res.status(200).json({ message: 'Регистрация прошла успешно', redirectUrl });
});



// Имя и никнейм из настроек. Имя — свободная строка, пустое можно. Ник —
// по правилам utils/nickname.js, уникальный, не чаще раза в 30 дней.
router.post('/update-profile', validate({
  login: { type: 'string', max: 64, allowEmpty: true, default: '', label: 'Имя' },
  nickname: { type: 'string', required: true, max: 40, label: 'Никнейм' },
}), async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: 'Пользователь не авторизован' });
  }
  const user = await User.findById(userId);
  if (!user) {
    return res.status(400).json({ message: 'Пользователь не найден' });
  }

  const login = req.body.login || '';
  const nick = nickname.normalize(req.body.nickname);
  const changed = nick !== user.nickname;
  if (changed) {
    const bad = nickname.problem(nick, { official: user.role === 'admin' });
    if (bad) return res.status(400).json({ message: NICK_ERRORS[bad], reason: bad });
    const wait = nickname.nextChangeAt(user);
    if (wait) {
      return res.status(400).json({ message: 'Ник можно менять раз в 30 дней', reason: 'wait', until: wait });
    }
    if (await User.exists({ nickname: nick, _id: { $ne: user._id } })) {
      return res.status(400).json({ message: NICK_ERRORS.taken, reason: 'taken' });
    }
  }

  const was = { login: user.login, nickname: user.nickname };
  user.login = login;
  if (changed) {
    // Старый адрес /@ник остаётся рабочим — ссылки на профиль уже разошлись.
    if (user.nickname) user.formerNicknames = [...(user.formerNicknames || []).filter((n) => n !== user.nickname && n !== nick), user.nickname].slice(-10);
    user.nickname = nick;
    user.nicknameChangedAt = new Date();
  }
  try {
    await user.save();
  } catch (e) {
    // Ник заняли между проверкой и сохранением.
    if (e && e.code === 11000) return res.status(400).json({ message: NICK_ERRORS.taken, reason: 'taken' });
    throw e;
  }

  audit(req, 'profile.update', { targetType: 'user', target: user, meta: { was, now: { login, nickname: user.nickname } } });
  res.status(200).json({ message: 'Профиль успешно обновлен', nickname: user.nickname, login });
});

// Описание и ссылки профиля из настроек. Ссылки разбирает
// utils/profileLinks.js; ответ — как их теперь видно, чтобы форма показала
// принятое значение и итоговую ссылку.
router.post('/settings/about', requireAuthApi, validate({
  bio: { type: 'string', max: 300, allowEmpty: true, default: '', label: 'Описание' },
  links: { type: 'object', default: {}, label: 'Ссылки', schema: Object.fromEntries(profileLinks.KINDS.map((k) => [k, { type: 'string', max: 300, allowEmpty: true, default: '' }])) },
}), async (req, res) => {
  // Пока ссылки выключены (profileLinks.ENABLED), сохраняем только описание:
  // прежние ссылки в базе остаются как были.
  const parsed = profileLinks.ENABLED ? profileLinks.parse(req.body.links) : null;
  if (parsed && parsed.error) return res.status(400).json({ message: parsed.message, field: parsed.error });
  // Больше двух пустых строк подряд — просто отступ, не вёрстка.
  const bio = req.body.bio.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  const set = parsed ? { bio, links: parsed.links } : { bio };
  const user = await User.findByIdAndUpdate(req.session.userId, { $set: set }, { returnDocument: 'after' })
    .select('bio links nickname login email').lean();
  if (!user) return res.status(401).json({ message: 'Необходима авторизация' });
  audit(req, 'profile.update', { targetType: 'user', target: user, meta: { bio: bio.length, ...(parsed ? { links: Object.keys(parsed.links) } : {}) } });
  res.json({ bio: user.bio, links: parsed ? profileLinks.list(user.links) : [] });
});

// Приватность (utils/privacy.js): поле за полем, сохраняется сразу по
// переключению. Приходит только то, что меняют; остальное не трогаем.
router.post('/settings/privacy', requireAuthApi, validate({
  ...Object.fromEntries(Object.entries(privacy.OPTIONS).map(([k, values]) => [k, { type: 'string', values, label: 'Приватность' }])),
  searchable: { type: 'bool', label: 'Приватность' },
}), async (req, res) => {
  const changed = {};
  for (const key of Object.keys(privacy.DEFAULTS)) {
    if (req.body[key] !== undefined) changed[key] = req.body[key];
  }
  if (!Object.keys(changed).length) return res.status(400).json({ message: 'Неверный запрос' });
  const set = Object.fromEntries(Object.entries(changed).map(([k, v]) => ['privacy.' + k, v]));
  const user = await User.findByIdAndUpdate(req.session.userId, { $set: set }, { returnDocument: 'after' })
    .select('privacy nickname login email').lean();
  if (!user) return res.status(401).json({ message: 'Необходима авторизация' });
  audit(req, 'profile.privacy', { targetType: 'user', target: user, meta: { privacy: Object.entries(changed).map(([k, v]) => k + '=' + v).join(', ') } });
  res.json({ privacy: privacy.of(user) });
});

// Свободен ли ник — поле в настройках спрашивает на ходу, пока человек печатает.
router.get('/api/nickname/check', requireAuthApi, async (req, res) => {
  const nick = nickname.normalize(req.query.n);
  const me = await User.findById(req.session.userId).select('nickname nicknameChangedAt role').lean();
  if (!me) return res.status(401).json({ message: 'Необходима авторизация' });
  if (nick === me.nickname) return res.json({ ok: true, same: true });
  const bad = nickname.problem(nick, { official: me.role === 'admin' });
  if (bad) return res.json({ ok: false, reason: bad });
  if (await User.exists({ nickname: nick })) return res.json({ ok: false, reason: 'taken' });
  const wait = nickname.nextChangeAt(me);
  res.json({ ok: !wait, reason: wait ? 'wait' : null, until: wait });
});

// Минимум тот же, что в регистрации: иначе через смену пароля он обходится.
router.post('/update-password', authLimiter, validate({
  oldPassword: { type: 'string', required: true, max: PASSWORD_MAX, trim: false, label: 'Старый пароль' },
  newPassword: { type: 'string', required: true, min: PASSWORD_MIN, max: PASSWORD_MAX, trim: false, label: 'Новый пароль' },
}), async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: 'Пользователь не авторизован' });
  }
  const user = await User.findById(userId);
  if (!user) {
    return res.status(400).json({ message: 'Пользователь не найден' });
  }
  const attempt = await loginGuard.start(req, res, user.email, { task: false });
  if (!attempt) return;
  const match = await bcrypt.compare(oldPassword, user.password);
  if (!match) {
    audit(req, 'auth.password.change', { result: 'fail', targetType: 'user', target: user });
    return attempt.fail('Неверный старый пароль');
  }
  await attempt.ok();
  user.password = await hashPassword(newPassword);
  await user.save();
  // Прочие сеансы — закрыть, как при сбросе пароля и смене администратором:
  // пароль меняют, в том числе, когда его узнал кто-то другой. Этот остаётся.
  await mongoose.connection.collection('mySessions')
    .deleteMany({ 'session.userId': String(user._id), _id: { $ne: req.sessionID } });

  audit(req, 'auth.password.change', { targetType: 'user', target: user });
  res.status(200).json({ message: 'Пароль успешно обновлен' });
});

module.exports = router;