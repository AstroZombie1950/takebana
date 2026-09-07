const NodeMediaServer = require('node-media-server');
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });


const fs = require('fs');
const path = require('path');
const { isPublishAuthEnabled, getSecret } = require('./utils/rtmpAuth');
const hls = require('./utils/hls');

// Право публиковать проверяется подписью, а не знанием ключа: ключ трансляции
// уходит каждому зрителю в исходнике страницы — по нему собирается URL
// воспроизведения `/live/<streamKey>.flv`, без него плеер поток не найдёт.
// Значит, сам по себе ключ ничего не защищает. Формат подписи — utils/rtmpAuth.js.
//
// play намеренно оставлен открытым: эфир смотрят без входа, а закрывать раздачу
// надо не здесь, а подписанными ссылками на уровне CDN.
const publishAuth = isPublishAuthEnabled();

if (!publishAuth && (process.env.START_SERVER === 'prod' || process.env.NODE_ENV === 'production')) {
  console.warn(
    '[mediaServer] RTMP_PUBLISH_SECRET не задан: приём RTMP открыт — вещать ' +
    'в чужой эфир сможет любой, кто открывал страницу трансляции. ' +
    'Сгенерировать: openssl rand -hex 32'
  );
}

const config = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 10,
    ping_timeout: 30
  },
  auth: {
    publish: publishAuth,
    play: false,
    secret: getSecret()
  },
  http: {
    port: 8000,
    // Путь абсолютный: relative './media' считался бы от cwd процесса, а pm2
    // и `npm start` запускают приложение из разных каталогов — HLS уезжал бы
    // мимо того места, откуда его раздаёт этот же сервер.
    mediaroot: path.join(__dirname, 'media'),
    allow_origin: '*'
  },
  log: {
    level: 3, // 0=error, 1=warn, 2=info, 3=debug
    file: path.join(__dirname, 'media', 'server.log')
  }
};

const nms = new NodeMediaServer(config);
const activeStreams = new Map();
let ioRef = null;

function setIO(io) {
  ioRef = io;
}

async function markObsStreamStarted(streamKey) {
  try {
    const Stream = require('./models/Stream');
    const updated = await Stream.findOneAndUpdate(
      { streamKey },
      {
        streamType: 'obs-stream',
        streamProvider: 'obs',
        isActive: true,
        startedAt: new Date(),
        updatedAt: Date.now()
      },
      { new: true }
    ).lean();
    if (ioRef) {
      ioRef.to(`stream:${streamKey}`).emit('stream:update', {
        streamKey,
        streamType: 'obs-stream',
        streamProvider: 'obs',
        isActive: true
      });
    }
    return updated;
  } catch (e) {
    console.error('[mediaServer] markObsStreamStarted error:', e?.message || e);
    return null;
  }
}

async function markObsStreamEnded(streamKey) {
  try {
    const Stream = require('./models/Stream');
    const updated = await Stream.findOneAndUpdate(
      { streamKey },
      {
        isActive: false,
        startedAt: null,
        updatedAt: Date.now()
      },
      { new: true }
    ).lean();
    if (ioRef) {
      ioRef.to(`stream:${streamKey}`).emit('stream:update', {
        streamKey,
        isActive: false
      });
    }
    return updated;
  } catch (e) {
    console.error('[mediaServer] markObsStreamEnded error:', e?.message || e);
    return null;
  }
}

// Обработчики событий.
//
// Порядок в node-media-server такой: prePublish -> проверка подписи -> postPublish.
// Поэтому пометка «эфир идёт» перенесена в postPublish: раньше она стояла в
// prePublish и срабатывала даже на подключении, которое затем отклонялось, —
// эфир показывался активным без единого кадра.
nms.on('prePublish', (id, streamPath, args) => {
    console.log(`[INFO] Stream is starting: ${streamPath} with ID: ${id}`);
    const streamKey = streamPath.split('/')[2];

    // Второй рубеж, работающий и без секрета: ключа, которого нет ни в одном
    // эфире, быть не должно — иначе на диск и в память сервера пишет кто угодно.
    rejectUnknownStreamKey(id, streamKey);
});

// Отклоняем публикацию, если такого ключа нет в базе. Проверка асинхронная:
// сессия успевает открыться и закрывается следом — этого достаточно, чтобы
// поток не начал раздаваться.
async function rejectUnknownStreamKey(id, streamKey) {
    try {
        const Stream = require('./models/Stream');
        const known = await Stream.exists({ streamKey });
        if (known) return;

        console.warn(`[mediaServer] публикация отклонена: ключ ${streamKey} не найден`);
        const session = nms.getSession(id);
        if (session && typeof session.reject === 'function') session.reject();
    } catch (e) {
        // База недоступна — не роняем приём: подпись остаётся основной защитой
        console.error('[mediaServer] проверка ключа не удалась:', e?.message || e);
    }
}

// Сюда попадаем только после успешной проверки подписи.
nms.on('postPublish', (id, streamPath, args) => {
    const streamKey = streamPath.split('/')[2];
    activeStreams.set(streamKey, {
        id,
        startTime: new Date(),
        isLive: true
    });
    // OBS publish detected -> mark stream active in DB and notify viewers
    markObsStreamStarted(streamKey);

    // HLS: единственный формат, который играет на iPhone. HTTP-FLV там не
    // работает в принципе — flv.js собирает поток через MSE, а Media Source
    // Extensions в Safari на iOS недоступны.
    hls.start(streamKey);
});

nms.on('donePublish', (id, streamPath, args) => {
    console.log(`[INFO] Stream has ended: ${streamPath}`);
    const streamKey = streamPath.split('/')[2];
    activeStreams.delete(streamKey);
    markObsStreamEnded(streamKey);
    hls.stop(streamKey);
});

nms.on('error', (err) => {
    console.error(`[ERROR] ${err.message}`);
});

nms.run();

// node-media-server вешает свой process.on('uncaughtException'), который только
// пишет в лог (node_media_server.js:62). Любой слушатель этого события отменяет
// штатное падение процесса — и приложение остаётся живым, но неработоспособным.
// Наблюдалось: при занятом порте 3000 процесс висел, не слушая ни одного порта.
// Под pm2 это худшая из аварий — `pm2 status` показывает online, а autorestart
// не срабатывает, потому что процесс не завершался.
//
// Свой обработчик ставим после nms.run(): вызываются оба, но наш выходит с
// ненулевым кодом, и pm2 поднимает приложение заново. От петли перезапусков
// защищают min_uptime и max_restarts в ops/ecosystem.config.js.
// Отклонённые промисы сюда тоже попадают: с Node 15 режим по умолчанию — throw.
process.on('uncaughtException', (err) => {
    console.error('[fatal] необработанное исключение, процесс завершается:', err);
    process.exit(1);
});

// Экспортируем необходимые объекты
module.exports = {
    nms,
    activeStreams,
    setIO
};