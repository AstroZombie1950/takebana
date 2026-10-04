// Частота событий с одного сокета (аудит 28.09, «Безопасность»: у сокетов
// не было лимита — гость мог засыпать venue:join, а это чтение базы на
// каждое событие).
//
// Три ведра на соединение, у каждого ёмкость (сколько можно разом) и
// пополнение в секунду:
//   signal — сигналы звонка своим путём. Браузер шлёт кандидатов ICE
//            пачками: на каждый адрес TURN и интерфейс, в группе — на каждое
//            соединение сетки, при перезапуске ICE — заново. Потолок
//            с запасом против замера на зонде группового звонка (STATUS,
//            4 октября);
//   heavy  — то, что ходит в базу или к Daily;
//   light  — остальное: пульс, «свернул», выход из звонка, неизвестные.
// Сверх ведра событие отбрасывается, ждущему ответа — { error }. Первое
// превышение на соединении — в журнал ошибок; кто засыпает и дальше
// (FLOOD_DROPS отброшенных), того отключаем: настоящая вкладка столько
// не шлёт, а переподключится сама.
const errorLog = require('./errorLog');

const BUCKETS = {
  signal: { cap: 400, rate: 100 },
  heavy: { cap: 30, rate: 3 },
  light: { cap: 60, rate: 20 },
};
const CLASS = {
  'call:signal': 'signal',
  'venue:join': 'heavy',
  'join-stream-room': 'heavy',
  'presence:subscribe': 'heavy',
  'call:invite': 'heavy',
  'call:accept': 'heavy',
  'call:token': 'heavy',
  'call:fallback': 'heavy',
};
const FLOOD_DROPS = 300;

// Подключается в sockets/index.js: socket.use(socketLimit(socket)).
function socketLimit(socket) {
  const buckets = {};
  let dropped = 0;
  return (packet, next) => {
    const event = String(packet[0]);
    const kind = CLASS[event] || 'light';
    const { cap, rate } = BUCKETS[kind];
    const now = Date.now();
    const b = buckets[kind] || (buckets[kind] = { tokens: cap, at: now });
    b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return next();
    }
    dropped++;
    const ack = packet[packet.length - 1];
    if (typeof ack === 'function') ack({ error: 'Rate limited' });
    const who = { event, kind, userId: socket.data.userId || null, ip: socket.data.ip || '' };
    if (dropped === 1) errorLog.server(new Error(`Сокет превысил частоту событий: ${event}`), 'socket.flood', who);
    if (dropped === FLOOD_DROPS) {
      errorLog.server(new Error(`Сокет засыпает событиями (${FLOOD_DROPS} отброшено), отключён`), 'socket.flood', who);
      socket.disconnect(true);
    }
  };
}

module.exports = socketLimit;
