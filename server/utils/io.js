// Socket.IO для тех, кому он нужен из глубины, а не из обработчика запроса.
//
// В маршруте сервер берут из `req.app.get('io')`, и это правильно. Но фоновые
// дела — склейка записи, пережатие видео, уборка — начинаются не запросом
// и до `req` не дотягиваются: раньше они просто молчали, и человек не узнавал
// ни что запись готова, ни что она не склеилась.
//
// Протаскивать io параметром через пять слоёв ради одного события дороже,
// чем держать ссылку здесь. Заполняется один раз в app.js, сразу после
// создания сервера; до этого get() возвращает null, и звать его безопасно.

let io = null;

// Зрители комнаты — люди, а не сокеты: вошедший считается один раз, сколько
// бы вкладок ни открыл; skip(socket) — кого не считать вовсе (ведущего,
// владельца камеры). Гостя узнать не по чему, кроме адреса, — с одного
// адреса считаем не больше GUESTS_PER_ADDRESS: сотня сокетов из скрипта
// не поднимает эфир на витрине, а бар с десятком телефонов за одним
// роутером всё ещё считается. Эфиры (sockets/index.js) и камеры заведений
// (utils/venueCam.js) считают одинаково.
const GUESTS_PER_ADDRESS = 10;
function viewers(instance, roomName, skip) {
  const room = instance && instance.sockets.adapter.rooms.get(roomName);
  if (!room) return 0;
  const users = new Set();
  const guests = new Map();
  for (const id of room) {
    const s = instance.sockets.sockets.get(id);
    if (!s || skip(s)) continue;
    if (s.data.userId) users.add(s.data.userId);
    else guests.set(s.data.ip, Math.min((guests.get(s.data.ip) || 0) + 1, GUESTS_PER_ADDRESS));
  }
  let n = users.size;
  for (const k of guests.values()) n += k;
  return n;
}

// Последний разосланный счёт зрителей эфира (sockets/index.js, раз в 2 с).
// Пересчитывать комнату на каждый вход нельзя: десять тысяч входов к началу
// матча в комнату на десять тысяч — сто миллионов шагов. Пустые — вон.
const counts = new Map();
function setCount(streamKey, n) {
  if (n) counts.set(streamKey, n);
  else counts.delete(streamKey);
}
const count = (streamKey) => counts.get(streamKey) || 0;

// На большом эфире медленный режим включается сам: тысячи пишущих — это
// тысячи записей в базу в секунду, а прочесть такой чат всё равно нельзя.
// Ручной режим ведущего длиннее — действует он. stream — с streamKey
// и slowMode.
const AUTO_SLOW_FROM = 1000;
const AUTO_SLOW = 10;
const autoSlow = (streamKey) => (count(streamKey) >= AUTO_SLOW_FROM ? AUTO_SLOW : 0);
const slowFor = (stream) => Math.max(stream.slowMode || 0, autoSlow(stream.streamKey));

module.exports = {
  set(instance) { io = instance; },
  get() { return io; },
  viewers,
  setCount,
  count,
  autoSlow,
  slowFor,
};
