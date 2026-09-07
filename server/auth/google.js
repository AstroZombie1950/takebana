// Вход через Google.
//
// Без ключей стратегия не регистрируется вовсе, а маршруты отвечают 503.
// Флаг googleOAuthConfigured уходит в app.locals: шаблоны прячут кнопку
// «Continue with Google», потому что нерабочая кнопка хуже отсутствующей.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth2').Strategy;
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const User = require('../models/User');

// Учётке из Google пароль не нужен: вход по паролю ищет по provider: '' и такую
// запись не найдёт никогда. Но поле в схеме есть, и раньше в него клали id
// профиля Google — значение не секретное, да ещё и в открытом виде, отчего
// выглядело как настоящий пароль. Кладём заведомо неподбираемый хеш.
const SALT_ROUNDS = 10;
async function unusablePassword() {
    return bcrypt.hash(crypto.randomBytes(32).toString('hex'), SALT_ROUNDS);
}

const googleOAuthConfigured = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.CALLBACKURL
);

if (googleOAuthConfigured) {
  passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.CALLBACKURL,
      scope: ['profile', 'email']
    },
    async function(accessToken, refreshToken, profile, done) {
      const { id, emails, provider } = profile;
      const email = emails[0].value;

      let user = await User.findOne({ email: email, provider: provider });

      if (!user) {
          user = new User({
              email: email,
              password: await unusablePassword(),
              provider: provider,
              login: '' // оставляем логин пустым
          });
          await user.save();
      }

      return done(null, profile);
    }
  ));
} else {
  console.warn('Google OAuth не настроен: нет GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / CALLBACKURL. Вход через Google отключён.');
}

// serializeUser/deserializeUser здесь не нужны и потому убраны: passport.initialize()
// и passport.session() нигде не подключены, сессию ставит сам колбэк ниже через
// req.session.userId. Прежний deserializeUser к тому же вызывал
// User.findById(id, callback), а Mongoose 7 колбэки не принимает — код молчал
// только потому, что никогда не выполнялся.


const requireGoogleOAuth = (req, res, next) => {
    if (!googleOAuthConfigured) {
        return res.status(503).send('Вход через Google не настроен на этом сервере.');
    }
    next();
};

router.get('/auth/google', requireGoogleOAuth,
  passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get('/auth/google/callback',
  requireGoogleOAuth,
  passport.authenticate('google', { failureRedirect: '/login' }),
  async function(req, res) {
      const { emails, provider } = req.user;
      const email = emails[0].value;

      // Найти пользователя по email и провайдеру
      let user = await User.findOne({ email: email, provider: provider });

    if (!user) {
      // Если пользователя нет в базе данных, это ошибка, потому что мы уже зарегистрировали пользователя ранее
      return res.status(400).json({ message: 'User not found' });
    }

    // Установить сессию пользователя
    req.session.userId = user._id.toString();
    req.session.login = user.login || 'anon'; // Если login не существует, используйте 'anon'

    // Успешная аутентификация, перенаправляем домой.
    res.redirect('/');
});

// Обмен кода на токен может не состояться: пользователь нажал «Назад» и код уже
// использован, код протух (Google даёт 10 минут), не отвечает token-эндпоинт.
// Passport отдаёт это как error, а не как failure, поэтому failureRedirect такое
// не ловит — и вместо возврата на вход пользователь получал 500.
// Обработчик не async: asyncify переписал бы его в трёхаргументный, и Express
// перестал бы считать его обработчиком ошибок.
router.use('/auth/google/callback', function (err, req, res, next) {
  console.warn('[google oauth] вход не состоялся:', err && err.message ? err.message : err);
  res.redirect('/login');
});

module.exports = { router, googleOAuthConfigured };
