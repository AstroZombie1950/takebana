// Сессии: хранилище в MongoDB и middleware.
//
// Один и тот же экземпляр нужен и Express, и Socket.IO — иначе сокет не увидит
// вошедшего пользователя. Поэтому модуль отдаёт готовый middleware, а не
// собирает его дважды.

var session = require('express-session');
var MongoDBStore = require('connect-mongodb-session')(session);

var store = new MongoDBStore({
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/webcabar',
    collection: 'mySessions'
});

// Catch errors
store.on('error', function(error) {
    console.log(error);
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
      maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
      httpOnly: true,          // cookie не читается из JavaScript
      sameSite: 'lax',         // базовая защита от CSRF на сторонних сайтах
      // За nginx TLS терминируется там, поэтому secure включаем в режиме prod
      secure: process.env.START_SERVER === 'prod'
    },
    store: store,
    resave: true,
    // false: иначе строка в базе заводилась на каждого анонимного посетителя
    // и коллекция сессий росла от роботов. Вход всё равно пишет в сессию сам.
    saveUninitialized: false
});

module.exports = { sessionMiddleware, store };
