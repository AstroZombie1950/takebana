// Свой TURN (coturn, ops/coturn/turnserver.conf) — запасной путь звонков.
//
// У части людей в России провайдер душит соединения с серверами Daily, а до
// нашего сервера всё доходит. Проверка 17.09.2026 (public/turn-probe.html):
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
function iceServers(userId) {
  const host = process.env.TURN_HOST;
  const username = Math.floor(Date.now() / 1000 + TTL_S) + ':' + userId;
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

module.exports = { configured, iceServers };
