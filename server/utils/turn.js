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
// ttl — короче для проверки связи (utils/netCheck.js): ключ живёт на странице.
function iceServers(userId, ttl = TTL_S) {
  const host = process.env.TURN_HOST;
  const username = Math.floor(Date.now() / 1000 + ttl) + ':' + userId;
  const credential = createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
  return [
    { urls: `stun:${host}:3478` },
    {
      urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`, `turns:${host}:5349?transport=tcp`],
      username,
      credential,
    },
  ];
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

module.exports = { configured, iceServers, PORTS, portsFor };
