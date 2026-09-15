// Веб-эфир в HLS: ведущий вещает с камеры в комнату Daily, Daily отдаёт
// комнату по RTMP на наш приём 1935, дальше тот же ffmpeg и HLS, что у OBS
// (utils/hls.js). Зритель в комнату не входит: минута зрителя в Daily стоит
// $0,004, минута RTMP-выхода — $0,015 на весь эфир (решение 15.09.2026).
//
// Публикацию Daily приём узнаёт по src=daily в адресе (mediaServer.js): она
// не переключает эфир на OBS, и начало с концом эфира по-прежнему решает
// ведущий, а не RTMP-соединение.

const daily = require('./daily');
const { buildObsStreamKey } = require('./rtmpAuth');
const Stream = require('../models/Stream');

// Выход сразу таким, каким его отдаёт наш транскод: 720p30, 2500 кбит/с —
// по умолчанию Daily шлёт 1080p30 на 5 Мбит/с, и мы бы гоняли лишнее.
const OUTPUT = { width: 1280, height: 720, fps: 30, videoBitrate: 2500, audioBitrate: 128 };

// Выход живёт не дольше комнаты (ROOM_TTL_S в utils/daily.js). Без эфира
// в комнате — минута: закрытая вкладка ведущего не должна час слать зрителям
// пустой кадр. Вернувшийся за минуту ведущий продолжает тот же выход.
const MAX_DURATION_S = 12 * 60 * 60;
const IDLE_TIMEOUT_S = 60;

// Подпись приёма на сутки: адрес уходит только в Daily и нужен на один эфир.
const SIGN_TTL_DAYS = 1;

// Ведущий уже вошёл в комнату, а API Daily ещё несколько секунд отвечает
// 404 «does not seem to be hosting a call» — звонок у него не успел
// появиться. Замечено 15.09.2026 на первом же прогоне. Ждём до ~15 с.
const START_TRIES = 10;
const START_RETRY_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Обрыв RTMP между Daily и нами посреди эфира — выход запускается заново.
// Не больше трёх раз подряд: дальше чинить надо не перезапуском.
const RESTART_DELAY_MS = 5000;
const MAX_RESTARTS = 3;

// streamKey -> { room, rtmpUrl, restarts }
const outputs = new Map();

function ingestUrl(host, streamKey) {
  const key = buildObsStreamKey(streamKey, SIGN_TTL_DAYS);
  return `rtmp://${host}:1935/live/${key}${key.includes('?') ? '&' : '?'}src=daily`;
}

function launch(room, rtmpUrl) {
  return daily.startLiveStreaming(room, {
    rtmpUrl,
    ...OUTPUT,
    layout: { preset: 'default' },
    maxDuration: MAX_DURATION_S,
    minIdleTimeOut: IDLE_TIMEOUT_S,
  });
}

// Ведущий уже в комнате: без звонка Daily выход не запустит. Хост — тот,
// на котором открыт пульт, как у адреса приёма для OBS (streamPages.js).
async function start({ streamKey, dailyRoomName }, host) {
  const rtmpUrl = ingestUrl(host, streamKey);
  for (let attempt = 1; ; attempt++) {
    try {
      await launch(dailyRoomName, rtmpUrl);
      if (attempt > 1) console.log(`[webLive ${streamKey}] выход Daily запущен с попытки ${attempt}`);
      break;
    } catch (err) {
      if (err.status !== 404 || attempt >= START_TRIES) throw err;
      await sleep(START_RETRY_MS);
    }
  }
  outputs.set(streamKey, { room: dailyRoomName, rtmpUrl, restarts: 0 });
}

// Ведущий остановил эфир. Удаление комнаты гасит выход и само, но пауза
// может разойтись с удалением — гасим явно.
async function stop({ streamKey, dailyRoomName }) {
  outputs.delete(streamKey);
  if (dailyRoomName) await daily.stopLiveStreaming(dailyRoomName);
}

// Публикация Daily закончилась (mediaServer.js, donePublish). Если ведущий
// эфир не останавливал — это обрыв, и выход запускается снова в ту же комнату.
function ended(streamKey) {
  const out = outputs.get(streamKey);
  if (!out) return;
  if (out.restarts >= MAX_RESTARTS) {
    console.error(`[webLive ${streamKey}] выход Daily обрывается подряд ${MAX_RESTARTS} раза, больше не запускаем`);
    outputs.delete(streamKey);
    return;
  }
  out.restarts++;
  setTimeout(async () => {
    if (outputs.get(streamKey) !== out) return;
    try {
      const stream = await Stream.findOne({ streamKey }).select('isActive dailyRoomName streamType').lean();
      if (!stream || !stream.isActive || stream.streamType !== 'daily-stream' || stream.dailyRoomName !== out.room) {
        outputs.delete(streamKey);
        return;
      }
      console.warn(`[webLive ${streamKey}] выход Daily оборвался, запуск ${out.restarts}/${MAX_RESTARTS}`);
      await launch(out.room, out.rtmpUrl);
    } catch (err) {
      console.error(`[webLive ${streamKey}] выход Daily не перезапустился:`, err.message);
    }
  }, RESTART_DELAY_MS).unref();
}

// Публикация Daily пошла — счётчик обрывов подряд обнуляется.
function published(streamKey) {
  const out = outputs.get(streamKey);
  if (out) out.restarts = 0;
}

module.exports = { start, stop, ended, published };
