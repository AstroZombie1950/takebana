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
const errorLog = require('./errorLog');
const streamLog = require('./streamLog');
const hls = require('./hls');
const ioHolder = require('./io');

// Выход сразу таким, каким его отдаёт наш транскод: 720p30, 2500 кбит/с —
// по умолчанию Daily шлёт 1080p30 на 5 Мбит/с, и мы бы гоняли лишнее.
// Кадр — по камере ведущего: телефон вертикально — 720×1280. Всегда
// 1280×720 вшивал вертикальной камере чёрные полосы по бокам, и на телефоне
// во весь экран запись шла ещё и с полосами сверху и снизу (21.09).
const OUTPUT = { fps: 30, videoBitrate: 2500, audioBitrate: 128 };
const size = (portrait) => (portrait ? { width: 720, height: 1280 } : { width: 1280, height: 720 });

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

// Обрыв выхода посреди эфира: RTMP от Daily к нам закрылся.
//
// До 02.10 выход перезапускали три раза за ~15 с, а ответ 404 «does not
// seem to be hosting a call» считали уходом ведущего и бросали эфир. Журналы
// Daily за 01.10 показали обратное: ведущий оставался в комнате ещё 12 минут,
// просто его телефон каждые 20–30 с терял связь с Daily и поднимал её снова
// (c45cd7d9). Эфир при этом числился идущим, а у зрителей был чёрный экран.
// Тот же 404 Daily отдаёт и живому ведущему — на старте каждого эфира выход
// шёл со второй попытки.
//
// Теперь пробуем, пока эфир идёт, с паузами RETRY_MS (последняя повторяется),
// но не дольше RECOVER_MS. Зрители и пульт видят «переподключаемся»
// (stream:update reconnecting), а не чёрный экран; каждый шаг — в хронологии
// эфира. Не вернулся — «связь потеряна»: ведущий был в комнате — запись
// в журнал ошибок, не было — он ушёл, эфир подберёт уборка.
const RETRY_MS = [3000, 5000, 10000, 15000, 20000, 30000];
const RECOVER_MS = 5 * 60 * 1000;
// Daily ответил «запущено», а RTMP к нам так и не пришёл — попытка не удалась.
const ARRIVE_MS = 30 * 1000;

// Ведущего нет в комнате Daily (02.10, c45cd7d9: Ростелеком без VPN — Daily
// видел ведущую 5 секунд из пятнадцати минут). Выход при этом жил: Daily слал
// пустой кадр, пока не гасил его по простою через 120 с, мы поднимали снова —
// семь раз, и зрители смотрели чёрное. Теперь, пока выход идёт, раз в
// WATCH_MS спрашиваем Daily, кто в комнате. Два «никого» подряд — зрителям
// сразу «связь с ведущим потеряна», пустой выход гасим (минута выхода у Daily
// платная). Обрыв выхода при пустой комнате — не поднимаем, а ждём ведущего,
// проверяя раз в GONE_POLL_MS; вернулся — поднимаем. Ошибка запроса
// присутствия — «неизвестно», считаем, что ведущий на месте.
const WATCH_MS = 15000;
const GONE_CHECKS = 2;
const GONE_POLL_MS = 10000;

// streamKey -> { room, rtmpUrl, portrait, down, tries, timer, watch, absent, gone }
//   down — когда выход оборвался (null — идёт), tries — попыток с тех пор;
//   watch — таймер проверки присутствия, absent — «никого» подряд,
//   gone — ведущего нет в комнате, зрителям сказано.
const outputs = new Map();

function ingestUrl(host, streamKey) {
  const key = buildObsStreamKey(streamKey, SIGN_TTL_DAYS);
  return `rtmp://${host}:1935/live/${key}${key.includes('?') ? '&' : '?'}src=daily`;
}

function launch(room, rtmpUrl, portrait) {
  return daily.startLiveStreaming(room, {
    rtmpUrl,
    ...OUTPUT,
    ...size(portrait),
    layout: { preset: 'default' },
    maxDuration: MAX_DURATION_S,
    minIdleTimeOut: IDLE_TIMEOUT_S,
  });
}

