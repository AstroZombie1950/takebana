// Смена и подтверждение почты.
//
//   POST /settings/email         { email, password } — письмо на новый адрес
//   GET  /confirm-email/:token   подтверждение: адрес меняется только здесь
//   POST /settings/email/verify  письмо для подтверждения нынешней почты
//   GET  /verify-email/:token    почта подтверждена
//   router.sendVerify(req, user) — то же письмо сразу после регистрации
//
// Механика — как у восстановления пароля (routes/passwordReset.js): в базе
// хеш токена, ссылка живёт сутки и срабатывает один раз, повторное письмо —
// не чаще раза в минуту. Старому адресу — уведомление: если почту меняет
// не хозяин, хозяин узнает. У входа через Google почта — от Google, здесь
// она не меняется.

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const bcrypt = require('bcrypt');
const { authLimiter } = require('../middleware/rateLimit');
const { requireAuthApi } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const User = require('../models/User');
const { PASSWORD_PROVIDER, PASSWORD_MAX } = require('../utils/password');
const { mailConfigured, siteUrl, sendMail } = require('../utils/mail');
const { langOf, tr } = require('../utils/i18n');
const { audit } = require('../utils/audit');
const errorLog = require('../utils/errorLog');

const LINK_TTL_MS = 24 * 3600 * 1000;
const RESEND_AFTER_MS = 60 * 1000;
const TOKEN = /^[\w-]{43}$/; // 32 байта в base64url

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function letter(lang, subject, paragraphs, vars) {
  const text = paragraphs.map((p) => tr(lang, p, vars)).join('\n\n');
  const html = paragraphs.map((p) => '<p>' + tr(lang, p, {
    ...vars, link: vars.link ? `<a href="${vars.link}">${vars.link}</a>` : '',
  }) + '</p>').join('');
  return { subject: tr(lang, subject), text, html };
}

