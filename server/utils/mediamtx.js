// Свой приём видео: MediaMTX рядом с приложением (ops/mediamtx/).
//
// Зачем. Камера заведения была комнатой Daily на двоих: вещатель отдавал
// картинку каждому зрителю отдельно, и каждая его минута стоила денег.
// Расчёт 23.09 по нашему калькулятору: двадцать камер по шесть часов
// в день — $18 144 в месяц против $864, если камера становится потоком,
// а поток принимаем мы сами. Мост через Daily (его выход RTMP) не годится:
// он стоит $1,14 в час независимо от числа зрителей, то есть на старте,
// с десятком зрителей, выходит дороже нынешнего.
//
// Как устроено. Браузер заведения отдаёт картинку по WHIP (это обычный
// RTCPeerConnection и один POST с SDP), MediaMTX раздаёт её по WHEP
// и, когда зрителей станет больше, чем тянет наш канал, — по HLS.
// Перекодирования нет ни в одном из путей: браузер отдаёт H.264 сразу
// в нужном виде, и двадцать камер не упираются в процессор.
//
// Права. MediaMTX сам никого не знает, поэтому на каждое подключение
// спрашивает нас (authHTTPAddress → routes/venueLive.js, /api/mtx/auth).
// Разрешение — одноразовый ключ на пять минут, выданный владельцу
// на публикацию или гостю на просмотр.

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

// Разрешение на одно подключение: публиковать (владелец) или смотреть (гость).
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

// Состояние потока в MediaMTX: идёт ли он и сколько человек смотрит.
// Ошибку не поднимаем выше: камера не должна ломаться из-за того, что
// не ответил счётчик.
async function state(path) {
  if (!configured()) return { live: false, readers: 0 };
  try {
    const res = await fetch(`${process.env.MTX_API.replace(/\/$/, '')}/v3/paths/get/${encodeURIComponent(path)}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 404) return { live: false, readers: 0 };
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    // ready появляется на секунду позже, чем подключился вещатель: приёмник
    // ждёт, пока соберутся дорожки. Для «идёт ли камера» довольно и того,
    // что источник уже есть, — иначе гость, нажавший «смотреть» сразу
    // за включением, получал бы «камера выключена».
    return { live: !!(data.ready || data.source), readers: Array.isArray(data.readers) ? data.readers.length : 0 };
  } catch (e) {
    errorLog.external(e, 'mediamtx.state', { path });
    return { live: false, readers: 0, unknown: true };
  }
}

// Выключить камеру: закрываем того, кто вещает, — вместе с ним отваливаются
// и зрители. Нужно, когда владелец нажал «выключить» не на той вкладке,
// откуда вещал.
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

module.exports = { configured, pathOf, grant, allowed, url, state, kick };
