// Свой приёмник видео: MediaMTX рядом с приложением (ops/mediamtx/).
//
// Камера заведения была комнатой Daily: каждая минута каждого зрителя
// стоила денег. С 23.09 заведение вещает по WHIP сюда. С 25.09 (вариант А,
// utils/venueCam.js) MediaMTX — только приёмник: зрителям он не отдаёт
// ничего, поток с петли забирает наш ffmpeg и режет HLS для Bunny. Наш
// канал (16 ТБ в месяц) на раздачу не тратится.
//
// Права. MediaMTX сам никого не знает, поэтому на каждое подключение
// спрашивает нас (authHTTPAddress → routes/venueLive.js, /api/mtx/auth).
// Вещать — одноразовый ключ на пять минут, выданный владельцу. Читать —
// только нашему ffmpeg по RTSP с петли.

const errorLog = require('./errorLog');
const { randomBytes } = require('crypto');

// Ключ живёт ровно столько, сколько нужно, чтобы дойти от ответа сервера
// до подключения. Само подключение после этого не рвётся: MediaMTX
// спрашивает нас один раз, на входе.
const KEY_TTL_MS = 5 * 60 * 1000;

// Ключи в памяти процесса — как и звонки (sockets/index.js): приложение
// запускается в одном экземпляре. Переживать перезапуск им незачем.
const keys = new Map(); // ключ → { path, action, userId, expires }

function configured() {
  return !!(process.env.MTX_PUBLIC && process.env.MTX_API);
}

// Имя потока камеры. Прежняя комната Daily называлась так же — чтобы
// в журналах и настройках ничего не переучивать.
const pathOf = (venueId) => `venue_${venueId}`;

function sweep() {
  const now = Date.now();
  for (const [key, grant] of keys) if (grant.expires < now) keys.delete(key);
}

// Разрешение на одно подключение: публиковать (владелец).
function grant(path, action, userId) {
  sweep();
  const key = randomBytes(16).toString('hex');
  keys.set(key, { path, action, userId: String(userId), expires: Date.now() + KEY_TTL_MS });
  return key;
}

// Ответ на вопрос MediaMTX «пускать ли». Ключ одноразовый: повторное
// подключение просит новый, иначе подсмотренный адрес работал бы вечно.
function allowed({ path, action, query }) {
  sweep();
  const key = new URLSearchParams(query || '').get('key');
  const found = key && keys.get(key);
  if (!found) return false;
  keys.delete(key);
  return found.path === path && found.action === action;
}

// Адрес для браузера. Отдаём готовую строку: путь и ключ собираются
// здесь, чтобы в маршрутах и на страницах их не склеивали по-разному.
function url(path, kind, key) {
  return `${process.env.MTX_PUBLIC.replace(/\/$/, '')}/${path}/${kind}?key=${key}`;
}

// Откуда ffmpeg забирает поток: RTSP слушает только петлю (ops/mediamtx/).
const readUrl = (path) => `rtsp://127.0.0.1:8554/${path}`;

// Какие камеры сейчас вещают — после перезапуска приложения (venueCam.resume).
// ready — у MediaMTX 1.21 это «поток можно читать».
async function livePaths() {
  if (!configured()) return [];
  try {
    const res = await fetch(`${process.env.MTX_API.replace(/\/$/, '')}/v3/paths/list`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { items } = await res.json();
    return (items || []).filter((p) => p.ready && /^venue_/.test(p.name)).map((p) => p.name);
  } catch (e) {
    errorLog.external(e, 'mediamtx.livePaths');
    return [];
  }
}

// Выключить камеру: закрываем того, кто вещает. Нужно, когда владелец
// нажал «выключить» не на той вкладке, откуда вещал, и при бане.
async function kick(path) {
  if (!configured()) return;
  try {
    await fetch(`${process.env.MTX_API.replace(/\/$/, '')}/v3/webrtcsessions/list`, { signal: AbortSignal.timeout(3000) })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then(({ items }) => Promise.all((items || [])
        .filter((s) => s.path === path && s.state === 'publish')
        .map((s) => fetch(`${process.env.MTX_API.replace(/\/$/, '')}/v3/webrtcsessions/kick/${s.id}`, {
          method: 'POST', signal: AbortSignal.timeout(3000),
        }))));
  } catch (e) {
    errorLog.external(e, 'mediamtx.kick', { path });
  }
}

module.exports = { configured, pathOf, grant, allowed, url, readUrl, livePaths, kick };
