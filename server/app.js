// Подключение необходимых модулей
const express = require('express');
const fs = require('fs');
const https = require('https');
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

// Allow selecting env file without editing code:
// - PowerShell:  $env:DOTENV_CONFIG_PATH="env/.env.prod"; npm start
// - CMD:         set DOTENV_CONFIG_PATH=env\.env.prod && npm start
// Fallback: root .env
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const { resolveWithin, isPlainFileName } = require('./utils/safePath');

// FFmpeg/FFprobe functionality removed
const Stream = require('./models/Stream');
const multer = require('multer');

const User = require('./models/User');
const Establishments = require('./models/Establishments');
const Rating = require('./models/Rating');
const passport = require('passport');
const mediaServer = require('./mediaServer');
const { activeStreams } = mediaServer;

const GoogleStrategy = require( 'passport-google-oauth2' ).Strategy;
// media server is initialized by requiring it above

const { Server } = require('socket.io');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

// Пути к сертификатам, которые вы создали с помощью OpenSSL
let options;
try {
  // Prefer env-provided paths, then fall back to common local locations.
  const keyCandidates = [
    process.env.SSL_KEY_PATH,
    path.join(__dirname, 'certs', 'localhost-key.pem'),
    'C:/openssl_certificates/localhost-key.pem'
  ].filter(Boolean);

  const certCandidates = [
    process.env.SSL_CERT_PATH,
    path.join(__dirname, 'certs', 'localhost.pem'),
    'C:/openssl_certificates/localhost.pem'
  ].filter(Boolean);

  const pickFirstReadable = (candidates) => {
    for (const p of candidates) {
      try {
        fs.accessSync(p, fs.constants.R_OK);
        return p;
      } catch (_) {}
    }
    return null;
  };

  const keyPath = pickFirstReadable(keyCandidates);
  const certPath = pickFirstReadable(certCandidates);

  if (!keyPath || !certPath) {
    throw new Error(
      `SSL files not found. Looked for key in: ${keyCandidates.join(', ')}; cert in: ${certCandidates.join(', ')}`
    );
  }

  options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
  console.log('HTTPS certificates loaded:', { keyPath, certPath });
} catch (error) {
  console.log('HTTPS certificates not found. HTTPS will be disabled.', error && error.message ? error.message : error);
  options = null;
}

var session = require('express-session');
var MongoDBStore = require('connect-mongodb-session')(session);

var store = new MongoDBStore({
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/webcabar',
    collection: 'mySessions'
});


// Прокси для HLS файлов от Node Media Server (порт 8000) через Express (порт 3000)
// Это решает проблему Mixed Content (HTTPS страница не может загружать HTTP ресурсы)
const http = require('http');

