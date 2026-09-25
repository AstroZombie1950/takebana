// Сессии: хранилище в MongoDB и middleware.
//
// Один и тот же экземпляр нужен и Express, и Socket.IO — иначе сокет не увидит
// вошедшего пользователя. Поэтому модуль отдаёт готовый middleware, а не
// собирает его дважды.

var session = require('express-session');
var mongoose = require('mongoose');
var { MongoStore } = require('connect-mongo');

// Хранилище — на клиенте mongoose: connect-mongodb-session тянул свой
// драйвер (mongodb 4, вне поддержки) со своим пулом соединений к той же
// базе. Формат строк прежний — объект, не JSON-строка (stringify: false):
// по session.userId сеансы ищут сброс пароля и удаление аккаунта.
// touch express-session зовёт на каждом запросе — с touchAfter он пишет
// в базу не чаще раза в сутки, как и keepAlive ниже.
// Модуль грузится раньше db.js, поэтому клиента ждём по событию open:
// asPromise() до mongoose.connect отдаёт соединение без клиента.
var connected = mongoose.connection.readyState === 1
    ? Promise.resolve()
    : new Promise((resolve) => mongoose.connection.once('open', resolve));
var store = MongoStore.create({
    clientPromise: connected.then(() => mongoose.connection.getClient()),
    collectionName: 'mySessions',
    stringify: false,
    touchAfter: 24 * 60 * 60
});

// В prod пустой SESSION_SECRET — это подделываемые сессии, поэтому падаем сразу,
// а не запускаемся с общеизвестным значением по умолчанию.
if (!process.env.SESSION_SECRET) {
  if (process.env.START_SERVER === 'prod' || process.env.NODE_ENV === 'production') {
    console.error('SESSION_SECRET не задан. Сгенерировать: openssl rand -hex 32');
    process.exit(1);
  }
  console.warn('SESSION_SECRET не задан — используется значение для разработки.');
}

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-only-change-me',
  name: 'connect.sid',
  cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 дней с последнего продления (keepAlive)
      httpOnly: true,          // cookie не читается из JavaScript
      sameSite: 'lax',         // базовая защита от CSRF на сторонних сайтах
      // За nginx TLS терминируется там, поэтому secure включаем в режиме prod
      secure: process.env.START_SERVER === 'prod'
    },
    store: store,
    // false: с true каждый запрос вошедшего — страница, API, статика —
    // был чтением и записью сессии в Mongo. Продление — keepAlive ниже.
    resave: false,
    // false: иначе строка в базе заводилась на каждого анонимного посетителя
    // и коллекция сессий росла от роботов. Вход всё равно пишет в сессию сам.
    saveUninitialized: false
});

// Продление сессии раз в сутки. Cookie раньше не продлевалась вовсе:
// человек вылетал через неделю после входа, даже заходя каждый день, —
// особенно неприятно в PWA на iPhone. Раз в сутки сессию меняем: изменённую
// express-session сохраняет сам, с новым сроком и в базе, и в cookie.
// rolling не нужен: он слал бы Set-Cookie в каждом ответе.
const DAY = 24 * 60 * 60 * 1000;
function keepAlive(req, res, next) {
  const s = req.session;
  if (s && s.userId && !(Date.now() - (s.renewedAt || 0) < DAY)) s.renewedAt = Date.now();
  next();
}

module.exports = { sessionMiddleware, keepAlive, store };
