// Восстановление пароля: письмо со ссылкой и новый пароль по ней.
//
//   GET  /forgot-password          форма почты
//   POST /forgot-password          { email } — всегда один и тот же ответ
//   GET  /reset-password/:token    форма нового пароля или «ссылка устарела»
//   POST /reset-password           { token, password } — смена и вход
//
// Ответ на запрос письма одинаков, есть учётка или нет, и уходит до поиска
// и отправки: ни текстом, ни временем ответа нельзя выяснить, зарегистрирована
// ли почта. Ссылка живёт час и срабатывает один раз; в базе — только хеш
// токена. После смены пароля все прежние сессии человека закрываются: если
// пароль сменили из-за чужого входа, чужой вход тоже заканчивается.
//
// Без настроенной почты (utils/mail.js) маршрутов нет вовсе, а на странице
// входа нет ссылки «Забыли пароль?».

const crypto = require('crypto');
const mongoose = require('mongoose');
const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { authLimiter, resetLimiter } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
const User = require('../models/User');
const { PASSWORD_PROVIDER, PASSWORD_MIN, PASSWORD_MAX, hashPassword } = require('../utils/password');
const { mailConfigured, siteUrl, sendMail } = require('../utils/mail');
const { langOf, tr } = require('../utils/i18n');
const { audit } = require('../utils/audit');
const errorLog = require('../utils/errorLog');

const LINK_TTL_MS = 60 * 60 * 1000;
const RESEND_AFTER_MS = 60 * 1000;
const TOKEN = /^[\w-]{43}$/; // 32 байта в base64url

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function findByToken(token) {
  if (!TOKEN.test(token)) return null;
  return User.findOne({
    provider: PASSWORD_PROVIDER,
    'passwordReset.tokenHash': hashToken(token),
    'passwordReset.expiresAt': { $gt: new Date() },
  });
}

// Письмо — простой текст и та же разметка абзацами. Строки — ключи
// серверного словаря (utils/i18n.js): в браузерные словари письма не попадают.
function letter(lang, paragraphs, link) {
  const text = paragraphs.map((p) => tr(lang, p, { link })).join('\n\n');
  const html = paragraphs
    .map((p) => '<p>' + tr(lang, p, { link: `<a href="${link}">${link}</a>` }) + '</p>')
    .join('');
  return { subject: tr(lang, 'Восстановление пароля Takebana'), text, html };
}

async function sendResetLetter(email, lang) {
  const users = await User.find({ email }).select('provider passwordReset');
  const user = users.find((u) => u.provider === PASSWORD_PROVIDER) || users[0];
  if (!user) return;

  const now = Date.now();
  const last = user.passwordReset && user.passwordReset.requestedAt;
  if (last && now - last.getTime() < RESEND_AFTER_MS) return; // не забрасываем ящик письмами

  if (user.provider !== PASSWORD_PROVIDER) {
    // На эту почту есть только вход через Google — пароля, который можно
    // сменить, нет. Молчать нельзя: человек так и не поймёт, почему не входит.
    user.passwordReset = { requestedAt: new Date(now) };
    await user.save();
    await sendMail({ to: email, ...letter(lang, [
      'Для этой почты на Takebana пароля нет: вход — через Google.',
      'Войти: {link}',
    ], siteUrl('/login')) });
    return;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  user.passwordReset = { tokenHash: hashToken(token), expiresAt: new Date(now + LINK_TTL_MS), requestedAt: new Date(now) };
  await user.save();
  await sendMail({ to: email, ...letter(lang, [
    'Кто-то — возможно, вы — попросил сменить пароль на Takebana для этой почты.',
    'Чтобы задать новый пароль, откройте ссылку. Она действует час и срабатывает один раз: {link}',
    'Если вы ничего не запрашивали, просто удалите письмо — пароль останется прежним.',
  ], siteUrl('/reset-password/' + token)) });
}

if (mailConfigured) {
  router.get('/forgot-password', (req, res) => {
    res.render('forgotPassword');
  });

  router.post('/forgot-password', resetLimiter, validate({
    email: { type: 'email', required: true, label: 'Почта' },
  }), (req, res) => {
    res.json({ message: 'Если учётная запись с этой почтой есть, мы отправили на неё письмо со ссылкой' });
    // Ответ одинаков и для несуществующей почты — в журнале же видно,
    // на какие адреса заказывают письма: это первый признак перебора.
    audit(req, 'auth.password.reset.request', { actorLogin: req.body.email });
    sendResetLetter(req.body.email, langOf(req)).catch((err) => errorLog.external(err, 'mail.passwordReset'));
  });

  // Токен в адресе: страница не кэшируется, а Referer наружу не уходит —
  // helmet ставит Referrer-Policy: no-referrer.
  router.get('/reset-password/:token', async (req, res) => {
    const user = await findByToken(req.params.token);
    res.set('Cache-Control', 'no-store').render('resetPassword', { valid: Boolean(user) });
  });

  router.post('/reset-password', authLimiter, validate({
    token: { type: 'string', required: true, max: 100, label: 'Ссылка' },
    password: { type: 'string', required: true, min: PASSWORD_MIN, max: PASSWORD_MAX, trim: false, label: 'Пароль' },
  }), async (req, res) => {
    const user = await findByToken(req.body.token);
    if (!user) {
      audit(req, 'auth.password.reset.done', { result: 'fail', meta: { reason: 'bad-token' } });
      return res.status(400).json({ message: 'Ссылка устарела или уже использована. Запросите новую' });
    }

    user.password = await hashPassword(req.body.password);
    user.passwordReset = undefined;
    await user.save();

    // Сессии хранит connect-mongodb-session в коллекции mySessions (config/session.js).
    await mongoose.connection.collection('mySessions').deleteMany({ 'session.userId': user._id.toString() });

    // Новая сессия, а не запись в прежнюю: идентификатор, известный до входа,
    // после входа не должен ничего значить.
    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    req.session.userId = user._id.toString();
    req.session.login = user.login || 'anon';
    audit(req, 'auth.password.reset.done', { actor: user });
    res.json({ message: 'Пароль изменён', redirectUrl: '/' });
  });
}

module.exports = router;
