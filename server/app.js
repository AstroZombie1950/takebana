// Подключение необходимых модулей
const express = require('express');
const fs = require('fs');
const https = require('https');
const app = express();
const path = require('path');
const { Transform, Writable } = require('stream');

let rtpPort = 5004; // Порт для RTP потока
// Allow selecting env file without editing code:
// - PowerShell:  $env:DOTENV_CONFIG_PATH="env/.env.prod"; npm start
// - CMD:         set DOTENV_CONFIG_PATH=env\.env.prod && npm start
// Fallback: root .env
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

// Импортируем утилиты для управления плейлистами
const { startPlaylistUpdates, stopPlaylistUpdates } = require('./utils/playlistUtils');

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

// Роут для страницы плеера
app.get('/stream', (req, res) => {
    res.render('stream');
});



// Catch errors
store.on('error', function(error) {
    console.log(error);
});

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-only-change-me',
  cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
    },
    store: store,
    resave: true,
    saveUninitialized: true
});
app.use(sessionMiddleware);

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

passport.serializeUser(function(user, done) {
  done(null, user.id);
});

passport.deserializeUser(function(id, done) {
  User.findById(id, function(err, user) {
      done(err, user);
  });
});


app.get('/auth/google', (req, res, next) => {
    console.log('=== Google OAuth Initiated ===');
    console.log('Client ID:', process.env.GOOGLE_CLIENT_ID);
    console.log('Callback URL:', process.env.CALLBACKURL);
    console.log('Full URL:', req.protocol + '://' + req.get('host') + req.originalUrl);
    next();
}, passport.authenticate('google', { scope: ['profile', 'email'] }));

// Тестовый роут для проверки
app.get('/test-callback', (req, res) => {
    console.log('=== Test Callback Route ===');
    console.log('Request URL:', req.url);
    console.log('Query params:', req.query);
    res.json({ message: 'Test callback route works!', query: req.query });
});

app.get('/auth/google/callback',
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
app.use('/uploads', express.static('uploads'));

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
    res.clearCookie('sid');
    res.redirect('/');
  });
});


















// ==== РЕКОРДЕР СТРИМИНГ ЧАНКАМИ =======================
// ======================================================
// ======================================================
// ======================================================



// Папка для хранения потоков
const STREAMS_DIR = path.join(__dirname, 'streams');
if (!fs.existsSync(STREAMS_DIR)) {
  fs.mkdirSync(STREAMS_DIR);
}

// Тестовый ключ стримера
const DEFAULT_STREAM_KEY = 'test_stream_key';

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



// Функция для обновления M3U8 плейлиста
function updateM3U8Playlist(streamPath, newSegmentNumber) {
  return new Promise((resolve, reject) => {
    try {
      const playlistPath = path.join(streamPath, 'playlist.m3u8');
      const segmentDuration = 5; // Длительность сегмента в секундах
      const maxSegments = 6; // Увеличиваем количество сегментов в плейлисте
      
      // Собираем список существующих сегментов
      let existingSegments = [];
      for (let i = Math.max(1, newSegmentNumber - maxSegments + 1); i <= newSegmentNumber; i++) {
        const segmentName = `segment${i.toString().padStart(6, '0')}.ts`;
        const segmentPath = path.join(streamPath, segmentName);
        
        if (fs.existsSync(segmentPath)) {
          existingSegments.push({
            number: i,
            name: segmentName
          });
        }
      }
      
      console.log(`📋 Найдено ${existingSegments.length} существующих сегментов для плейлиста`);
      
      // Если нет сегментов, создаем пустой плейлист
      if (existingSegments.length === 0) {
        console.log('⚠️ Нет доступных сегментов для плейлиста');
        return resolve(playlistPath);
      }
      
      const firstSegmentNumber = existingSegments[0].number;
      
      let playlist = '';
      
      // Заголовок плейлиста для ЖИВОГО стрима
      playlist += '#EXTM3U\n';
      playlist += '#EXT-X-VERSION:3\n';
      playlist += `#EXT-X-TARGETDURATION:${segmentDuration + 1}\n`;
      playlist += `#EXT-X-MEDIA-SEQUENCE:${firstSegmentNumber}\n`; // Используем номер первого существующего сегмента
      // Убираем EXT-X-PLAYLIST-TYPE:LIVE так как это может вызывать проблемы
      playlist += '\n';
      
      // Добавляем все существующие сегменты
      for (const segment of existingSegments) {
        playlist += `#EXTINF:${segmentDuration}.0,\n`;
        playlist += `${segment.name}\n`;
      }
      
      // НЕ добавляем #EXT-X-ENDLIST для живого стрима!
      
      // Записываем плейлист
      fs.writeFileSync(playlistPath, playlist);
      console.log(`📋 Плейлист обновлен: ${existingSegments.length} сегментов, sequence: ${firstSegmentNumber}-${newSegmentNumber}`);
      
      // Очищаем старые сегменты
      cleanupOldSegments(streamPath, newSegmentNumber, maxSegments + 3);
      
      resolve(playlistPath);
    } catch (error) {
      console.error('❌ Ошибка обновления плейлиста:', error);
      reject(error);
    }
  });
}

