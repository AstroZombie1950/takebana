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
  audit(req, 'auth.register', { actor: user });
  res.status(200).json({ message: 'Регистрация прошла успешно', redirectUrl });
});



router.post('/update-profile', validate({
  login: { type: 'string', required: true, min: 1, max: 64, label: 'Логин' },
}), async (req, res) => {
  const { login } = req.body;
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: 'Пользователь не авторизован' });
  }
  // Найти пользователя по ID
  const user = await User.findById(userId);
  if (!user) {
    return res.status(400).json({ message: 'Пользователь не найден' });
  }
  // Обновить логин пользователя
  const was = user.login;
  user.login = login;
  // Сохранить обновленного пользователя
  await user.save();

  audit(req, 'profile.update', { targetType: 'user', target: user, meta: { login: { was, now: login } } });
  res.status(200).json({ message: 'Профиль успешно обновлен' });
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