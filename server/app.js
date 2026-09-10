// Переменные окружения — первой строкой, до любого чтения process.env.
//
// Раньше dotenv грузился на 70 строк ниже, уже после проверки START_SERVER,
// и та всегда видела пустое значение: trust proxy не включался, а cookie
// сессии всё равно получала флаг Secure — её выставляет config/session.js,
// который грузится позже и значение уже видит. Итог: /login отвечает 200,
// Set-Cookie не приходит, войти не может никто. Порядок здесь — поведение.
//
// Путь можно переопределить: DOTENV_CONFIG_PATH=env/.env.prod npm start
// quiet: dotenv 17 иначе печатает рекламную строку при каждой загрузке.
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });

// Подключение необходимых модулей
const express = require('express');
const app = express();
const { asyncify } = require('./middleware/asyncRouter');
asyncify(app); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const helmet = require('helmet');

// Заголовки безопасности. Content-Security-Policy намеренно выключен:
// в шаблонах сотни инлайновых <script> и <style> плюс десяток внешних CDN,
// строгая политика сейчас просто сломает страницы. Включать её осмысленно
// после смены вёрстки — тогда же перечислить источники.
app.use(helmet({
    contentSecurityPolicy: false,
    // плеер и картинки забираются со стороннего домена, изоляция их ломает
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// Проверка живости для деплоя, pm2 и внешнего мониторинга.
//
// Стоит до сессий и до статики: маршрут должен отвечать, даже когда база лежит,
// иначе по нему нельзя отличить «процесс умер» от «процесс жив, Mongo недоступна».
// Именно это различие и решает, откатывать деплой или чинить базу.
app.get('/healthz', (req, res) => {
    // 1 = connected. Значения: 0 disconnected, 1 connected, 2 connecting, 3 disconnecting.
    const state = require('mongoose').connection.readyState;
    res.set('Cache-Control', 'no-store').json({
        status: 'ok',
        db: state === 1 ? 'connected' : 'down',
        uptime: Math.round(process.uptime()),
    });
});

// За nginx настоящий адрес клиента приходит в X-Forwarded-For.
// Без этого счётчик попыток входа считал бы все запросы за один адрес.
if (process.env.START_SERVER === 'prod') {
    app.set('trust proxy', 1);

    // Диагностика молчаливой поломки входа.
    //
    // В этом режиме сессионная cookie выставляется с флагом Secure, а
    // express-session не отдаёт такую cookie, пока не увидит HTTPS. Видит он
    // его только через X-Forwarded-Proto от nginx. Если заголовок забыли —
    // /login отвечает 200, Set-Cookie не приходит, и войти не может никто,
    // причём в логах не появляется ни одной ошибки.
    //
    // Готовый конфиг с этим заголовком: ops/nginx/proxy_params_takebana.
    let proxyHeaderWarned = false;
    app.use((req, res, next) => {
        if (!proxyHeaderWarned && !req.secure) {
            proxyHeaderWarned = true;
            console.error(
                '[proxy] Запрос пришёл без признака HTTPS: X-Forwarded-Proto = ' +
                (req.headers['x-forwarded-proto'] || 'не задан') + '. ' +
                'В режиме prod это значит, что сессионная cookie с флагом Secure ' +
                'не будет выдана и вход не заработает ни у кого. ' +
                'Добавьте в nginx: proxy_set_header X-Forwarded-Proto $scheme;'
            );
        }
        next();
    });
}

const path = require('path');



const mediaServer = require('./mediaServer');

// media server is initialized by requiring it above

// ── Сборка приложения ────────────────────────────────────────────────────────
//
// Порядок здесь — это поведение, а не оформление. Что важно не переставлять:
//   /live  — до сессий: поток видео в них не нуждается, а разбор cookie
//            на каждом сегменте бесплатным не бывает;
//   статика — после маршрутов страниц, иначе файл с совпадающим именем
//            перехватил бы страницу;
//   сокеты — после создания http-сервера, они живут на нём же.

const https = require('https');
const { Server } = require('socket.io');
const { readTlsOptions } = require('./config/tls');
const { sessionMiddleware } = require('./config/session');
const { liveProxy } = require('./routes/liveProxy');
const { router: googleRouter, googleOAuthConfigured } = require('./auth/google');
const { registerSockets } = require('./sockets');

const options = readTlsOptions();

app.use('/live', liveProxy);
app.use(sessionMiddleware);

// Без ключей маршрут /auth/google отвечает 503, поэтому кнопка «Continue with
// Google» на страницах входа и регистрации не показывается вовсе: нерабочая
// кнопка хуже отсутствующей.
app.locals.googleOAuthConfigured = googleOAuthConfigured;
app.use(googleRouter);

require('./db');

app.use(express.json());
app.use(require('./routes/userRoutes'));
app.use(require('./routes/establishmentsRouter'));
app.use(require('./routes/adminRouter'));
app.use(require('./routes/streaming'));
app.use(require('./routes/moderation'));

// Daily.co API роуты
app.use('/api', require('./routes/dailyApiRoutes'));

app.set('view engine', 'ejs');
// Установка пути к папке с шаблонами
app.set('views', path.join(__dirname, '/views'));

// Браузер просит /favicon.ico сам, на каждой странице. Файла не было — значит
// 404 в логах и лишний запрос при каждой загрузке у каждого посетителя.
// Отдаём SVG: 288 байт против килобайтов у .ico, и общего <head> в шаблонах нет,
// так что одним маршрутом это решается для всех страниц сразу.
app.get('/favicon.ico', (req, res) => {
    res.type('image/svg+xml')
       .set('Cache-Control', 'public, max-age=604800')
       .sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

// Шрифты стоят отдельным монтажом до общей статики только ради кэша: файл под
// своим именем не меняется никогда, поэтому год и immutable — браузер не пойдёт
// даже за 304. На проде их отдаёт nginx, здесь это для локальной разработки.
app.use('/fonts', express.static(path.join(__dirname, 'public', 'fonts'), {
    maxAge: '1y',
    immutable: true,
}));

app.use(express.static(path.join(__dirname, 'public')));
// /uploads/... раздаётся строкой выше из public/uploads. Отдельный монтаж
// express.static('uploads') убран: путь считался от рабочего каталога процесса,
// а не от папки проекта, и такой папки в проекте нет — фото заведений теперь
// тоже лежат в public/uploads/establishments.

// Брошенные эфиры: раньше таймер стартовал сам, фактом подключения роутера.
require('./jobs/streamCleanup').startStreamCleanup();

app.use(require('./routes/presence'));
app.use(require('./routes/calls'));
app.use(require('./routes/pages'));
app.use(require('./routes/streamStatus'));


async function startServer() {
  let server;

  if (process.env.START_SERVER == 'prod') {
    server = require('http').createServer(app);
  } else if (process.env.START_SERVER == 'local') {
    if (options) {
      server = https.createServer(options, app);
      console.log('HTTPS server started with SSL certificates');
    } else {
      console.log('HTTPS certificates not found, falling back to HTTP server');
      server = require('http').createServer(app);
    }
  } else if (process.env.START_SERVER == 'http') {
    server = require('http').createServer(app);
    console.log('HTTP server started (no SSL)');
  } else {
    // По умолчанию используем HTTP сервер
    server = require('http').createServer(app);
    console.log('HTTP server started (default mode)');
  }

  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    },
    transports: ['websocket']
  });

  // Сокеты читают ту же сессию, что и Express: иначе socket.data.userId
  // всегда пустой, а с ним не работают ни присутствие, ни звонки.
  io.use((socket, next) => sessionMiddleware(socket.request, {}, next));
  io.use((socket, next) => {
    const userId = socket.request && socket.request.session && socket.request.session.userId;
    if (userId) socket.data.userId = String(userId);
    next();
  });

  const { userRooms, pendingCalls, activeCalls } = registerSockets(io);

  // Общие хранилища — маршрутам: /api/calls/create кладёт заявку сюда же.
  app.set('io', io);
  app.set('pendingCalls', pendingCalls);
  app.set('userRooms', userRooms);
  app.set('activeCalls', activeCalls);

  // Хуки node-media-server шлют зрителям смену типа эфира при старте OBS.
  try {
    if (mediaServer && typeof mediaServer.setIO === 'function') {
      mediaServer.setIO(io);
    }
  } catch (e) {
    console.warn('[mediaServer] setIO failed:', e?.message || e);
  }

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server is running on port ${PORT}`);
    console.log(`📱 Local: http://localhost:${PORT}`);
    console.log(`🌐 Network: http://0.0.0.0:${PORT}`);
    if (process.env.START_SERVER === 'local' && options) {
      console.log(`🔒 HTTPS: https://localhost:${PORT}`);
    }
  });
}

startServer();
