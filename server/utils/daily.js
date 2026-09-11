// Daily.co: комнаты и токены участников.
//
// Единственное место, которое знает ключ API. Раньше обращения к Daily жили
// в двух местах и расходились в настройках: комнаты эфиров создавались
// публичными, комнаты звонков — без указания приватности, то есть тоже
// публичными. Для входа хватало имени комнаты.
//
// Теперь все комнаты закрытые: вход только с токеном, токен выдаёт сервер
// после проверки прав, и права вписаны в сам токен — кто может отправлять
// звук и видео, а кто только смотрит.

const { createHmac } = require('crypto');

const API = 'https://api.daily.co/v1';
const TIMEOUT_MS = 10000;

// Окно входа в комнату. exp комнаты никого не выгоняет — он только не пускает
// новых. Но повторный вход после обрыва — тоже вход, поэтому окно берётся
// с запасом на самый длинный эфир. Раньше здесь стояли два часа плюс
// eject_after_elapsed: 7200, и эфир обрывался ровно через два часа.
const ROOM_TTL_S = 12 * 60 * 60;

// Токен тоже только открывает вход: eject_at_token_exp не ставим, иначе он
// выгонял бы по истечении. Повторный вход после обрыва берёт у сервера свежий
// токен. Запас — на случай, если автоматическое переподключение самого Daily
// предъявляет прежний: без живого обрыва это не проверить.
const TOKEN_TTL_S = 4 * 60 * 60;

const now = () => Math.floor(Date.now() / 1000);

function configured() {
  return Boolean(process.env.DAILY_API_KEY && process.env.DAILY_DOMAIN);
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.DAILY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Daily ${method} ${path}: ${res.status} ${data.info || data.error || ''}`.trim());
    err.status = res.status;
    throw err;
  }
  return data;
}

// Имя задаёт вызывающий из символов [\w-]: оно уходит в путь запроса.
function createRoom(name, properties = {}) {
  return api('POST', '/rooms', {
    name,
    privacy: 'private',
    properties: { exp: now() + ROOM_TTL_S, ...properties },
  });
}

// Удаление выгоняет всех, кто внутри. 404 — комнаты уже нет, это не ошибка.
async function deleteRoom(name) {
  try {
    await api('DELETE', `/rooms/${encodeURIComponent(name)}`);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

function roomUrl(name) {
  return `https://${process.env.DAILY_DOMAIN}.daily.co/${name}`;
}

// domain_id нужен самоподписанному токену и не меняется, пока жив аккаунт.
// Раньше за ним ходили в API на каждый выданный токен, то есть на каждого зрителя.
let domainId = null;
function getDomainId() {
  if (!domainId) {
    domainId = api('GET', '/').then((d) => d.domain_id);
    domainId.catch(() => { domainId = null; });
  }
  return domainId;
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

// JWT HS256 на ключе API — всё, что нужно от jsonwebtoken, в четыре строки.
function sign(payload) {
  const body = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}`;
  const sig = createHmac('sha256', process.env.DAILY_API_KEY).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// Самоподписанный токен — без запроса к Daily на каждого участника.
// Сокращённые ключи из документации Daily (self-signing tokens): r — комната,
// d — домен, ud — id участника (до 36 знаков), o — владелец, vo/ao — войти
// без камеры и микрофона, p.cs — право отправлять звук и видео, p.hp —
// видимость в списке участников. Имён Daily не передаём: сторонний сервис,
// а показывать их из его списка участников незачем.
async function meetingToken({ room, userId, owner = false, canSend = false, presence = true }) {
  const iat = now();
  return sign({
    r: room,
    d: await getDomainId(),
    iat,
    exp: iat + TOKEN_TTL_S,
    ud: String(userId).slice(0, 36),
    o: owner,
    vo: !canSend,
    ao: !canSend,
    p: { hp: presence, cs: canSend },
  });
}

module.exports = { configured, createRoom, deleteRoom, roomUrl, meetingToken };
