// Свой TURN (coturn, ops/coturn/turnserver.conf) — запасной путь звонков.
//
// У части людей в России провайдер душит соединения с серверами Daily, а до
// нашего сервера всё доходит. Проверка 17.09.2026 (тестовая страница, потом удалена):
// через наш TURN по UDP видеопоток держится и по Wi-Fi, и по мобильному;
// TCP и TLS на мобильном замирают через 10–15 секунд — остаются последним
// запасом для сетей, где UDP закрыт целиком.
//
// Ключи временные, по схеме coturn use-auth-secret (TURN REST API):
// имя = «срок годности:пользователь», пароль = HMAC-SHA1 имени общим
// секретом. Секрет живёт только в .env и в конфиге coturn.

const { createHmac } = require('crypto');

// Ключ нужен только на вход и повторный вход в звонок; с запасом на долгий разговор.
const TTL_S = 12 * 60 * 60;

function configured() {
  return !!(process.env.TURN_SECRET && process.env.TURN_HOST);
}

// Серверы для RTCPeerConnection: STUN — для прямого соединения браузеров,
// TURN — когда напрямую не выходит. Порядок адресов TURN — порядок
// предпочтения: UDP, потом TCP, потом TLS.
// callId — третьим полем имени: coturn пишет имя в каждую строку журнала,
// и по нему utils/turnLog.js раскладывает реле по звонкам. Подпись
// считается от имени целиком, срок coturn берёт из числа до первого «:».
function iceServers(userId, { ttl = TTL_S, callId = '' } = {}) {
  const username = Math.floor(Date.now() / 1000 + ttl) + ':' + userId + (callId ? ':' + callId : '');
  return [{ urls: `stun:${process.env.TURN_HOST}:3478` }, relayFor(username)];
}

// Ключ проверки связи (/check, routes/pages.js; аудит 14.10, S9). Раньше
// каждое открытие страницы давало новый ключ на 10 минут, а user-quota
// coturn считает реле на имя ключа, — один человек, обновляя страницу,
// мог занять все порты. Теперь:
//  • имя одно на человека на минуту (срок округлён до минуты) — открытия
//    в ту же минуту получают тот же ключ, и квота считает их вместе;
//  • живёт 2 минуты — проверке хватает полминуты;
//  • разных ключей — не больше CHECK_PER за 10 минут; сверх — null, и
//    страница говорит «проверяли недавно».
// Третье поле — netcheck: utils/turnLog.js видит такие реле по человеку.
const CHECK_TTL_S = 120;
const CHECK_WINDOW_MS = 10 * 60 * 1000;
const CHECK_PER = 3;
const checks = new Map(); // userId → [{ name, at }]

function checkIce(userId) {
  const now = Date.now();
  const expiry = (Math.floor(now / 60000) + 1) * 60 + CHECK_TTL_S;
  const name = expiry + ':' + userId + ':netcheck';
  const list = (checks.get(String(userId)) || []).filter((x) => now - x.at < CHECK_WINDOW_MS);
  if (!list.some((x) => x.name === name)) {
    if (list.length >= CHECK_PER) { checks.set(String(userId), list); return null; }
    list.push({ name, at: now });
  }
  checks.set(String(userId), list);
  if (checks.size > 10000) checks.delete(checks.keys().next().value);
  return relayFor(name);
}

function relayFor(username) {
  const host = process.env.TURN_HOST;
  const credential = createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
  return {
    urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`, `turns:${host}:5349?transport=tcp`],
    username,
    credential,
  };
}

// Порты реле — min-port..max-port в ops/coturn/turnserver.conf, 49160–49400.
// Поменяли там — поменять и здесь (или TURN_PORTS в .env).
const PORTS = Number(process.env.TURN_PORTS) || 241;

// Сколько портов держит разговор своим путём. Браузер берёт реле на каждый
// адрес TURN из iceServers (их три: UDP, TCP, TLS) на каждое соединение
// и держит до конца звонка — даже когда пошёл напрямую (замер 25.09.2026).
// Сетка: у n человек n·(n−1) концов соединений. 1:1 — 6, вчетвером — 36.
// Оценка сверху для IPv4; двухстековая сеть может взять вдвое больше.
const portsFor = (members) => members * (members - 1) * 3;

module.exports = { configured, iceServers, checkIce, PORTS, portsFor, CHECK_PER };