// Зрителям и пульту — состояние выхода (tk-viewer.js, tk-console.js).
function signal(streamKey, payload) {
  const io = ioHolder.get();
  if (io) io.to(`stream:${streamKey}`).emit('stream:update', { streamKey, ...payload });
}

// Есть ли ведущий в комнате, по мнению Daily. Ошибка — «неизвестно»: это
// подробность для хронологии, а не условие перезапуска.
function hostPresence(room) {
  return daily.presence(room)
    .then((r) => ({ host: (r.total_count || 0) > 0 }))
    .catch(() => ({ host: null }));
}

// Ведущий уже в комнате: без звонка Daily выход не запустит. Хост — как
// у адреса приёма для OBS (utils/site.js, publicHost).
async function start({ streamKey, dailyRoomName, portrait }, host) {
  const rtmpUrl = ingestUrl(host, streamKey);
  const t0 = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      await launch(dailyRoomName, rtmpUrl, portrait);
      if (attempt > 1) console.log(`[webLive ${streamKey}] выход Daily запущен с попытки ${attempt}`);
      streamLog.event(streamKey, 'daily.out.start', { attempt, ms: Date.now() - t0 });
      break;
    } catch (err) {
      if (err.status !== 404 || attempt >= START_TRIES) throw err;
      await sleep(START_RETRY_MS);
    }
  }
  const prev = outputs.get(streamKey);
  if (prev) { clearTimeout(prev.timer); clearTimeout(prev.watch); }
  const out = { room: dailyRoomName, rtmpUrl, portrait, down: null, tries: 0, timer: null, watch: null, absent: 0, gone: false };
  outputs.set(streamKey, out);
  watchHost(streamKey, out);
}

// Ведущий остановил эфир. Удаление комнаты гасит выход и само, но пауза
// может разойтись с удалением — гасим явно. Место конвейера больше не держим.
async function stop({ streamKey, dailyRoomName }) {
  const out = outputs.get(streamKey);
  if (out) { clearTimeout(out.timer); clearTimeout(out.watch); }
  outputs.delete(streamKey);
  hls.release(streamKey);
  if (dailyRoomName) await daily.stopLiveStreaming(dailyRoomName);
}

// Публикация Daily закончилась (mediaServer.js, donePublish). Если ведущий
// эфир не останавливал — это обрыв. true — выход будем поднимать, и конвейеру
// есть смысл держать свой режим (utils/hls.js, held); false — выхода мы не
// знаем (процесс перезапускали посреди эфира), поднимать некому.
function ended(streamKey) {
  const out = outputs.get(streamKey);
  if (!out) return false;
  if (!out.down) {
    out.down = Date.now();
    out.tries = 0;
    signal(streamKey, { reconnecting: true });
    hostPresence(out.room).then((p) => streamLog.event(streamKey, 'daily.out.drop', p));
  }
  schedule(streamKey, out);
  return true;
}

// Пока выход идёт — есть ли ведущий в комнате.
function watchHost(streamKey, out) {
  clearTimeout(out.watch);
  out.watch = setTimeout(async () => {
    if (outputs.get(streamKey) !== out || out.down) return;
    const p = await hostPresence(out.room);
    if (outputs.get(streamKey) !== out || out.down) return;
    out.absent = p.host === false ? out.absent + 1 : 0;
    if (out.absent >= GONE_CHECKS) return hostGone(streamKey, out);
    watchHost(streamKey, out);
  }, WATCH_MS);
  out.watch.unref();
}

// Ведущего нет — зрителям сразу «связь потеряна», ведущему — подсказка
// про сеть (tk-console.js, hostGone). Выход гасим; RTMP закроется, и
// ended() не скажет «переподключаемся» поверх — down уже стоит.
function hostGone(streamKey, out) {
  out.gone = true;
  out.absent = 0;
  if (!out.down) { out.down = Date.now(); out.tries = 0; }
  streamLog.event(streamKey, 'daily.host.gone', {});
  signal(streamKey, { reconnecting: false, lost: true, hostGone: true });
  daily.stopLiveStreaming(out.room).catch(() => {});
  schedule(streamKey, out, GONE_POLL_MS);
}

