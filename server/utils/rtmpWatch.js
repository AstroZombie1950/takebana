// Что на самом деле приходит от вещателя по RTMP (03.10.2026, план п. 4 —
// ведущий OBS, и п. 11 — «OBS шлёт мало данных», docs/NOTICES.md).
//
// До этого о входе знали только «пришёл» и «ушёл» (rtmp.in / rtmp.out).
// Если OBS не справляется — процессор занят, сеть ведущего не тянет
// заявленный битрейт — он сам пропускает кадры, зрители видят рывки
// и подвисания, а у нас и у ведущего на пульте всё «в эфире».
//
// Раз в WINDOW_MS сравниваем пришедшее с заявленным: байты — по сокету
// сессии, кадры — счётчиком на её обработчике видео. Заявленное — из
// onMetaData (OBS шлёт битрейт и частоту кадров); не прислал — порог
// FLOOR_KBPS. Хуже LOW_SHARE заявленного LOW_WINDOWS окон подряд —
// rtmp.low в хронологию эфира и подсказка на пульт; столько же окон
// нормально — rtmp.ok. Пока плохо, подсказка повторяется каждое окно:
// пульт, открытый посреди беды, узнаёт о ней сразу, а не при следующей смене.
//
// Счётчик кадров — обёртка rtmpVideoHandler у этой одной сессии:
// node-media-server 2.7 считает кадры только первые 5 с (videoCount, ради
// videoFps) и дальше перестаёт. Сменится версия пакета — сверить
// node_rtmp_session.js (rtmpHandler зовёт this.rtmpVideoHandler()).

const AMF = require('node-media-server/src/node_core_amf');
const streamLog = require('./streamLog');
const ioHolder = require('./io');

const WINDOW_MS = 10000;
const LOW_SHARE = 0.6;
const LOW_WINDOWS = 3;
const FLOOR_KBPS = 300;

function declared(session) {
  try {
    const d = session.metaData && AMF.decodeAmf0Data(session.metaData).dataObj;
    if (!d) return {};
    const kbps = (Number(d.videodatarate) || 0) + (Number(d.audiodatarate) || 0);
    return { kbps: kbps > 0 ? Math.round(kbps) : 0, fps: Number(d.framerate) || 0 };
  } catch (_) {
    return {};
  }
}

// Пульту ведущего (tk-console.js). Зрители поле obsInput пропускают.
function signal(streamKey, state) {
  const io = ioHolder.get();
  if (io) io.to(`stream:${streamKey}`).emit('stream:update', { streamKey, obsInput: state });
}

// obs — подсказка ведущему; у выхода Daily только хронология: его ведущий
// видит свои подсказки (webLive.js).
// Возвращает stop() → { kbps, lowSec } для rtmp.out.
function watch(session, streamKey, { obs }) {
  let frames = 0;
  const handler = session.rtmpVideoHandler;
  session.rtmpVideoHandler = function () {
    frames++;
    return handler.apply(this, arguments);
  };

  const started = Date.now();
  let prev = { at: started, bytes: session.socket.bytesRead, frames: 0 };
  let told = false, low = false, streak = 0, lowSince = 0, lowMs = 0;

  const timer = setInterval(() => {
    // donePublish приходит не всегда (dropPublisher в mediaServer.js) —
    // сессия больше не вещает, и наблюдать нечего.
    if (!session.isPublishing) return clearInterval(timer);
    const now = { at: Date.now(), bytes: session.socket.bytesRead, frames };
    const sec = (now.at - prev.at) / 1000;
    const kbps = Math.round(((now.bytes - prev.bytes) * 8) / sec / 1000);
    const fps = Math.round(((now.frames - prev.frames) / sec) * 10) / 10;
    prev = now;
    const want = declared(session);

    if (!told) {
      told = true;
      streamLog.event(streamKey, 'rtmp.info', {
        size: session.videoWidth ? `${session.videoWidth}×${session.videoHeight}` : '',
        codec: [session.videoCodecName, session.audioCodecName].filter(Boolean).join('/'),
        fps, of: want.fps || null, kbps, want: want.kbps || null,
      });
    }

    const bad = kbps < (want.kbps ? want.kbps * LOW_SHARE : FLOOR_KBPS) || (want.fps > 0 && fps < want.fps * LOW_SHARE);
    streak = bad === low ? 0 : streak + 1;
    if (streak >= LOW_WINDOWS) {
      low = bad;
      streak = 0;
      if (low) {
        lowSince = now.at - LOW_WINDOWS * WINDOW_MS;
        streamLog.event(streamKey, 'rtmp.low', { kbps, want: want.kbps || FLOOR_KBPS, fps, of: want.fps || null });
      } else {
        lowMs += now.at - lowSince;
        streamLog.event(streamKey, 'rtmp.ok', { lowSec: Math.round((now.at - lowSince) / 1000) });
        if (obs) signal(streamKey, 'ok');
      }
    }
    if (low && obs) signal(streamKey, 'low');
  }, WINDOW_MS);
  timer.unref();

  return function stop() {
    clearInterval(timer);
    const sec = (Date.now() - started) / 1000;
    if (low) lowMs += Date.now() - lowSince;
    return {
      kbps: sec > 0 ? Math.round((session.socket.bytesRead * 8) / sec / 1000) : 0,
      lowSec: Math.round(lowMs / 1000) || null,
    };
  };
}

module.exports = { watch, WINDOW_MS };
