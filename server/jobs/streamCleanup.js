// Уборка брошенных эфиров.
//
// Эфир помечается активным при старте и снимается при остановке, но вкладку
// закрывают, браузер падает, сеть рвётся — и запись остаётся «в эфире» навсегда.
// Раньше setInterval стоял прямо в теле роутера и запускался фактом его
// подключения; теперь запуск явный, из app.js.

const Stream = require('../models/Stream');
const User = require('../models/User');
const Notification = require('../models/Notification');
const push = require('../utils/push');
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

// Раз в 5 минут; зонды (temp/probe-limits-1014.mjs) ставят чаще.
const STREAM_CLEANUP_INTERVAL_MS = Number(process.env.STREAM_CLEANUP_INTERVAL_SEC || 300) * 1000;

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
    const toDelete = (await Stream.find(query).select('_id isActive updatedAt userId streamType streamKey dailyRoomName thumbnail title description category subcategory city isAdult venue firstLiveAt stoppedByModeration').lean())
      .filter((s) => !(s.isActive && media.activeStreams.has(s.streamKey)));
    if (!toDelete.length) return;

    console.log(`[cleanup] deleting abandoned streams: count=${toDelete.length} activeTTL=${ACTIVE_TTL_MINUTES}m inactiveTTL=${INACTIVE_TTL_DAYS}d`);

    // Отрезки брошенных эфиров закрываем до удаления: после него ни ключа,
    // ни владельца уже не узнать, и такой эфир остался бы «идущим» навсегда.
    for (const s of toDelete) {
      if (s.isActive) {
        await stopActive(s, media);
        await streamLog.close(s.streamKey, { endedBy: 'cleanup', streamId: s._id });
      }
    }

    await Stream.deleteMany({ _id: { $in: toDelete.map(s => s._id) } });

    // Брошенный эфир так и не сказал, сохранять ли запись. До 14.10 куски
    // удалялись — и честный обрыв (сел телефон, iOS выгрузил вкладку) стоил
    // ведущему всей записи. Теперь эфир, который выходил в эфир и не погашен
    // модерацией, сохраняется сам, как «Сохранить запись»; удалить запись
    // ведущий может сам (AUDIT-2026-10-14, F1).
    const kept = new Set();
    for (const s of toDelete) {
      const saved = await autoSave(s);
      if (saved) kept.add(s);
      if (s.isActive || saved) {
        audit(null, 'stream.cleanup', {
          actor: s.userId, targetType: 'stream', targetId: s._id, targetLabel: s.streamKey,
          meta: { saved: !!saved, wasActive: !!s.isActive, recording: saved ? String(saved._id) : null },
        });
      }
    }
    await Promise.all(toDelete.filter((s) => !kept.has(s))
      .map((s) => recording.discard(s.streamKey).catch((e) => errorLog.media(e, 'streamCleanup.discard', { stream: String(s._id) }))));
    // Обложка — с диска, если её больше никто не держит: та же картинка
    // бывает обложкой по умолчанию у ведущего (streamDefaults) и у его
    // следующего эфира. Сохранённой записи обложка нужна для склейки —
    // её не трогаем, как и «Сохранить запись» (routes/streaming/streams.js).
    const coverOfKept = new Set([...kept].map((s) => s.thumbnail));
    for (const url of new Set(toDelete.map((s) => s.thumbnail).filter((u) => u && !coverOfKept.has(u)))) {
      const used = await Stream.exists({ thumbnail: url }) || await User.exists({ 'streamDefaults.thumbnail': url });
      if (!used) unlinkUpload(url, 'thumbnails');
    }
  } catch (error) {
    errorLog.server(error, 'streamCleanup');
  }
};

// Сохранить запись брошенного эфира — те же условия, что у «Сохранить
// запись» на пульте, плюс хоть один непустой кусок. Ведущему — строка
// в колокольчик и пуш. Сбой — в журнал ошибок, куски тогда удаляются.
async function autoSave(s) {
  try {
    if (!recording.enabled || !s.firstLiveAt || s.stoppedByModeration) return null;
    if (!(await recording.hasParts(s.streamKey))) return null;
    const owner = await User.findById(s.userId).select('banned').lean();
    if (!owner || owner.banned) return null;
    const rec = await recording.save(s);
    streamLog.attachRecording(s.streamKey, rec);
    audit(null, 'recording.save', { actor: s.userId, targetType: 'recording', target: rec, meta: { auto: true } });
    notifySaved(s, rec).catch((e) => errorLog.server(e, 'streamCleanup.notify', { recording: String(rec._id) }));
    return rec;
  } catch (e) {
    errorLog.media(e, 'streamCleanup.autoSave', { stream: String(s._id) });
    return null;
  }
}

async function notifySaved(s, rec) {
  const link = '/recording/' + rec._id;
  await Notification.create({ recipient: s.userId, sender: s.userId, type: 'recording', content: s.title || '', link });
  const io = ioRef.get();
  if (io) io.to(`user:${s.userId}`).emit('notification:new');
  if (push.onScreen(s.userId)) return;
  await push.send(s.userId, {
    topic: 'recording',
    titleKey: 'push.recordingSaved',
    body: s.title || '',
    tag: 'recording-' + String(rec._id),
    url: link,
  });
}

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