if (mailConfigured) {
  router.post('/settings/email', requireAuthApi, authLimiter, validate({
    email: { type: 'email', required: true, label: 'Почта' },
    password: { type: 'string', required: true, max: PASSWORD_MAX, trim: false, label: 'Пароль' },
  }), async (req, res) => {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ message: 'Необходима авторизация' });
    if ((user.provider || '') !== PASSWORD_PROVIDER) {
      return res.status(400).json({ message: 'Почта входа через Google меняется в аккаунте Google' });
    }
    const email = req.body.email.toLowerCase();
    if (email === String(user.email || '').toLowerCase()) {
      return res.status(400).json({ message: 'Это и есть ваша почта' });
    }
    if (!(await bcrypt.compare(req.body.password, user.password))) {
      audit(req, 'profile.email.request', { result: 'fail', targetType: 'user', target: user, meta: { reason: 'bad-password' } });
      return res.status(400).json({ message: 'Неверный пароль' });
    }
    if (await User.exists({ email, provider: PASSWORD_PROVIDER, _id: { $ne: user._id } })) {
      return res.status(400).json({ message: 'Эта почта уже занята другим аккаунтом' });
    }
    const last = user.emailChange && user.emailChange.requestedAt;
    if (last && Date.now() - last.getTime() < RESEND_AFTER_MS && user.emailChange.email === email) {
      return res.status(429).json({ message: 'Письмо уже отправлено. Повторить можно через минуту' });
    }

    const token = crypto.randomBytes(32).toString('base64url');
    user.emailChange = { email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + LINK_TTL_MS), requestedAt: new Date() };
    await user.save();

    const lang = langOf(req);
    await sendMail({ to: email, ...letter(lang, 'Подтвердите новую почту Takebana', [
      'Чтобы сделать этот адрес почтой вашего аккаунта Takebana, откройте ссылку. Она действует сутки: {link}',
      'Если вы ничего не меняли, просто удалите письмо.',
    ], { link: siteUrl('/confirm-email/' + token) }) });
    if (user.email) {
      sendMail({ to: user.email, ...letter(lang, 'Смена почты Takebana', [
        'В вашем аккаунте Takebana запросили смену почты на {email}. Почта сменится, только когда по ссылке из письма на новый адрес перейдут.',
        'Если это не вы — смените пароль: {link}',
      ], { email, link: siteUrl('/forgot-password') }) }).catch((e) => errorLog.external(e, 'mail.emailChange.notice'));
    }
    audit(req, 'profile.email.request', { targetType: 'user', target: user, meta: { to: email } });
    res.json({ message: 'Письмо со ссылкой отправлено на новую почту' });
  });

  // Токен в адресе: страница не кэшируется, Referer не уходит никуда
  // (сайту в целом разрешён strict-origin-when-cross-origin, app.js), Метрики
  // на ней нет (emailConfirm.ejs). Вход не нужен — ссылку часто открывают
  // на телефоне, где человек не вошёл.
  router.get('/confirm-email/:token', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const user = TOKEN.test(req.params.token) ? await User.findOne({
      'emailChange.tokenHash': hashToken(req.params.token),
      'emailChange.expiresAt': { $gt: new Date() },
    }) : null;
    if (!user) return res.render('emailConfirm', { state: 'invalid' });

    const email = user.emailChange.email;
    // Адрес мог занять кто-то другой, пока письмо шло.
    if (await User.exists({ email, provider: user.provider || PASSWORD_PROVIDER, _id: { $ne: user._id } })) {
      user.emailChange = undefined;
      await user.save();
      return res.render('emailConfirm', { state: 'taken' });
    }
    const was = user.email;
    user.email = email;
    user.emailChange = undefined;
    // Переход по ссылке с нового адреса — это и есть подтверждение.
    user.emailVerifiedAt = new Date();
    user.emailVerify = undefined;
    await user.save();
    audit(req, 'profile.email.change', { actor: user, targetType: 'user', target: user, meta: { was, now: email } });
    res.render('emailConfirm', { state: 'ok', email });
  });

  // Подтверждение нынешней почты. Ничего не запирает (решение 18.09.2026):
  // у аккаунтов с боя почта не подтверждена, и запри мы, например,
  // восстановление пароля — они остались бы без него.
  async function sendVerify(req, user) {
    const token = crypto.randomBytes(32).toString('base64url');
    user.emailVerify = { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + LINK_TTL_MS), requestedAt: new Date() };
    await user.save();
    await sendMail({ to: user.email, ...letter(langOf(req), 'Подтвердите почту Takebana', [
      'Чтобы подтвердить почту аккаунта Takebana, откройте ссылку. Она действует сутки: {link}',
      'Если вы не регистрировались на Takebana, просто удалите письмо.',
    ], { link: siteUrl('/verify-email/' + token) }) });
    audit(req, 'profile.email.verifyRequest', { actor: user, targetType: 'user', target: user });
  }
  router.sendVerify = sendVerify;

  router.post('/settings/email/verify', requireAuthApi, authLimiter, async (req, res) => {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ message: 'Необходима авторизация' });
    if (user.emailVerifiedAt || (user.provider || '') !== PASSWORD_PROVIDER) {
      return res.status(400).json({ message: 'Почта уже подтверждена' });
    }
    const last = user.emailVerify && user.emailVerify.requestedAt;
    if (last && Date.now() - last.getTime() < RESEND_AFTER_MS) {
      return res.status(429).json({ message: 'Письмо уже отправлено. Повторить можно через минуту' });
    }
    await sendVerify(req, user);
    res.json({ message: 'Письмо со ссылкой отправлено' });
  });

  // Токен в адресе — как у /confirm-email выше.
  router.get('/verify-email/:token', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const user = TOKEN.test(req.params.token) ? await User.findOne({
      'emailVerify.tokenHash': hashToken(req.params.token),
      'emailVerify.expiresAt': { $gt: new Date() },
    }) : null;
    if (!user) return res.render('emailConfirm', { state: 'invalid' });
    user.emailVerifiedAt = new Date();
    user.emailVerify = undefined;
    await user.save();
    audit(req, 'profile.email.verify', { actor: user, targetType: 'user', target: user });
    res.render('emailConfirm', { state: 'verified', email: user.email });
  });
}

module.exports = router;
