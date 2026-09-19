// routes/userRoutes.js
const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
const { authLimiter, registerLimiter } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
const { safeNext } = require('../middleware/auth');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const bcrypt = require('bcrypt');
const User = require('../models/User');
const { PASSWORD_PROVIDER, PASSWORD_MIN, PASSWORD_MAX, hashPassword } = require('../utils/password');
const { audit } = require('../utils/audit');
const nickname = require('../utils/nickname');
const errorLog = require('../utils/errorLog');
// Подтверждение почты после регистрации (router.sendVerify есть, когда настроена почта).
const emailRoutes = require('./emailChange');
const { requireAuthApi } = require('../middleware/auth');

const NICK_ERRORS = {
  format: 'Ник: 3–20 знаков — латинские буквы, цифры и «_», первая — буква',
  reserved: 'Этот ник зарезервирован',
  taken: 'Этот ник уже занят',
};

// Маршрут входа
router.post('/login', authLimiter, validate({
  email: { type: 'email', required: true, label: 'Почта' },
  // На входе длину не проверяем: пароли старых учёток могут быть короче
  // нынешнего минимума, и человек должен суметь войти и сменить его.
  password: { type: 'string', required: true, max: PASSWORD_MAX, trim: false, label: 'Пароль' },
  next: { type: 'string', max: 500, default: '', label: 'Возврат' },
}), async (req, res) => {
  const { email, password } = req.body;
  const provider = PASSWORD_PROVIDER;
  const user = await User.findOne({ email: email, provider: provider });
  if (!user) {
    // Учётки нет. Ответ такой же, как при неверном пароле, но в журнале
    // это разные случаи: перебор почты и перебор пароля выглядят по-разному.
    audit(req, 'auth.login.fail', { result: 'fail', actorLogin: email, meta: { reason: 'no-account' } });
    return res.status(400).json({ message: 'Неверная почта или пароль' });
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    audit(req, 'auth.login.fail', { result: 'fail', actor: user, actorLogin: email, meta: { reason: 'bad-password' } });
    return res.status(400).json({ message: 'Неверная почта или пароль' });
  }

  req.session.userId = user._id.toString();
  req.session.login = user.login || 'anon';

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
  const user = new User({ email: email, login: login, password: hashedPassword, provider: provider });
  await user.save();

  req.session.userId = user._id.toString();
  req.session.login = user.login || 'anon';

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
    const bad = nickname.problem(nick);
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

// Свободен ли ник — поле в настройках спрашивает на ходу, пока человек печатает.
router.get('/api/nickname/check', requireAuthApi, async (req, res) => {
  const nick = nickname.normalize(req.query.n);
  const me = await User.findById(req.session.userId).select('nickname nicknameChangedAt').lean();
  if (!me) return res.status(401).json({ message: 'Необходима авторизация' });
  if (nick === me.nickname) return res.json({ ok: true, same: true });
  const bad = nickname.problem(nick);
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
  const match = await bcrypt.compare(oldPassword, user.password);
  if (!match) {
    audit(req, 'auth.password.change', { result: 'fail', targetType: 'user', target: user });
    return res.status(400).json({ message: 'Неверный старый пароль' });
  }
  user.password = await hashPassword(newPassword);
  await user.save();

  audit(req, 'auth.password.change', { targetType: 'user', target: user });
  res.status(200).json({ message: 'Пароль успешно обновлен' });
});

module.exports = router;