// Уборка брошенных эфиров.
//
// Эфир помечается активным при старте и снимается при остановке, но вкладку
// закрывают, браузер падает, сеть рвётся — и запись остаётся «в эфире» навсегда.
// Раньше setInterval стоял прямо в теле роутера и запускался фактом его
// подключения; теперь запуск явный, из app.js.

const Stream = require('../models/Stream');
const User = require('../models/User');
const { unlinkUpload } = require('../utils/userDelete');
const recording = require('../utils/recording');
const streamLog = require('../utils/streamLog');
const { audit } = require('../utils/audit');
const errorLog = require('../utils/errorLog');
const daily = require('../utils/daily');
const webLive = require('../utils/webLive');
const hls = require('../utils/hls');
const liveSignal = require('../utils/liveSignal');
const ioRef = require('../utils/io');

const ACTIVE_TTL_MINUTES = Number(process.env.STREAM_CLEANUP_ACTIVE_TTL_MINUTES || 5);
const INACTIVE_TTL_DAYS = Number(process.env.STREAM_CLEANUP_INACTIVE_TTL_DAYS || 30);

const STREAM_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // run every 5 minutes

const cleanupAbandonedStreams = async () => {
  try {
    const now = Date.now();
    const activeCutoff = new Date(now - Math.max(1, ACTIVE_TTL_MINUTES) * 60 * 1000);
    const inactiveCutoff = new Date(now - Math.max(1, INACTIVE_TTL_DAYS) * 24 * 60 * 60 * 1000);

    const query = {
      $or: [
        { isActive: true, updatedAt: { $lt: activeCutoff } },
        { isActive: false, updatedAt: { $lt: inactiveCutoff } }
      ]
    };

    // Живая публикация (OBS или RTMP-выход Daily) — эфир не брошен, как бы
    // давно ни молчал пульт: updatedAt двигает только он, а с OBS вкладку
    // пульта обычно закрывают. Раньше такой эфир удалялся через 5–10 минут,
    // пока OBS лил, а ffmpeg писал в стёртый каталог записи.
    const media = require('../mediaServer');
    const toDelete = (await Stream.find(query).select('_id isActive updatedAt userId streamType streamKey dailyRoomName thumbnail').lean())
      .filter((s) => !(s.isActive && media.activeStreams.has(s.streamKey)));
    if (!toDelete.length) return;

    console.log(`[cleanup] deleting abandoned streams: count=${toDelete.length} activeTTL=${ACTIVE_TTL_MINUTES}m inactiveTTL=${INACTIVE_TTL_DAYS}d`);

    // Отрезки брошенных эфиров закрываем до удаления: после него ни ключа,
    // ни владельца уже не узнать, и такой эфир остался бы «идущим» навсегда.
    for (const s of toDelete) {
      if (s.isActive) {
        await stopActive(s, media);
        await streamLog.close(s.streamKey, { endedBy: 'cleanup', streamId: s._id });
        audit(null, 'stream.cleanup', { actor: s.userId, targetType: 'stream', targetId: s._id, targetLabel: s.streamKey });
      }
    }

    await Stream.deleteMany({ _id: { $in: toDelete.map(s => s._id) } });
    // Брошенный эфир так и не сказал, сохранять ли запись, — куски удаляются.
    await Promise.all(toDelete.map((s) => recording.discard(s.streamKey).catch(() => {})));
    // Обложка — с диска, если её больше никто не держит: та же картинка
    // бывает обложкой по умолчанию у ведущего (streamDefaults) и у его
    // следующего эфира. Запись берёт себе копию (utils/recording.js).
    for (const url of new Set(toDelete.map((s) => s.thumbnail).filter(Boolean))) {
      const used = await Stream.exists({ thumbnail: url }) || await User.exists({ 'streamDefaults.thumbnail': url });
      if (!used) unlinkUpload(url, 'thumbnails');
    }
  } catch (error) {
    errorLog.server(error, 'streamCleanup');
  }
};

// Гасим брошенный эфир тем же порядком, что /terminate-stream
// (routes/streaming/streams.js): выход и комната Daily, публикация, HLS;
// куски записи удаляются, только когда ffmpeg вышел.
async function stopActive(s, media) {
  if (s.dailyRoomName) {
    webLive.stop(s).catch(() => {});
    daily.deleteRoom(s.dailyRoomName).catch((e) => errorLog.external(e, 'daily.deleteRoom', { cleanup: String(s._id) }));
  }
  media.dropPublisher(s.streamKey, 'эфир брошен');
  hls.stop(s.streamKey);
  await hls.stopped(s.streamKey);
  const io = ioRef.get();
  if (io) {
    io.to(`stream:${s.streamKey}`).emit('stream:update', { streamKey: s.streamKey, isActive: false, ended: true });
    liveSignal.changed(io, s.userId, false);
  }
}

function startStreamCleanup() {
  // unref: таймер не должен удерживать процесс при завершении.
  setInterval(cleanupAbandonedStreams, STREAM_CLEANUP_INTERVAL_MS).unref();
}

module.exports = { startStreamCleanup };