app.use('/live', (req, res, next) => {
  // Проксируем запросы к Node Media Server на порту 8000.
  // ВАЖНО: используем originalUrl, чтобы сохранить префикс `/live/...`,
  // иначе NodeMediaServer будет искать стрим по неверному streamPath.
  const targetUrl = `http://localhost:8000${req.originalUrl}`;
  console.log(`[Media Proxy] Proxying request: ${req.originalUrl} -> ${targetUrl}`);
  
  const proxyReq = http.get(targetUrl, (proxyRes) => {
    console.log(`[Media Proxy] Response status: ${proxyRes.statusCode} for ${req.originalUrl}`);
    
    // Если 404, логируем подробности
    if (proxyRes.statusCode === 404) {
      console.error(`[Media Proxy] 404 Not Found: ${targetUrl}`);
      console.error(`[Media Proxy] Check if Node Media Server is running and stream path is correct`);
    }
    
    // Копируем заголовки
    res.set({
      'Content-Type': proxyRes.headers['content-type'] || 'application/vnd.apple.mpegurl',
      'Cache-Control': proxyRes.headers['cache-control'] || 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range',
      'Accept-Ranges': 'bytes'
    });
    
    res.status(proxyRes.statusCode);
    
    // Пересылаем данные
    proxyRes.pipe(res);
    
    proxyRes.on('error', (err) => {
      console.error(`[HLS Proxy] Error in response stream:`, err.message);
    });
  });
  
  proxyReq.on('error', (err) => {
    console.error(`[Media Proxy] Error proxying ${req.originalUrl}:`, err.message);
    console.error(`[Media Proxy] Check if Node Media Server is running on port 8000`);
    if (!res.headersSent) {
      // Для live FLV часто "ошибка" означает, что поток ещё не опубликован,
      // или NMS перезапускается. Не хотим пугать 502 на клиенте.
      const isFlv = String(req.path || '').toLowerCase().endsWith('.flv');
      if (isFlv) {
        res.status(404).end();
      } else {
        res.status(502).json({ error: 'Media server unavailable', path: req.path, message: err.message });
      }
    }
  });
  
  req.on('aborted', () => {
    console.log(`[Media Proxy] Request aborted: ${req.originalUrl}`);
    proxyReq.abort();
  });
  
  // ВАЖНО: `.flv` — это долгоживущее соединение (live stream).
  // Таймауты подходят для плейлистов/сегментов, но ломают FLV.
  const isFlv = String(req.path || '').toLowerCase().endsWith('.flv');
  if (isFlv) {
    // Отключаем таймаут полностью для live FLV
    proxyReq.setTimeout(0);
    // Нельзя кэшировать live поток
    if (!res.headersSent) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  } else {
    // Таймаут для коротких запросов (HLS плейлист/сегменты)
    proxyReq.setTimeout(5000, () => {
      console.error(`[Media Proxy] Timeout for ${req.originalUrl}`);
      proxyReq.abort();
      if (!res.headersSent) {
        res.status(504).json({ error: 'Media server timeout', path: req.path });
      }
    });
  }
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
app.use(sessionMiddleware);

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
      console.log('=== Google Strategy Callback ===');
      console.log('Profile:', profile.id);
      console.log('Email:', profile.emails[0].value);
      console.log('Provider:', profile.provider);
    
      // здесь вы можете сохранить информацию профиля в базе данных
      // console.log(profile)
      const { id, emails, provider } = profile;
      const email = emails[0].value;

      let user = await User.findOne({ email: email, provider: provider });

      if (!user) {
          user = new User({
              email: email,
              password: id, // используем id как пароль
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

passport.serializeUser(function(user, done) {
  done(null, user.id);
});

passport.deserializeUser(function(id, done) {
  User.findById(id, function(err, user) {
      done(err, user);
  });
});


const requireGoogleOAuth = (req, res, next) => {
    if (!googleOAuthConfigured) {
        return res.status(503).send('Вход через Google не настроен на этом сервере.');
    }
    next();
};

app.get('/auth/google', requireGoogleOAuth, (req, res, next) => {
    console.log('=== Google OAuth Initiated ===');
    console.log('Client ID:', process.env.GOOGLE_CLIENT_ID);
    console.log('Callback URL:', process.env.CALLBACKURL);
    console.log('Full URL:', req.protocol + '://' + req.get('host') + req.originalUrl);
    next();
}, passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  requireGoogleOAuth,
  (req, res, next) => {
    console.log('=== Google OAuth Callback Started ===');
    console.log('Request URL:', req.url);
    console.log('Request method:', req.method);
    console.log('Request headers:', req.headers);
    next();
  },
  passport.authenticate('google', { failureRedirect: '/login' }),
  async function(req, res) {
    console.log('=== After passport.authenticate ===');
    console.log('User object:', req.user);
    console.log('Session:', req.session);
    console.log('=== After passport.authenticate ===');
    console.log('User object:', req.user);
    console.log('Session:', req.session);

      console.log('Google callback received:', req.user);
      
      const { id, emails, provider } = req.user;
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

require('./db');

app.use(express.json());
app.use(require('./routes/userRoutes'));
app.use(require('./routes/establishmentsRouter'));
app.use(require('./routes/adminRouter'));
app.use(require('./routes/streamingRouter'));

// Daily.co API роуты
app.use('/api', require('./routes/dailyApiRoutes'));
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
// /uploads/... раздаётся строкой выше из public/uploads. Отдельный монтаж
// express.static('uploads') убран: путь считался от рабочего каталога процесса,
// а не от папки проекта, и такой папки в проекте нет — фото заведений теперь
// тоже лежат в public/uploads/establishments.

// Установка пути к папке с шаблонами
app.set('views', path.join(__dirname, '/views'));

// ===== Presence API =====
app.get('/api/presence', async (req, res) => {
  try {
    const ids = (req.query.ids || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (!ids.length) return res.json({ users: [] });
    const users = await User.find({ _id: { $in: ids } }, { _id: 1, isOnline: 1, lastSeen: 1 }).lean();
    res.json({ users });
  } catch (e) {
    console.error('presence api error', e);
    res.status(500).json({ error: 'presence_failed' });
  }
});

// ===== Call API (create outgoing call) =====
app.post('/api/calls/create', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const callerId = String(req.session.userId);
    const { calleeId, type } = req.body || {};
    if (!calleeId || !type) return res.status(400).json({ error: 'bad_request' });
    const callId = uuidv4();
    // obtain shared objects from app context
    const io = req.app.get('io');
    const pendingCalls = req.app.get('pendingCalls');
    console.log('[call] create', callId, { callerId, calleeId, type, hasIO: !!io, hasStore: !!pendingCalls });
    if (pendingCalls) {
      pendingCalls.set(callId, { callerId, calleeId: String(calleeId), type, createdAt: Date.now() });
    }
    // user info
    const caller = await User.findById(callerId).lean();
    const displayName = caller?.login || (caller?.email ? caller.email.split('@')[0] : 'Пользователь');
    const avatarUrl = caller?.avatar || null;
    // notify callee via socket room
    if (io) {
      console.log('[call] notify callee room', `user:${calleeId}`);
      io.to(`user:${calleeId}`).emit('incoming_call', { callId, type, from: { userId: callerId, displayName, avatarUrl } });
      setTimeout(() => {
        if (pendingCalls && pendingCalls.has(callId)) {
          console.log('[call] timeout', callId);
          io.to(`user:${callerId}`).emit('call:timeout', { callId });
          io.to(`user:${calleeId}`).emit('call:timeout', { callId });
          pendingCalls.delete(callId);
        }
      }, 30000);
    } else {
      console.warn('[call] io not available in route');
    }
    res.json({ success: true, callId });
  } catch (e) {
    console.error('create call error', e);
    res.status(500).json({ error: 'call_create_failed' });
  }
});

function checkLoggedIn(req, res, next) {
  if (!req.session.login) {
    res.redirect('/login');
  } else {
    next();
  }
}

// Определение маршрута
app.get('/', (req, res) => {
  let userLoggedIn = !!req.session.login;
  if (userLoggedIn) {
      let nextRoute = req.session.next || 'default';
      let redirectUrl = '/main'; // Значение по умолчанию
      if (nextRoute === 'service1' || nextRoute === 'default') {
          redirectUrl = '/main';
      } else if (nextRoute === 'service2') {
          redirectUrl = '/streaming';
      }
      res.redirect(redirectUrl);
  } 
  else {
      res.render('index', { title: 'Главная страница', userLoggedIn: userLoggedIn });
  }
});

app.get('/about', async (req, res) => {
  res.render('about', { title: 'О сервисе Takebana'});
});

app.get('/panel', async (req, res) => {
  if (req.session && req.session.userId) {
      const user = await User.findById(req.session.userId);
      if (user && (user.role === 'admin' || user.role === 'moderator')) {
          res.render('admin', { title: 'Панель администрирования'});
      } else {
          res.redirect('/main'); // Редирект на домашнюю страницу
      }
  } else {
      res.redirect('/main'); // Редирект на домашнюю страницу
  }
});

app.get('/login', (req, res) => {
  if (req.session && req.session.login) {
    let nextRoute = req.session.next || 'default';
      let redirectUrl = '/main'; // Значение по умолчанию
      if (nextRoute === 'service1' || nextRoute === 'default') {
          redirectUrl = '/main';
      } else if (nextRoute === 'service2') {
          redirectUrl = '/streaming';
      }
      res.redirect(redirectUrl);
  } else {
    res.render('login', { title: 'Главная страница', userLoggedIn: !!req.session.login });
  }
});

app.get('/register', (req, res) => {
  if (req.session && req.session.login) {
    let nextRoute = req.session.next || 'default';
      let redirectUrl = '/main'; // Значение по умолчанию
      if (nextRoute === 'service1' || nextRoute === 'default') {
          redirectUrl = '/main';
      } else if (nextRoute === 'service2') {
          redirectUrl = '/streaming';
      }
      res.redirect(redirectUrl);
  } else {
    res.render('register', { title: 'Главная страница', userLoggedIn: !!req.session.login });
  }
});

app.get('/company-register', (req, res) => {
  let userLoggedIn = !!req.session.login;
  res.render('newCompany.ejs', { title: 'Главная страница', userLoggedIn: userLoggedIn });
});


app.get('/main', checkLoggedIn, async (req, res) => {
  const userId = req.session.userId;
  // Найти пользователя по ID
  const user = await User.findById(userId);
  if (!user) {
    return res.status(400).json({ message: 'User not found' });
  }
  const userLogin = user ? user.login : '';
  // Найти все заведения, принадлежащие пользователю
  const establishments = await Establishments.find({ owner: userId });
  // Проверить, есть ли у пользователя зарегистрированные заведения
  const hasEstablishments = establishments.length > 0;
  res.render('map', { title: 'map', userLogin: userLogin, hasEstablishments: hasEstablishments, userId: userId });
});


app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.redirect('/');
    }
    res.clearCookie('connect.sid'); // имя по умолчанию у express-session, было 'sid'
    res.redirect('/');
  });
});


// Папка для хранения потоков
const STREAMS_DIR = path.join(__dirname, 'streams');
if (!fs.existsSync(STREAMS_DIR)) {
  fs.mkdirSync(STREAMS_DIR);
}

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Настройка раздачи статических файлов с правильными заголовками
app.use('/streams', (req, res, next) => {
  if (req.path.endsWith('.mp4')) {
    res.set({
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-cache',
      'Accept-Ranges': 'bytes'
    });
  }
  next();
}, express.static(STREAMS_DIR));

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      if (!req.session || !req.session.userId) {
        return cb(new Error('Пользователь не авторизован'));
      }

      const user = await User.findById(req.session.userId);
      if (!user) {
        return cb(new Error('Пользователь не найден'));
      }

      const streamKey = user.streamKey;
      if (!streamKey) {
        return cb(new Error('У пользователя нет streamKey'));
      }

      const streamPath = path.join(STREAMS_DIR, streamKey);
      if (!fs.existsSync(streamPath)) {
        fs.mkdirSync(streamPath, { recursive: true });
      }
      cb(null, streamPath);
    } catch (err) {
      console.error('Ошибка настройки папки для сегментов:', err);
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const originalExtension = path.extname(file.originalname).toLowerCase();
    const extension = originalExtension || '.webm'; // Если расширение отсутствует, задаем .webm
    cb(null, `segment_${timestamp}${extension}`);
  },
});

