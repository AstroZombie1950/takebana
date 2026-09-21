const NodeMediaServer = require('node-media-server');
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });


const path = require('path');
const { isPublishAuthEnabled, getSecret } = require('./utils/rtmpAuth');
const hls = require('./utils/hls');
const webLive = require('./utils/webLive');
const streamLog = require('./utils/streamLog');
const { audit } = require('./utils/audit');
const errorLog = require('./utils/errorLog');
const liveSignal = require('./utils/liveSignal');
const liveNotify = require('./utils/liveNotify');

// Право публиковать проверяется подписью, а не знанием ключа: ключ трансляции
// уходит каждому зрителю в исходнике страницы — по нему собирается адрес
// плейлиста `/live/<streamKey>/index.m3u8`, без него плеер поток не найдёт.
// Значит, сам по себе ключ ничего не защищает. Формат подписи — utils/rtmpAuth.js.
//
// play намеренно оставлен открытым: RTMP-воспроизведение забирает наш ffmpeg
// с 127.0.0.1, а закрывать раздачу зрителям надо подписанными ссылками CDN.
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
  // Секции http нет намеренно: без неё node-media-server не поднимает свой
  // HTTP-сервер на 8000. HLS пишет наш ffmpeg (utils/hls.js), а раздаёт
  // с диска nginx — медиасервер в тракте зрителя не участвует. HTTP-FLV,
  // ради которого сервер был нужен, ушёл вместе с flv.js.
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
    const now = new Date();
    const updated = await Stream.findOneAndUpdate(
      { streamKey },
      [{ $set: {
        streamType: 'obs-stream',
        streamProvider: 'obs',
        isActive: true,
        startedAt: now,
        updatedAt: now,
        // Первый выход в эфир: пульт по нему отличает эфир на паузе от черновика.
        firstLiveAt: { $ifNull: ['$firstLiveAt', now] }
      } }],
      { new: true }
    ).lean();
    if (ioRef) {
      ioRef.to(`stream:${streamKey}`).emit('stream:update', {
        streamKey,
        streamType: 'obs-stream',
        streamProvider: 'obs',
        isActive: true,
        startedAt: now
      });
      // Эфир с OBS начинается приходом потока, а не нажатием на сайте:
      // витрина и подписчики узнают о нём только отсюда.
      liveSignal.changed(ioRef, updated && updated.userId, true);
      // Подписчикам — строка в колокольчик и пуш. Переподключение вещателя
      // второй раз их не разбудит: отметка в самом эфире (utils/liveNotify.js).
      liveNotify.quiet(ioRef, updated);
    }

    // Отрезок эфира открывается именно здесь: эфир с OBS начинается приходом
    // потока на 1935, а не нажатием на сайте, и /set-active для него не зовут.
    if (updated) {
      streamLog.open(updated);
      audit(null, 'stream.rtmp.start', {
        actor: updated.userId,
        targetType: 'stream',
        targetId: updated._id,
        targetLabel: updated.title,
      });
    }
    return updated;
  } catch (e) {
    errorLog.media(e, 'rtmp.obsStarted', { streamKey });
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
      liveSignal.changed(ioRef, updated && updated.userId, false);
    }

    if (updated) {
      streamLog.close(streamKey, { endedBy: 'owner', streamId: updated._id });
      audit(null, 'stream.rtmp.end', {
        actor: updated.userId,
        targetType: 'stream',
        targetId: updated._id,
        targetLabel: updated.title,
      });
    }
    return updated;
  } catch (e) {
    errorLog.media(e, 'rtmp.obsEnded', { streamKey });
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

// Отклоняем публикацию, если ключ неизвестен, эфир погашен модерацией или
// вещатель ограничен. Проверка асинхронная: сессия успевает открыться
// и закрывается следом — этого достаточно, чтобы поток не начал раздаваться.
//
// Без проверки бана ограничение обходилось целиком: HTTP-маршруты вещания
// закрыты requireNotBanned, но OBS в них не ходит — он подключается прямо
// к 1935 с ключом, который у забаненного никуда не делся.
async function rejectUnknownStreamKey(id, streamKey) {
    try {
        const Stream = require('./models/Stream');
        const User = require('./models/User');

        const stream = await Stream.findOne({ streamKey })
            .select('userId stoppedByModeration')
            .lean();

        // Отклонения пишутся в журнал: попытка вещать неизвестным ключом —
        // это либо чужая программа с подобранным ключом, либо наш же сбой,
        // и отличить одно от другого можно только по их частоте и адресу.
        const reject = (why, meta) => {
            audit(null, 'stream.rtmp.reject', {
                actor: stream ? stream.userId : null,
                result: 'denied',
                targetType: 'stream',
                targetId: stream ? stream._id : null,
                targetLabel: streamKey,
                meta,
            });
            return dropSession(id, why);
        };

        if (!stream) return reject(`ключ ${streamKey} не найден`, { reason: 'unknown-key' });
        if (stream.stoppedByModeration) return reject(`эфир ${streamKey} погашен модерацией`, { reason: 'stopped' });

        const owner = await User.findById(stream.userId).select('banned').lean();
        if (owner && owner.banned) return reject(`вещатель эфира ${streamKey} ограничен`, { reason: 'banned' });
    } catch (e) {
        // База недоступна — не роняем приём: подпись остаётся основной защитой
        errorLog.media(e, 'rtmp.prePublish', { streamKey });
    }
}

function dropSession(id, why) {
    console.warn(`[mediaServer] публикация отклонена: ${why}`);
    const session = nms.getSession(id);
    if (session && typeof session.reject === 'function') session.reject();
}

// Разрыв уже идущего вещания: ведущий завершил эфир, модератор погасил его
// или ограничил вещателя. Без этого «стоп-эфир» оставался косметикой —
// в базе эфир помечен погашенным, а OBS продолжает лить, HLS продолжает
// писать сегменты и зритель их получает.
function dropPublisher(streamKey, why = 'прервано модерацией') {
    const live = activeStreams.get(streamKey);
    if (!live) return false;

    dropSession(live.id, `вещание ${streamKey}: ${why}`);
    activeStreams.delete(streamKey);
    // donePublish на отклонённой сессии приходит не всегда, поэтому конвейер
    // гасим сами: stop() у себя проверяет, есть ли что останавливать.
    hls.stop(streamKey);
    return true;
}

// Сюда попадаем только после успешной проверки подписи.
nms.on('postPublish', (id, streamPath, args) => {
    const streamKey = streamPath.split('/')[2];
    // src=daily — RTMP-выход комнаты веб-эфира (utils/webLive.js). Он не
    // переключает эфир на OBS: идёт ли веб-эфир, решает ведущий на пульте.
    const fromDaily = !!args && args.src === 'daily';
    activeStreams.set(streamKey, {
        id,
        startTime: new Date(),
        isLive: true,
        fromDaily
    });
    if (fromDaily) webLive.published(streamKey);
    else markObsStreamStarted(streamKey);

    // HLS: единственный формат, который играет на iPhone. HTTP-FLV там не
    // работает в принципе — flv.js собирает поток через MSE, а Media Source
    // Extensions в Safari на iOS недоступны.
    hls.start(streamKey);
});

nms.on('donePublish', (id, streamPath, args) => {
    console.log(`[INFO] Stream has ended: ${streamPath}`);
    const streamKey = streamPath.split('/')[2];
    const live = activeStreams.get(streamKey);
    activeStreams.delete(streamKey);
    hls.stop(streamKey);
    if (live && live.fromDaily) webLive.ended(streamKey);
    else markObsStreamEnded(streamKey);
});

nms.on('error', (err) => {
    errorLog.media(err, 'rtmp');
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
    // Записать причину падения до выхода: иначе о нём известно только из
    // логов pm2. Жёсткий предел обязателен — недоступная база не должна
    // превратить падение в зависание, ради чего этот обработчик и стоит.
    errorLog.record({ scope: 'server', err, route: 'process:uncaughtException', status: 500 });
    const kill = setTimeout(() => process.exit(1), 1000);
    errorLog.flush().finally(() => { clearTimeout(kill); process.exit(1); });
});

// Экспортируем необходимые объекты
module.exports = {
    nms,
    activeStreams,
    setIO,
    dropPublisher
};