function schedule(streamKey, out, ms) {
  clearTimeout(out.timer);
  out.timer = setTimeout(() => retry(streamKey, out), ms || RETRY_MS[Math.min(out.tries, RETRY_MS.length - 1)]);
  out.timer.unref();
}

async function retry(streamKey, out) {
  if (outputs.get(streamKey) !== out || !out.down) return;
  let stream;
  try {
    stream = await Stream.findOne({ streamKey }).select('isActive dailyRoomName streamType').lean();
  } catch (err) {
    errorLog.server(err, 'webLive.restart', { streamKey });
    return schedule(streamKey, out);
  }
  // Эфир уже не идёт: погасила модерация (она удаляет комнату, и выход
  // рвётся), ведущий ушёл на паузу, эфир удалён. Место конвейера отпускаем.
  if (!stream || !stream.isActive || stream.streamType !== 'daily-stream' || stream.dailyRoomName !== out.room) {
    outputs.delete(streamKey);
    hls.release(streamKey);
    return;
  }
  if (Date.now() - out.down > RECOVER_MS) return giveUp(streamKey, out);

  // Ведущего нет в комнате — выход поднимать не к чему: Daily дал бы
  // зрителям ещё две минуты пустого кадра. Ждём его.
  const p = await hostPresence(out.room);
  if (outputs.get(streamKey) !== out || !out.down) return;
  if (p.host === false) {
    if (!out.gone) hostGone(streamKey, out);
    else schedule(streamKey, out, GONE_POLL_MS);
    return;
  }

  out.tries++;
  console.warn(`[webLive ${streamKey}] выход Daily оборвался, запуск ${out.tries}`);
  try {
    await launch(out.room, out.rtmpUrl, out.portrait);
    streamLog.event(streamKey, 'daily.out.retry', { n: out.tries, ok: true });
    clearTimeout(out.timer);
    out.timer = setTimeout(() => { if (outputs.get(streamKey) === out && out.down) schedule(streamKey, out); }, ARRIVE_MS);
    out.timer.unref();
  } catch (err) {
    streamLog.event(streamKey, 'daily.out.retry', { n: out.tries, status: err.status || 0, msg: String(err.message || '').slice(0, 120) });
    // 400 — Daily считает прежний выход ещё живым: гасим его, следующая
    // попытка запустит заново. 404 — звонка у ведущего сейчас нет (связь
    // рвётся) — просто ждём.
    if (err.status === 400) await daily.stopLiveStreaming(out.room).catch(() => {});
    else if (err.status !== 404 && !(err.status >= 500) && err.status) errorLog.external(err, 'webLive.restart', { streamKey });
    schedule(streamKey, out);
  }
}

async function giveUp(streamKey, out) {
  clearTimeout(out.watch);
  outputs.delete(streamKey);
  hls.release(streamKey);
  const p = await hostPresence(out.room);
  const downMs = Date.now() - out.down;
  streamLog.event(streamKey, 'daily.out.lost', { ...p, downMs, tries: out.tries });
  signal(streamKey, { reconnecting: false, lost: true });
  if (p.host === false) return console.warn(`[webLive ${streamKey}] ведущего нет в комнате Daily, выход больше не запускаем`);
  errorLog.external(new Error(`выход Daily не вернулся за ${Math.round(downMs / 60000)} мин, ведущий ${p.host ? 'в комнате' : 'неизвестно где'}`),
    'webLive.lost', { streamKey, tries: out.tries });
}

// Публикация Daily пошла — выход вернулся (или пошёл впервые).
function published(streamKey) {
  const out = outputs.get(streamKey);
  if (!out) return;
  clearTimeout(out.timer);
  if (out.down) {
    streamLog.event(streamKey, 'daily.out.back', { downMs: Date.now() - out.down, tries: out.tries, gone: out.gone });
    signal(streamKey, { reconnecting: false, hostGone: false });
  }
  out.down = null;
  out.tries = 0;
  out.gone = false;
  out.absent = 0;
  watchHost(streamKey, out);
}

module.exports = { start, stop, ended, published };