const upload = multer({ storage });


// Здесь лежали updateM3U8Playlist, cleanupOldSegments, deleteOldSegments и
// deleteOldTSSegments — 152 строки, которые никто не вызывал: нарезку и
// плейлисты делает node-media-server, а живые функции — в utils/playlistUtils.js.

// Роут для получения списка сегментов (старый формат с query параметром)
app.get('/segments', (req, res) => {
  // Получаем streamKey из параметров запроса
  const streamKey = req.query.streamKey;

  if (!streamKey) {
    return res.status(400).json({ error: 'streamKey обязателен' });
  }

  const streamPath = path.join(STREAMS_DIR, streamKey);

  if (!fs.existsSync(streamPath)) {
    return res.status(404).json({ error: 'Stream not found' });
  }

  try {
    const files = fs.readdirSync(streamPath)
      .filter(file => file.endsWith('.mp4'))
      .map(file => ({
        file,
        time: fs.statSync(path.join(streamPath, file)).mtime.getTime()
      }))
      .sort((a, b) => a.time - b.time)
      .map(f => f.file);

    res.json({
      status: 'success',
      segments: files,
      streamKey: streamKey
    });
  } catch (err) {
    console.error('Ошибка при получении сегментов:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Роут для получения списка сегментов (новый формат с параметром в URL)
app.get('/segments/:streamKey', (req, res) => {
  const streamKey = req.params.streamKey;
  // Express раскодирует %2F в параметре, поэтому сюда приходило `../..`
  // и листался произвольный каталог. Ключ — всегда одно имя папки.
  if (!isPlainFileName(streamKey)) {
    return res.status(400).json({ error: 'Некорректный streamKey' });
  }
  const streamPath = path.join(STREAMS_DIR, streamKey);

  if (!fs.existsSync(streamPath)) {
    return res.status(404).json({ error: 'Stream not found' });
  }

  try {
    const files = fs.readdirSync(streamPath)
      .filter(file => file.endsWith('.mp4') || file.endsWith('.webm'))
      .map(file => ({
        filename: file,
        time: fs.statSync(path.join(streamPath, file)).mtime.getTime()
      }))
      .sort((a, b) => a.time - b.time);

    console.log(`Найдено ${files.length} сегментов для стрима ${streamKey}`);
    res.json(files);
  } catch (err) {
    console.error('Ошибка при получении сегментов:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Роут для получения конкретного сегмента
app.get('/segment/:streamKey/:filename', (req, res) => {
  const { streamKey, filename } = req.params;

  // Прежняя проверка сравнивала filePath с streamPath, а streamPath сам
  // собирался из streamKey — достаточно было `..%2Fpublic`, и отдавался файл
  // вне папки трансляций. Воспроизводилось. Оба сегмента пути — простые имена.
  if (!isPlainFileName(streamKey) || !isPlainFileName(filename)) {
    return res.status(400).json({ error: 'Некорректный путь' });
  }

  const streamPath = path.join(STREAMS_DIR, streamKey);
  const filePath = resolveWithin(streamPath, filename);

  // Проверяем что файл существует и находится в правильной папке
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Segment not found' });
  }

  // Проверяем что это поддерживаемый формат видео
  if (!filename.endsWith('.mp4') && !filename.endsWith('.webm')) {
    return res.status(400).json({ error: 'Invalid file format' });
  }

  try {
    // Устанавливаем правильные заголовки для видео
    const contentType = filename.endsWith('.webm') ? 'video/webm' : 'video/mp4';
    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Accept-Ranges': 'bytes'
    });

    console.log(`Отправляем сегмент: ${filename} (${contentType})`);
    
    // Отправляем файл
    res.sendFile(filePath);
  } catch (err) {
    console.error('Ошибка при отправке сегмента:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ========== HLS РОУТЫ ==========

// Роут для получения HLS плейлиста (.m3u8)
app.get('/hls/:streamKey/playlist.m3u8', (req, res) => {
  const { streamKey } = req.params;
  if (!isPlainFileName(streamKey)) {
    return res.status(400).json({ error: 'Некорректный streamKey' });
  }
  const streamPath = path.join(STREAMS_DIR, streamKey);
  const playlistPath = path.join(streamPath, 'playlist.m3u8');

  // Проверяем что плейлист существует
  if (!fs.existsSync(playlistPath)) {
    return res.status(404).json({ error: 'Playlist not found' });
  }

  try {
    // Устанавливаем правильные заголовки для M3U8
    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range'
    });

    console.log(`📋 Отправляем плейлист: ${streamKey}/playlist.m3u8`);
    
    // Отправляем плейлист
    res.sendFile(playlistPath);
  } catch (err) {
    console.error('❌ Ошибка при отправке плейлиста:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Роут для получения HLS сегментов (.ts)
app.get('/hls/:streamKey/:filename', (req, res) => {
  const { streamKey, filename } = req.params;

  // Тот же обход пути, что и в /segment/:streamKey/:filename
  if (!isPlainFileName(streamKey) || !isPlainFileName(filename)) {
    return res.status(400).json({ error: 'Некорректный путь' });
  }

  const streamPath = path.join(STREAMS_DIR, streamKey);
  const filePath = resolveWithin(streamPath, filename);

  // Проверяем что файл существует и находится в правильной папке
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Segment not found' });
  }

  // Проверяем что это TS файл
  if (!filename.endsWith('.ts')) {
    return res.status(400).json({ error: 'Invalid file format, expected .ts' });
  }

  try {
    // Устанавливаем правильные заголовки для TS сегментов
    res.set({
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'max-age=3600', // Кешируем TS сегменты на час
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range'
    });

    console.log(`🎬 Отправляем TS сегмент: ${filename}`);
    
    // Отправляем TS файл
    res.sendFile(filePath);
  } catch (err) {
    console.error('❌ Ошибка при отправке TS сегмента:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ========== КОНЕЦ HLS РОУТОВ ==========

// Роут для очистки папки сегментов при запуске веб-стрима
app.post('/clear-segments', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ message: 'Пользователь не авторизован' });
  }

  const { streamKey } = req.body;

  if (!streamKey) {
    return res.status(400).json({ message: 'streamKey обязателен' });
  }

  try {
    // Получение пользователя и проверка что streamKey принадлежит ему
    const user = await User.findById(req.session.userId);
    if (!user) {
      return res.status(404).json({ message: 'Пользователь не найден' });
    }

    if (user.streamKey !== streamKey) {
      return res.status(403).json({ message: 'Доступ запрещен: streamKey не принадлежит пользователю' });
    }

    const streamPath = path.join(STREAMS_DIR, streamKey);

    // Проверяем что папка существует
    if (!fs.existsSync(streamPath)) {
      console.log(`Папка сегментов не существует: ${streamPath}`);
      return res.status(200).json({ 
        message: 'Папка сегментов уже пуста (папка не существует)',
        cleared: 0 
      });
    }

    // Читаем содержимое папки
    const files = fs.readdirSync(streamPath);
    let clearedCount = 0;

    // Удаляем все файлы в папке
    for (const file of files) {
      const filePath = path.join(streamPath, file);
      try {
        // Проверяем что это файл (не папка)
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
          fs.unlinkSync(filePath);
          clearedCount++;
          console.log(`Удален файл: ${file}`);
        }
      } catch (fileErr) {
        console.warn(`Не удалось удалить файл ${file}:`, fileErr.message);
      }
    }

    console.log(`🧹 Очищена папка сегментов для стрима ${streamKey}: удалено ${clearedCount} файлов`);

    // Сбрасываем счетчик сегментов для этого стрима при очистке
    if (!global.streamSegmentCounters) {
      global.streamSegmentCounters = {};
    }
    global.streamSegmentCounters[streamKey] = 0;
    console.log(`🔄 Сброшен счетчик сегментов для стрима ${streamKey}`);

    res.status(200).json({
      message: 'Папка сегментов успешно очищена',
      streamKey: streamKey,
      cleared: clearedCount
    });

  } catch (err) {
    console.error('Ошибка при очистке папки сегментов:', err);
    res.status(500).json({
      message: 'Ошибка сервера при очистке папки сегментов',
      error: err.message
    });
  }
});


// // Замените на свои рабочие TURN-серверы!
//     urls: 'turn:turn.example.com:3478',
//     username: 'testuser',
//     credential: 'testpass'
//     // Сырой видео-поток
//     '-f', 'rawvideo',
//     '-pix_fmt', 'yuv420p',
//     '-s', '320x240',
//     '-vsync', '0',
//     '-i', 'pipe:0',

//     // Кодировать в H.264
//     '-c:v', 'libx264',
//     '-preset', 'ultrafast',
//     '-tune', 'zerolatency',
//     '-profile:v', 'baseline',
//     '-x264-params', 'scenecut=0:force-cfr=1',
//     '-b:v', '500k',
//     '-bufsize', '500k',
//     '-maxrate', '500k',
//     '-g', '10',
//     '-keyint_min', '10',

//     // Выдаём HLS
//     '-f', 'hls',
//     '-hls_time', '2',
//     '-hls_list_size', '3',
//     '-hls_flags', 'delete_segments+omit_endlist',
//     '-hls_segment_type', 'mpegts',
//     '-hls_segment_filename', segmentPath,
//     playlistPath

//     // Закрываем старое соединение, если было

//     // Создаём новое WebRTC соединение
//     peerConnection = new wrtc.RTCPeerConnection({
//       iceServers: ICE_SERVERS
//           candidate: event.candidate.candidate,
//           sdpMid: event.candidate.sdpMid,
//           sdpMLineIndex: event.candidate.sdpMLineIndex

//     // Отправляем answer обратно клиенту


// API эндпоинт для проверки статуса стрима который через обс
app.get('/api/check-stream/:streamKey', (req, res) => {
  try {
      const { streamKey } = req.params;
      
      // Проверяем есть ли активный стрим с таким ключом
      const isStreamActive = activeStreams.has(streamKey);
      
      res.json({
          isLive: isStreamActive,
          streamKey: streamKey,
          timestamp: new Date()
      });

  } catch (error) {
      console.error('Error checking stream status:', error);
      res.status(500).json({
          error: 'Failed to check stream status',
          message: error.message
      });
  }
});


async function startServer() {
  // Ваш код сервера и socket.io
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


  // Настройка socket.io
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    },
    transports: ['websocket']
  });

  // ===== Socket.IO session reuse (используем общий sessionMiddleware) =====
  io.use((socket, next) => sessionMiddleware(socket.request, {}, next));
  io.use((socket, next) => {
    const userId = socket.request && socket.request.session && socket.request.session.userId;
    if (userId) socket.data.userId = String(userId);
    next();
  });

  const userConnections = new Map(); // userId -> count
  const userRooms = new Map(); // userId -> Set(socketIds)
  const pendingCalls = new Map(); // callId -> {callerId, calleeId, type, createdAt}
  const activeCalls = new Map(); // callId -> {callerId, calleeId, roomName, roomUrl, startedAt}

  // Make available to routes
  app.set('io', io);
  app.set('pendingCalls', pendingCalls);
  app.set('userRooms', userRooms);
  app.set('activeCalls', activeCalls);

  // Pass Socket.IO instance to NodeMediaServer hooks (OBS publish start/stop)
  try {
    if (mediaServer && typeof mediaServer.setIO === 'function') {
      mediaServer.setIO(io);
    }
  } catch (e) {
    console.warn('[mediaServer] setIO failed:', e?.message || e);
  }

  io.on('connection', async (socket) => {
    console.log('[socket] connected id=', socket.id, 'userId=', socket.data.userId);

    // Presence connect (только для аутентифицированных)
    try {
      const userId = socket.data.userId;
      if (userId) {
        socket.join(`user:${userId}`);
        const set = userRooms.get(userId) || new Set();
        set.add(socket.id);
        userRooms.set(userId, set);
        console.log('[socket] join room', `user:${userId}`, 'size=', set.size);
        const count = (userConnections.get(userId) || 0) + 1;
        userConnections.set(userId, count);
        if (count === 1) {
          await User.updateOne({ _id: userId }, { $set: { isOnline: true } });
          io.emit('presence:update', { userId, isOnline: true });
          console.log('[presence] user online', userId);
        }
      }
    } catch (e) {
      console.error('presence connect error:', e);
    }

    let currentStreamKey = null; 
    
    // Регистрируем обработчик сразу после подключения
    console.log('[socket] Registering join-stream-room handler for socket.id:', socket.id);
    
    // Простая логика: join в комнату стрима
    socket.on('join-stream-room', (streamKey, callback) => {
      console.log('[socket] ===== join-stream-room EVENT RECEIVED =====');
      console.log('[socket] streamKey:', streamKey, 'type:', typeof streamKey);
      console.log('[socket] socket.id:', socket.id);
      console.log('[socket] socket.connected:', socket.connected);
      
      if (!streamKey || streamKey === 'undefined' || streamKey === 'null' || streamKey === '') {
        console.error('[socket] ERROR: join-stream-room received with invalid streamKey:', streamKey);
        if (callback) callback({ error: 'Invalid streamKey' });
        return;
      }
      
      console.log('[socket] join-stream-room received, streamKey:', streamKey, 'socket.id:', socket.id);
      currentStreamKey = streamKey;
      const roomName = `stream:${streamKey}`;
      
      console.log('[socket] Joining room:', roomName);
      // Присоединяемся к комнате
      socket.join(roomName);
      console.log('[socket] Joined room:', roomName);
      
      // Небольшая задержка чтобы socket точно присоединился
      setTimeout(() => {
        // Получаем количество участников в комнате
        const room = io.sockets.adapter.rooms.get(roomName);
        const count = room ? room.size : 0;
        
        console.log('[socket] ===== ROOM STATUS =====');
        console.log('[socket] Room name:', roomName);
        console.log('[socket] Room exists:', !!room);
        console.log('[socket] Room size:', room ? room.size : 0);
        console.log('[socket] Socket ID:', socket.id);
        console.log('[socket] User ID:', socket.data.userId);
        
        if (room) {
          console.log('[socket] Room sockets:', Array.from(room));
        }
        
        console.log('[socket] ===== EMITTING VIEWERS COUNT =====');
        console.log('[socket] Emitting viewers-count-updated to room', roomName, 'with count', count);
        console.log('[socket] Data to emit:', { streamKey, count });
        
        // Отправляем обновленный счет всем в комнате (включая стримера)
        io.to(roomName).emit('viewers-count-updated', { streamKey, count });
        
        console.log('[socket] ===== EMIT COMPLETE =====');
        
        if (callback) {
          callback({ success: true, count });
        }
      }, 100);
    });

    socket.on('disconnect', async () => {
      console.log('[socket] disconnected id=', socket.id, 'userId=', socket.data.userId);

      // Если был в комнате стрима, обновляем счет
      if (currentStreamKey) {
        const roomName = `stream:${currentStreamKey}`;
        
        // Небольшая задержка чтобы socket точно покинул комнату
        setTimeout(() => {
          const room = io.sockets.adapter.rooms.get(roomName);
          // Socket уже покинул комнату, поэтому просто берем размер
          const count = room ? room.size : 0;
          
          console.log('[socket] Room', roomName, 'now has', count, 'viewers after disconnect (socket.id:', socket.id, ')');
          
          // Отправляем обновленный счет всем в комнате
          io.to(roomName).emit('viewers-count-updated', { streamKey: currentStreamKey, count });
        }, 50);
      }

      // Presence disconnect + end call if active
      try {
        const userId = socket.data.userId;
        if (userId) {
          // завершение активных звонков, где этот user участник
          try {
            for (const [id, c] of pendingCalls.entries()) {
              if (c.callerId === userId || c.calleeId === userId) {
                io.to(`user:${c.callerId}`).emit('call:ended', { callId: id });
                io.to(`user:${c.calleeId}`).emit('call:ended', { callId: id });
                pendingCalls.delete(id);
              }
            }
            for (const [id, c] of activeCalls.entries()) {
              if (c.callerId === userId || c.calleeId === userId) {
                io.to(`user:${c.callerId}`).emit('call:ended', { callId: id });
                io.to(`user:${c.calleeId}`).emit('call:ended', { callId: id });
                activeCalls.delete(id);
              }
            }
          } catch(e) { console.error('[call] cleanup on disconnect', e); }
          const set = userRooms.get(userId) || new Set();
          if (set.has(socket.id)) set.delete(socket.id);
          if (set.size === 0) userRooms.delete(userId); else userRooms.set(userId, set);
          const cur = (userConnections.get(userId) || 1) - 1;
          if (cur <= 0) {
            userConnections.delete(userId);
            const lastSeen = new Date();
            await User.updateOne({ _id: userId }, { $set: { isOnline: false, lastSeen } });
            io.emit('presence:update', { userId, isOnline: false, lastSeen });
            console.log('[presence] user offline', userId, 'lastSeen=', lastSeen.toISOString());
          } else {
            userConnections.set(userId, cur);
          }
        }
      } catch (e) {
        console.error('presence disconnect error:', e);
      }

    });

    // Calls: accept/decline/cancel/end
    socket.on('call:accept', ({ callId }) => {
      const call = pendingCalls.get(callId);
      if (!call) return;
      console.log('[call] accept', callId, call);
      // mark as no longer pending to prevent timeout firing
      try { pendingCalls.delete(callId); } catch(e) {}
      // Create Daily room for active call (2 hours)
      (async () => {
        let roomName = null;
        let roomUrl = null;
        try {
          if (process.env.DAILY_API_KEY) {
            const r = await fetch('https://api.daily.co/v1/rooms', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DAILY_API_KEY}` },
              body: JSON.stringify({ name: `call_${callId}`, properties: { exp: Math.floor(Date.now()/1000)+7200, start_video_off: true, start_audio_off: false, enable_chat: false } })
            });
            const j = await r.json();
            if (j && j.name) { roomName = j.name; roomUrl = j.url; }
            console.log('[daily] active room created', roomName);
          }
        } catch (e) { console.error('[daily] active room create error', e); }

        activeCalls.set(callId, { callerId: call.callerId, calleeId: call.calleeId, roomName, roomUrl, startedAt: Date.now() });
        io.to(`user:${call.callerId}`).emit('call:accepted', { callId, type: call.type, calleeId: call.calleeId, callerId: call.callerId, daily: { roomName, roomUrl } });
        io.to(`user:${call.calleeId}`).emit('call:accepted', { callId, type: call.type, calleeId: call.calleeId, callerId: call.callerId, daily: { roomName, roomUrl } });
      })();
    });

    socket.on('call:decline', ({ callId }) => {
      const call = pendingCalls.get(callId);
      if (!call) return;
      console.log('[call] decline', callId, call);
      io.to(`user:${call.callerId}`).emit('call:declined', { callId });
      pendingCalls.delete(callId);
    });

    socket.on('call:cancel', ({ callId }) => {
      const call = pendingCalls.get(callId);
      if (!call) return;
      console.log('[call] cancel', callId, call);
      io.to(`user:${call.calleeId}`).emit('call:canceled', { callId });
      pendingCalls.delete(callId);
    });

    socket.on('call:end', ({ callId }) => {
      const call = pendingCalls.get(callId);
      const active = activeCalls.get(callId);
      console.log('[call] end', callId, call || active);
      if (call) {
        io.to(`user:${call.callerId}`).emit('call:ended', { callId });
        io.to(`user:${call.calleeId}`).emit('call:ended', { callId });
        pendingCalls.delete(callId);
      }
      if (active) {
        io.to(`user:${active.callerId}`).emit('call:ended', { callId });
        io.to(`user:${active.calleeId}`).emit('call:ended', { callId });
        activeCalls.delete(callId);
      }
    });
  });

  // Теперь прослушивайте ваш IP и порт.
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