// Функция для очистки старых сегментов
function cleanupOldSegments(streamPath, currentSegment, keepCount) {
  try {
    const oldestSegmentToKeep = Math.max(0, currentSegment - keepCount + 1);
    
    // Читаем все файлы в директории
    const files = fs.readdirSync(streamPath);
    
    for (const file of files) {
      // Проверяем что это TS сегмент
      if (file.startsWith('segment') && file.endsWith('.ts')) {
        // Извлекаем номер сегмента
        const match = file.match(/segment(\d+)\.ts/);
        if (match) {
          const segmentNumber = parseInt(match[1]);
          
          // Удаляем если сегмент слишком старый
          if (segmentNumber < oldestSegmentToKeep) {
            const filePath = path.join(streamPath, file);
            fs.unlinkSync(filePath);
            console.log(`🗑️ Удален старый сегмент: ${file}`);
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Ошибка очистки старых сегментов:', error);
  }
}

// Функции для управления плейлистами теперь в utils/playlistUtils.js

// В конце файла будем экспортировать функции





// Удаление старых сегментов
function deleteOldSegments(directory, maxSegments) {
  const files = fs.readdirSync(directory)
    .filter(file => file.endsWith('.mp4'))
    .map(file => ({
      file,
      time: fs.statSync(path.join(directory, file)).mtime.getTime()
    }))
    .sort((a, b) => a.time - b.time);

  while (files.length > maxSegments) {
    const oldest = files.shift();
    const filePath = path.join(directory, oldest.file);
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error(`Ошибка удаления файла ${filePath}:`, err);
      } else {
        console.log(`Удалён старый сегмент: ${filePath}`);
      }
    });
  }
}

// Удаление старых TS сегментов (для HLS)
function deleteOldTSSegments(directory, maxSegments) {
  if (!fs.existsSync(directory)) return;

  try {
    const files = fs.readdirSync(directory)
      .filter(file => file.endsWith('.ts'))
      .map(file => ({
        file,
        time: fs.statSync(path.join(directory, file)).mtime.getTime()
      }))
      .sort((a, b) => a.time - b.time);

    while (files.length > maxSegments) {
      const oldest = files.shift();
      const filePath = path.join(directory, oldest.file);
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error(`❌ Ошибка удаления TS файла ${filePath}:`, err);
        } else {
          console.log(`🗑️ Удален старый TS сегмент: ${filePath}`);
        }
      });
    }
  } catch (err) {
    console.error('❌ Ошибка очистки старых TS сегментов:', err);
  }
}



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
  const streamPath = path.join(STREAMS_DIR, streamKey);
  const filePath = path.join(streamPath, filename);

  // Проверяем что файл существует и находится в правильной папке
  if (!fs.existsSync(filePath) || !filePath.startsWith(streamPath)) {
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
  const streamPath = path.join(STREAMS_DIR, streamKey);
  const filePath = path.join(streamPath, filename);

  // Проверяем что файл существует и находится в правильной папке
  if (!fs.existsSync(filePath) || !filePath.startsWith(streamPath)) {
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




// ==== РЕКОРДЕР СТРИМИНГ ЧАНКАМИ =======================
// ======================================================
// ======================================================
// ======================================================














// ==== ВЕБ РТЦ СТРИМИНГ ===============================
// ======================================================
// ======================================================
// ======================================================


// // ====== ПАПКА ДЛЯ ВИДЕОСТРИМА (HLS) ======
// const OUTPUT_DIR = path.join(__dirname, 'streams', 'test');
// if (!fs.existsSync(OUTPUT_DIR)) {
//     fs.mkdirSync(OUTPUT_DIR, { recursive: true });
// }

// // ====== TURN + STUN СЕРВЕРЫ ======
// // Замените на свои рабочие TURN-серверы!
// const ICE_SERVERS = [
//   { urls: 'stun:stun.l.google.com:19302' },
//   {
//     urls: 'turn:turn.example.com:3478',
//     username: 'testuser',
//     credential: 'testpass'
//   }
// ];

// let peerConnection = null; // Глобальная ссылка на PC (упрощённо)

// // ====== ФУНКЦИЯ СТАРТА FFmpeg ДЛЯ HLS ======
// function startHLSStream() {
//   const playlistPath = path.join(OUTPUT_DIR, 'playlist.m3u8');
//   const segmentPath = path.join(OUTPUT_DIR, 'segment_%03d.ts');

//   console.log('Starting HLS stream with output to:', OUTPUT_DIR);

//   const ffmpeg = spawn('ffmpeg', [
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
//   ]);

//   ffmpeg.stderr.on('data', (data) => {
//     console.log(`FFmpeg Log: ${data.toString()}`);
//   });

//   ffmpeg.stdin.on('error', (error) => {
//     console.error('FFmpeg stdin error:', error);
//   });

//   ffmpeg.on('error', (error) => {
//     console.error('FFmpeg process error:', error);
//   });

//   ffmpeg.on('close', (code) => {
//     console.log(`FFmpeg process closed with code ${code}`);
//   });

//   return ffmpeg;
// }

// // ====== ЭНДПОИНТ /webrtc/offer ======
// app.post('/webrtc/offer', async (req, res) => {
//   try {
//     const { sdp } = req.body;
//     console.log('Received SDP offer:', sdp.type, sdp.sdp.slice(0, 100), '...');

//     // Закрываем старое соединение, если было
//     if (peerConnection) {
//       peerConnection.close();
//     }

//     // Создаём новое WebRTC соединение
//     peerConnection = new wrtc.RTCPeerConnection({
//       iceServers: ICE_SERVERS
//     });

//     // ====== ЛОГИРОВАНИЕ ICE / CONNECTION STATE ======
//     peerConnection.onicegatheringstatechange = () => {
//       console.log('ICE gathering state:', peerConnection.iceGatheringState);
//     };

//     peerConnection.onicecandidate = (event) => {
//       if (event.candidate) {
//         console.log('New ICE candidate:', {
//           candidate: event.candidate.candidate,
//           sdpMid: event.candidate.sdpMid,
//           sdpMLineIndex: event.candidate.sdpMLineIndex
//         });
//       } else {
//         console.log('All ICE candidates have been sent (onicecandidate=null).');
//       }
//     };

//     // peerConnection.onicecandidateerror = (e) => {
//     //   console.error('ICE candidate error:', e);
//     // };

//     peerConnection.onconnectionstatechange = () => {
//       console.log(`WebRTC connection state: ${peerConnection.connectionState}`);
//       if (peerConnection.connectionState === 'connected') {
//         console.log('WebRTC соединение установлено успешно');
//       } else if (peerConnection.connectionState === 'failed') {
//         console.error('WebRTC соединение не удалось установить');
//       }
//     };

//     // ====== ОБРАБОТКА ВИДЕОТРЕКА ======
//     peerConnection.ontrack = (event) => {
//       if (event.track.kind === 'video') {
//         console.log('Получен track видео.');
//         const videoSink = new wrtc.nonstandard.RTCVideoSink(event.track);
//         const ffmpeg = startHLSStream();

//         let lastFrameTime = 0;
//         let queueBusy = false;
//         let frameQueue = [];

//         videoSink.onframe = ({ frame }) => {
//           try {
//             if (!frame || !frame.data) return;
//             const now = Date.now();

//             const frameBuf = Buffer.from(frame.data);

//             if (lastFrameTime === 0) {
//               lastFrameTime = now;
//             }
//             frameQueue.push({ time: now, data: frameBuf });
//             if (!queueBusy) {
//               processNextFrame();
//             }
//           } catch (err) {
//             console.error('Frame processing error:', err);
//           }
//         };

//         function processNextFrame() {
//           if (frameQueue.length === 0) {
//             queueBusy = false;
//             return;
//           }
//           queueBusy = true;

//           const { time, data } = frameQueue.shift();
//           const delta = time - lastFrameTime;
//           lastFrameTime = time;
//           const waitMs = delta > 0 ? delta : 0;

//           setTimeout(() => {
//             if (ffmpeg.stdin.writable) {
//               ffmpeg.stdin.write(data);
//             }
//             processNextFrame();
//           }, waitMs);
//         }

//         event.track.onended = () => {
//           console.log('Video track ended');
//           videoSink.stop();
//           ffmpeg.stdin.end();
//         };
//       }
//     };

//     // ====== УСТАНАВЛИВАЕМ ОТ ДАЛЬНЕЙШЕГО КЛИЕНТА ======
//     console.log('Setting remote description...');
//     await peerConnection.setRemoteDescription(new wrtc.RTCSessionDescription(sdp));
//     console.log('Remote description set OK.');

//     console.log('Creating answer...');
//     const answer = await peerConnection.createAnswer();
//     console.log('Answer created.');

//     console.log('Setting local description...');
//     await peerConnection.setLocalDescription(answer);
//     console.log('Local description set OK.');

//     // Отправляем answer обратно клиенту
//     return res.json({ answer: peerConnection.localDescription });
//   } catch (error) {
//     console.error('Error processing offer:', error);
//     return res.status(500).json({ error: error.message });
//   }
// });

// // ====== ЭНДПОИНТ /webrtc/ice (добавление ICE-кандидата) ======
// app.post('/webrtc/ice', async (req, res) => {
//   try {
//     const { candidate } = req.body;
//     console.log('Received ICE candidate from client:', candidate && candidate.candidate);

//     if (peerConnection && candidate) {
//       await peerConnection.addIceCandidate(new wrtc.RTCIceCandidate(candidate));
//       console.log('ICE candidate added successfully');
//     }
//     res.sendStatus(200);
//   } catch (error) {
//     console.error('Error processing ICE candidate:', error);
//     res.status(500).json({ error: error.message });
//   }
// });

// // ====== ВЫДАЧА HLS ФАЙЛОВ ======
// app.get('/streams/test/playlist.m3u8', (req, res) => {
//   res.sendFile(path.join(OUTPUT_DIR, 'playlist.m3u8'));
// });

// app.get('/streams/test/segment_:id.ts', (req, res) => {
//   res.sendFile(path.join(OUTPUT_DIR, `segment_${req.params.id}.ts`));
// });

// // ====== СТАТИКА ДЛЯ HLS ======
// app.use('/streams', express.static(OUTPUT_DIR));





// ==== ВЕБ РТЦ СТРИМИНГ ===============================
// ======================================================
// ======================================================
// ======================================================



















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

// Функции для управления плейлистами экспортируются из utils/playlistUtils.js



















// ==== КАКИЕ ТО ПРОШЛЫЕ НАРАБОТКИ ЛИБО 
// РАЗБИРАТЬСЯ ЛИБО УДАЛИТЬ И ЗАБЫТЬ =======================
// ======================================================
// ======================================================
// ======================================================



// const ffmpeg = require('fluent-ffmpeg');
// const bodyParser = require('body-parser');
// const NodeMediaServer = require('node-media-server');


// app.use(bodyParser.raw({ type: '*/*', limit: '500mb' }));

// // Убедитесь, что NodeMediaServer настроен на запись или трансляцию потоков после приема RTMP потока
// const nmsConfig = {
//   rtmp: {
//     port: 1935,   
//     chunk_size: 60000,
//     gop_cache: true,
//     ping: 60,
//     ping_timeout: 30
//   },
//   // другие конфигурации по необходимости
// };

// const nms = new NodeMediaServer(nmsConfig);
// nms.run();


// app.post('/upload-segment', async (req, res) => {
//   try {
//     if (!Buffer.isBuffer(req.body)) {
//       return res.status(400).send('Expected request body to be binary data');
//     }

//     if (req.body.length === 0) {
//       return res.status(400).send('No data found in the request body');
//     }

//     const tempFilePath = path.join(__dirname, 'tmp', `segment_${Date.now()}.webm`);
//     fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
//     fs.writeFileSync(tempFilePath, req.body);
//     console.log('Chunk saved at:', tempFilePath);

//     const process = ffmpeg(tempFilePath)
//       .on('start', (command) => {
//         console.log('FFmpeg started with command: ' + command);
//       })
//       .on('error', (err, stdout, stderr) => {
//         console.log('Cannot process video: ', err.message);
//         res.status(500).send('An error occurred while processing the media file');
//       })
//       .on('end', () => {
//         console.log('Processing finished successfully');
//         // удаление временного файла после завершения конвертации
//         fs.unlinkSync(tempFilePath);
//         res.sendStatus(200);
//       })
//       .outputOptions('-c:v', 'libx264')
//       .outputOptions('-c:a', 'aac')
//       .outputOptions('-f', 'flv')
//       .output(`rtmp://localhost:1935/live/myStream`);

//   } catch (err) {
//     console.error('Error in upload-segment endpoint:', err);
//     res.status(500).send('Server error during segment upload and conversion');
//   }
// });

// // Запуск HTTP сервера
// const httpServer = require('http').createServer(app);
// const PORT = process.env.PORT || 3000;
// httpServer.listen(PORT, () => {
//   console.log(`HTTP Server running on port ${PORT}`);
// });


















// const multer = require('multer');
// const NodeMediaServer = require('node-media-server');
// const upload = multer();

// // Хранилище активных стримов
// const activeStreams = new Map();


// const nmsConfig = {
//   logType: 3,
//   rtmp: {
//     port: 1935,
//     chunk_size: 4096,
//     gop_cache: true,
//     ping: 30,
//     ping_timeout: 60
//   },
//   http: {
//     port: 8000,
//     allow_origin: '*',
//     mediaroot: './media'
//   },
//   trans: {
//     ffmpeg: process.env.FFMPEG_WAY,
//     tasks: [
//       {
//         app: 'live',
//         hls: true,
//         hlsFlags: '[hls_time=2:hls_list_size=3:hls_flags=delete_segments+discont_start+omit_endlist]',
//         dash: true,
//         dashFlags: '[f=dash:window_size=3:extra_window_size=5]'
//       }
//     ]
//   }
// };
// // Конфигурация Node-Media-Server


// // Класс для управления стримом
// class StreamManager {
//   constructor(streamKey) {
//     this.streamKey = streamKey;
//     this.ffmpegProcess = null;
//     this.isActive = false;
//     this.lastActivity = Date.now();
//     this.startFFmpeg();
//   }

//   startFFmpeg() {
//     const ffmpegArgs = [
//       '-fflags', '+genpts',
//       '-i', '-',
//       '-c:v', 'libx264',
//       '-preset', 'ultrafast',
//       '-tune', 'zerolatency',
//       '-profile:v', 'baseline',
//       '-level', '3.0',
//       '-b:v', '1500k',
//       '-maxrate', '1500k',
//       '-bufsize', '3000k',
//       '-pix_fmt', 'yuv420p',
//       '-g', '30',
//       '-keyint_min', '30',
//       '-r', '30',
//       '-c:a', 'aac',
//       '-b:a', '128k',
//       '-ar', '44100',
//       '-ac', '2',
//       '-af', 'aresample=async=1',
//       '-threads', '4',
//       '-f', 'flv',
//       `rtmp://localhost:1935/live/${this.streamKey}`
//     ];

//     this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

//     this.ffmpegProcess.stderr.on('data', (data) => {
//       console.log(`FFmpeg ${this.streamKey}: ${data}`);
//     });

//     this.ffmpegProcess.on('error', (err) => {
//       console.error(`FFmpeg process error: ${err}`);
//       this.restart();
//     });

//     this.ffmpegProcess.on('exit', (code) => {
//       if (code !== 0 && this.isActive) {
//         console.log(`FFmpeg exited with code ${code}, restarting...`);
//         this.restart();
//       }
//     });

//     this.isActive = true;
//   }

//   restart() {
//     if (this.ffmpegProcess) {
//       this.ffmpegProcess.kill();
//     }
//     setTimeout(() => this.startFFmpeg(), 1000);
//   }

//   writeChunk(chunk) {
//     if (this.isActive && this.ffmpegProcess) {
//       this.lastActivity = Date.now();
//       try {
//         this.ffmpegProcess.stdin.write(chunk);
//       } catch (error) {
//         console.error('Error writing chunk:', error);
//         this.restart();
//       }
//     }
//   }

//   stop() {
//     this.isActive = false;
//     if (this.ffmpegProcess) {
//       this.ffmpegProcess.stdin.end();
//       this.ffmpegProcess.kill();
//     }
//   }
// }

// // Запуск Node-Media-Server
// const nms = new NodeMediaServer(nmsConfig);
// nms.run();

// // Middleware для CORS
// app.use((req, res, next) => {
//   res.header('Access-Control-Allow-Origin', '*');
//   res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
//   next();
// });

// // Обработка входящих сегментов
// app.post('/upload-segment', upload.single('segment'), async (req, res) => {
//   const { streamKey } = req.body;
  
//   if (!streamKey || !req.file) {
//     return res.status(400).send('Missing streamKey or segment');
//   }

//   try {
//     let streamManager = activeStreams.get(streamKey);
//     if (!streamManager) {
//       streamManager = new StreamManager(streamKey);
//       activeStreams.set(streamKey, streamManager);
//     }

//     streamManager.writeChunk(req.file.buffer);
//     res.status(200).send('Segment processed');
//   } catch (error) {
//     console.error('Error processing segment:', error);
//     res.status(500).send('Internal server error');
//   }
// });

// // Очистка неактивных стримов
// setInterval(() => {
//   const now = Date.now();
//   activeStreams.forEach((stream, key) => {
//     if (now - stream.lastActivity > 30000) { // 30 секунд неактивности
//       console.log(`Stopping inactive stream: ${key}`);
//       stream.stop();
//       activeStreams.delete(key);
//     }
//   });
// }, 10000);

// // Запуск сервера
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   console.log(`HTTP Server running on port ${PORT}`);
//   console.log(`RTMP Server running on port 1935`);
//   console.log(`HLS Server running on port 8000`);
// });

// // Очистка при выключении
// process.on('SIGINT', () => {
//   activeStreams.forEach(stream => stream.stop());
//   process.exit();
// });












// // Простая очередь в памяти
// class SimpleQueue {
//   constructor() {
//     this.queue = [];
//     this.processing = false;
//   }

//   async add(task) {
//     this.queue.push(task);
//     if (!this.processing) {
//       this.processQueue();
//     }
//   }

//   async processQueue() {
//     if (this.queue.length === 0) {
//       this.processing = false;
//       return;
//     }

//     this.processing = true;
//     const task = this.queue.shift();

//     try {
//       await processSegment(task);
//     } catch (err) {
//       console.error('Error processing segment:', err);
//     }

//     // Продолжаем обработку очереди
//     this.processQueue();
//   }
// }



// const multer = require('multer');
// const fs = require('fs-extra');

// const segmentQueue = new SimpleQueue();

// // Настройка multer
// const upload = multer();

// // Настройка путей
// const STREAMS_DIR = path.join(__dirname, 'streams');
// fs.ensureDirSync(STREAMS_DIR);

// // Хранение активных стримов
// const activeStreams = {};

// // Обработка загрузки сегмента
// app.post('/upload-segment', upload.single('segment'), async (req, res) => {
//   // Отправляем ответ клиенту сразу
//   res.status(200).send('Segment received');

//   const { streamKey } = req.body;
//   if (!streamKey || !req.file) return;

//   try {
//     await segmentQueue.add({
//       streamKey,
//       segmentBuffer: req.file.buffer,
//       timestamp: Date.now()
//     });
//   } catch (err) {
//     console.error('Error queuing segment:', err);
//   }
// });

// // Функция обработки сегмента
// async function processSegment(task) {
//   const { streamKey, segmentBuffer, timestamp } = task;
//   const streamPath = path.join(STREAMS_DIR, streamKey);
  
//   await fs.ensureDir(streamPath);

//   if (!activeStreams[streamKey]) {
//     activeStreams[streamKey] = {
//       segments: [],
//       mediaSequence: 0
//     };
//   }

//   const streamData = activeStreams[streamKey];
  
//   const webmFilename = `segment-${timestamp}.webm`;
//   const tsFilename = `segment-${timestamp}.ts`;
//   const webmPath = path.join(streamPath, webmFilename);
//   const tsPath = path.join(streamPath, tsFilename);

//   try {
//     // Сохраняем WebM
//     await fs.writeFile(webmPath, segmentBuffer);
    
//     // Конвертируем в TS
//     await convertToTS(webmPath, tsPath);
    
//     // Добавляем сегмент в список
//     streamData.segments.push(tsFilename);

//     // Управление количеством сегментов

//     if (streamData.segments.length > MAX_SEGMENTS) {
//       const oldSegment = streamData.segments.shift();
//       const oldPath = path.join(streamPath, oldSegment);
//       await fs.remove(oldPath);
//       streamData.mediaSequence++;
//     }

//     // Обновляем плейлист
//     await writeM3U8(streamPath, streamData);
    
//     // Удаляем временный WebM файл
//     await fs.remove(webmPath);

//   } catch (err) {
//     console.error('Error processing segment:', err);
//     throw err;
//   }
// }

// const SEGMENT_DURATION = 2; // Уменьшаем длительность сегмента до 2 секунд
// const MAX_SEGMENTS = 6; // Держим больше сегментов в плейлисте

// function convertToTS(inputPath, outputPath) {
//   return new Promise((resolve, reject) => {
//     const ff = spawn('ffmpeg', [
//       '-y',
//       '-fflags', '+genpts',
//       '-i', inputPath,
//       '-c:v', 'libx264',
//       '-preset', 'veryfast',
//       '-profile:v', 'main',
//       '-level', '3.1',
//       '-b:v', '3000k',        // Увеличиваем битрейт видео
//       '-maxrate', '3000k',
//       '-bufsize', '6000k',
//       '-sc_threshold', '0',   // Отключаем определение смены сцен
//       '-g', '48',            // GOP size = 48 (2 секунды при 24 fps)
//       '-keyint_min', '48',   // Минимальный интервал ключевых кадров
//       '-r', '24',            // Фиксированный FPS
//       '-c:a', 'aac',
//       '-b:a', '128k',        // Битрейт аудио
//       '-ar', '44100',        // Частота дискретизации аудио
//       '-af', 'aresample=async=1000', // Помогает с синхронизацией аудио
//       '-segment_time', '2',   // Длительность сегмента
//       '-f', 'mpegts',
//       outputPath
//     ]);

//     const timeout = setTimeout(() => {
//       ff.kill();
//       reject(new Error('FFmpeg conversion timeout'));
//     }, 10000);

//     ff.stderr.on('data', (data) => {
//       console.log(`FFmpeg: ${data}`);
//     });

//     ff.on('close', (code) => {
//       clearTimeout(timeout);
//       if (code === 0) {
//         resolve();
//       } else {
//         reject(new Error(`FFmpeg failed with code ${code}`));
//       }
//     });
//   });
// }

// // Обновляем функцию создания M3U8 плейлиста
// async function writeM3U8(streamPath, streamData) {
//   const playlistPath = path.join(streamPath, 'playlist.m3u8');
//   const m3u8Content = [
//     '#EXTM3U',
//     '#EXT-X-VERSION:3',
//     '#EXT-X-ALLOW-CACHE:NO',
//     `#EXT-X-TARGETDURATION:${SEGMENT_DURATION}`,
//     `#EXT-X-MEDIA-SEQUENCE:${streamData.mediaSequence}`,
//     '#EXT-X-INDEPENDENT-SEGMENTS',
//     ...streamData.segments.map(segment => {
//       return [
//         `#EXTINF:${SEGMENT_DURATION}.0,`,
//         segment
//       ].join('\n');
//     })
//   ].join('\n');

//   await fs.writeFile(playlistPath, m3u8Content);
// }

// // Настройка статических файлов
// app.use('/streams', express.static(STREAMS_DIR, {
//   setHeaders: (res, filePath) => {
//     if (filePath.endsWith('.m3u8') || filePath.endsWith('.ts')) {
//       res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
//       res.setHeader('Pragma', 'no-cache');
//       res.setHeader('Expires', '0');
//       res.setHeader('Access-Control-Allow-Origin', '*');
//     }
//   }
// }));










// // Запуск сервера
// app.listen(3000, () => {
//     console.log('Сервер запущен на порту 3000');
// });
// async function startServer() {
//   const { encode, decode } = await import('@alttiri/base85');

//   // Ваш код сервера и socket.io
//   var server = require('http').createServer(app);
//   // var server = https.createServer(options, app);

//   // Настройка socket.io
//   const io = new Server(server, {
//     cors: {
//       origin: '*',
//       methods: ['GET', 'POST']
//     },
//     transports: ['websocket']
//   });

//   function startFFmpeg(streamKey) {
//     console.log('Запуск FFmpeg с параметрами для streamKey:', streamKey);
//     console.log([
//       '-re',
//       '-i', 'pipe:0',
//       '-c:v', 'libx264',
//       '-preset', 'ultrafast',
//       '-tune', 'zerolatency',
//       '-g', '30',
//       '-crf', '35',
//       '-vf', 'scale=640:360',
//       '-b:v', '500k',
//       '-c:a', 'aac',
//       '-b:a', '64k',
//       '-ar', '44100',
//       '-f', 'flv',
//       '-bufsize', '128k',
//       '-progress', 'pipe:2', // Добавляем параметр для вывода прогресса
//       // `rtmp://localhost:1935/live/${streamKey}` // Динамически вставляем ключ потока
//       `${process.env.RTMP}${streamKey}`
//     ].join(' '));

//     const ffmpegProcess = spawn(process.env.FFMPEG_WAY, [
//       '-re',
//       '-i', 'pipe:0',
//       '-c:v', 'libx264',
//       '-preset', 'ultrafast',
//       '-tune', 'zerolatency',
//       '-g', '30',
//       '-crf', '35',
//       '-vf', 'scale=640:360',
//       '-b:v', '500k',
//       '-c:a', 'aac',
//       '-b:a', '64k',
//       '-ar', '44100',
//       '-f', 'flv',
//       '-bufsize', '128k',
//       '-progress', 'pipe:2', // Добавляем параметр для прогресса
//       // `rtmp://localhost:1935/live/${streamKey}` // Динамический streamKey
//       `${process.env.RTMP}${streamKey}`
//     ]);

//     // Логирование в реальном времени `stderr`
//     ffmpegProcess.stderr.on('data', (data) => {
//       const progressOutput = data.toString();
      
//       // Разбор строки прогресса для получения подробной информации
//       progressOutput.split('\n').forEach(line => {
//         if (line.startsWith('frame=')) {
//           console.log(`FFmpeg Progress: ${line.trim()}`);
//         } else if (line.startsWith('fps=')) {
//           console.log(`FFmpeg FPS: ${line.trim()}`);
//         } else if (line.startsWith('bitrate=')) {
//           console.log(`FFmpeg Bitrate: ${line.trim()}`);
//         } else if (line.startsWith('speed=')) {
//           console.log(`FFmpeg Speed: ${line.trim()}`);
//         }
//       });
//     });

//     // Логирование в реальном времени `stdout`
//     ffmpegProcess.stdout.on('data', (data) => {
//       console.log(`FFmpeg stdout: ${data.toString()}`);
//     });

//     // Обработка завершения процесса
//     ffmpegProcess.on('close', (code) => {
//       console.log(`FFmpeg завершил работу с кодом: ${code}`);
//       if (code !== 0) {
//         console.error('FFmpeg завершился с ошибкой');
//       }
//     });

//     // Обработка ошибок процесса
//     ffmpegProcess.on('error', (err) => {
//       console.error('Ошибка в процессе FFmpeg:', err);
//     });

//     // Обработка ошибок потока `stdin`
//     ffmpegProcess.stdin.on('error', (err) => {
//       console.error('Ошибка stdin FFmpeg:', err);
//     });

//     return ffmpegProcess;
//   }

//   let viewers = {};

//   io.on('connection', (socket) => {
//     console.log('Клиент подключился:', socket.id);

//     let ffmpeg;
//     let currentStreamKey = null; 

//     socket.on('start-stream', async ({ streamKey }) => {
//       currentStreamKey = streamKey; 
//       console.log('Получен streamKey:', streamKey);


//       ffmpeg = startFFmpeg(streamKey);
//     });



//     socket.on('join-stream', (streamKey) => {

//       currentStreamKey = streamKey;
  
//       if (!viewers[streamKey]) {
//         viewers[streamKey] = 0;
//       }
//       viewers[streamKey]++;
  

//       io.emit('update-viewers', { streamKey, count: viewers[streamKey] });
//     });



//     // Счетчик для чанков данных
//     let chunkCounter = 0;

//     // Обработка входящего потока данных от клиента
//     socket.on('stream-data', (data) => {
//       if (!ffmpeg) {
//         console.error('FFmpeg процесс не запущен, возможно, не передан streamKey.');
//         return;
//       }


//       chunkCounter++;

//       // Декодируем строку Base85 в Buffer
//       const bufferData = decode(data);

//       // Передаем данные в ffmpeg
//       try {
//         ffmpeg.stdin.write(bufferData);
//       } catch (err) {
//         console.error('Ошибка записи в stdin FFmpeg:', err);
//       }
//     });

//     socket.on('disconnect', () => {
//       console.log('Клиент отключился:', socket.id);

//     if (currentStreamKey && viewers[currentStreamKey]) {
//       viewers[currentStreamKey] = Math.max(0, viewers[currentStreamKey] - 1);
//       io.emit('update-viewers', { streamKey: currentStreamKey, count: viewers[currentStreamKey] });
//     }

//       // Завершить процесс FFmpeg при отключении клиента
//       if (ffmpeg) {
//         console.log('Завершаем процесс FFmpeg');
//         ffmpeg.stdin.end();
//         ffmpeg.kill('SIGINT');
//       }
//     });
//   });

//   // Теперь прослушивайте ваш IP и порт.
//   server.listen(3000, "0.0.0.0");
// }

// startServer();


