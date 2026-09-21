// Socket.IO: присутствие, комнаты эфиров, звонки, доставка сообщений.
//
// Состояние держится в памяти процесса, поэтому pm2 запускает приложение
// в одном экземпляре (ops/ecosystem.config.js). Второй процесс не увидит ни
// счётчика зрителей, ни звонков — для этого нужен Redis-адаптер, он в списке
// работ за рамками текущего объёма.

const User = require('../models/User');
const Message = require('../models/Message');
const Stream = require('../models/Stream');
const streamLog = require('../utils/streamLog');
const daily = require('../utils/daily');
const callLog = require('../utils/callLog');
const errorLog = require('../utils/errorLog');
const turn = require('../utils/turn');
const { LIVE_ROOM } = require('../utils/liveSignal');

// Список подписок приходит от клиента, поэтому и формат, и длина проверяются.
const OBJECT_ID = /^[a-f\d]{24}$/i;
const PRESENCE_SUBSCRIBE_LIMIT = 200;

// Сколько ждать возвращения человека, прежде чем считать обрыв сокета концом
// звонка. Звук и видео идут не через сокет (Daily или свой путь): смена сети на
// телефоне рвёт сокет на секунды, а разговор при этом продолжается. Раньше
// любой такой обрыв завершал звонок у обоих. 20 секунд — столько же Daily
// сам ждёт восстановления своей сигнализации, прежде чем выкинуть участника.
const CALL_GRACE_MS = 20000;

// Сколько ждать, прежде чем объявить человека вне сети. Сайт — многостраничный:
// каждый переход по ссылке закрывает сокет старой страницы и открывает новый.
// Без отсрочки человек на каждом клике на миг уходил в офлайн, а запись
// «в сети» от новой страницы могла проиграть в базе записи «вне сети» от
// старой — и он оставался офлайн, сидя на сайте (жалоба заказчика 21.09).
// Минута (решение 21.09.2026): телефон на секунды теряет сеть в лифте
// и метро, и мигать «вне сети» из-за этого незачем. Смотреть видео или
// печатать — это открытая вкладка, то есть «в сети» и без отсрочки.
const PRESENCE_GRACE_MS = 60000;

// Сигналы своего пути (SDP, кандидаты) — объект от браузера. SDP звонка —
// единицы килобайт; больше — не сигнал.
const SIGNAL_MAX = 32000;

// Возвращает общие хранилища, чтобы app.js положил их в app.set(...):
// маршрут /api/calls/create достаёт их оттуда.
function registerSockets(io) {
  const userConnections = new Map(); // userId -> count
  const userRooms = new Map(); // userId -> Set(socketIds)
  const pendingCalls = new Map(); // callId -> {callerId, calleeId, type, createdAt}
  const activeCalls = new Map(); // callId -> {callerId, calleeId, type, engine: 'daily'|'own', roomName, startedAt}
  const offlineTimers = new Map(); // userId -> таймер отсрочки офлайна
  const presenceWrites = new Map(); // userId -> последняя запись присутствия в очереди

  // Присутствие в базу — по очереди на человека и всегда то, что есть в эту
  // секунду, а не то, что было, когда запись ставили в очередь. Две записи
  // одного человека по разным соединениям пула приходят в базу в любом
  // порядке; очередь и чтение состояния в момент записи это исключают.
  function syncPresence(userId) {
    const prev = presenceWrites.get(userId) || Promise.resolve();
    const next = prev.then(async () => {
      const isOnline = userConnections.has(userId) || offlineTimers.has(userId);
      const set = isOnline ? { isOnline } : { isOnline, lastSeen: new Date() };
      const before = await User.findOneAndUpdate({ _id: userId }, { $set: set }, { projection: { isOnline: 1 } }).lean();
      if (before && !!before.isOnline === isOnline) return; // ничего не поменялось — и звать некого
      io.to(`presence:${userId}`).emit('presence:update', { userId, isOnline, lastSeen: set.lastSeen });
    }).catch((e) => errorLog.server(e, 'socket.presence'));
    presenceWrites.set(userId, next);
    next.then(() => { if (presenceWrites.get(userId) === next) presenceWrites.delete(userId); });
  }

  // После перезапуска в базе остаются «в сети» те, кто был подключён к прошлому
  // процессу. Кто жив — переподключится за секунды и вернёт себе отметку.
  User.updateMany({ isOnline: true }, { $set: { isOnline: false, lastSeen: new Date() } })
    .then(() => { for (const userId of userConnections.keys()) syncPresence(userId); })
    .catch((e) => errorLog.server(e, 'socket.presenceReset'));

  // Зрители эфира — все сокеты в его комнате, кроме вкладок самого ведущего.
  // Раньше ведущий считал и себя: «1 зритель», когда не смотрит никто.
  function viewersIn(roomName, streamKey) {
    const room = io.sockets.adapter.rooms.get(roomName);
    if (!room) return 0;
    let n = 0;
    for (const id of room) {
      const s = io.sockets.sockets.get(id);
      if (s && s.data.ownStreamKey !== streamKey) n++;
    }
    return n;
  }

  const bothSides = (call) => io.to(`user:${call.callerId}`).to(`user:${call.calleeId}`);
  const isParty = (call, userId) => !!call && (userId === call.callerId || userId === call.calleeId);

  // Звонок через свой сервер (public/tk-peer.js): браузеры соединяются между
  // собой, сокет только передаёт сигналы. Каждому — свои ключи TURN;
  // предложение соединения делает звонящий, отвечает собеседник.
  function goOwn(callId, call, event) {
    call.engine = 'own';
    for (const userId of [call.callerId, call.calleeId]) {
      io.to(`user:${userId}`).emit(event, {
        callId, type: call.type, engine: 'own', ice: turn.iceServers(userId), offerer: userId === call.callerId,
      });
    }
  }

  // Комнату звонка удаляем сразу: иначе она жила бы до своего exp,
  // и в неё можно было бы вернуться с ещё действующим токеном.
  function finishCall(callId, event = 'call:ended') {
    const call = pendingCalls.get(callId) || activeCalls.get(callId);
    if (!call) return;
    // До ответа — отмена (у получателя это пропущенный), после — конец разговора.
    callLog.ended(io, callId, event === 'call:failed' ? 'failed' : 'canceled');
    pendingCalls.delete(callId);
    activeCalls.delete(callId);
    bothSides(call).emit(event, { callId });
    if (call.roomName) {
      daily.deleteRoom(call.roomName).catch((e) => errorLog.external(e, 'daily.deleteRoom', { call: callId }));
    }
  }

  function finishCallsOf(userId) {
    for (const [id, c] of pendingCalls) if (isParty(c, userId)) finishCall(id);
    for (const [id, c] of activeCalls) if (isParty(c, userId)) finishCall(id);
  }

  // Человек вышел на связь: всё, что ему написали, пока его не было, дошло.
  // Отправители получают вторую галочку.
  async function markDelivered(userId) {
    const pending = await Message.find({ recipient: userId, deliveredAt: null }).select('_id sender').lean();
    if (!pending.length) return;
    const at = new Date();
    await Message.updateMany({ _id: { $in: pending.map((m) => m._id) } }, { $set: { deliveredAt: at } });
    const bySender = new Map();
    for (const m of pending) {
      const key = String(m.sender);
      if (!bySender.has(key)) bySender.set(key, []);
      bySender.get(key).push(String(m._id));
    }
    for (const [sender, ids] of bySender) io.to(`user:${sender}`).emit('message:delivered', { ids, at });
  }

  io.on('connection', (socket) => {
    console.log('[socket] connected id=', socket.id, 'userId=', socket.data.userId);

    // Presence connect (только для аутентифицированных)
    try {
      const userId = socket.data.userId;
      if (userId) {
        socket.join(`user:${userId}`);
        const set = userRooms.get(userId) || new Set();
        set.add(socket.id);
        userRooms.set(userId, set);
        console.log('[socket] join room', `user:${userId}`, 'size=', set.size);
        const count = (userConnections.get(userId) || 0) + 1;
        userConnections.set(userId, count);
        if (count === 1) {
          // Вернулся в пределах отсрочки (обычный переход по ссылке) — для всех
          // он и не уходил: ни записи, ни события.
          if (offlineTimers.has(userId)) {
            clearTimeout(offlineTimers.get(userId));
            offlineTimers.delete(userId);
          } else {
            // Без await: обработчики ниже обязаны встать в момент подключения.
            syncPresence(userId);
          }
          markDelivered(userId).catch((e) => errorLog.server(e, 'socket.delivered'));
        }
      }
    } catch (e) {
      errorLog.server(e, 'socket.presence');
    }

    // Подписка на присутствие. Раньше presence:update уходил через io.emit —
    // то есть каждому подключённому браузеру про каждого пользователя, кем бы он
    // ему ни приходился. Теперь клиент называет тех, чьи точки у него на экране
    // (шапка собирает их из [data-presence-user]), и получает только их.
    socket.on('presence:subscribe', (ids) => {
      if (!Array.isArray(ids)) return;
      // Потолок на всякий случай: список приходит от клиента, а комнаты стоят памяти.
      for (const id of ids.slice(0, PRESENCE_SUBSCRIBE_LIMIT)) {
        if (typeof id === 'string' && OBJECT_ID.test(id)) socket.join(`presence:${id}`);
      }
    });

    // Страница со списком идущих эфиров (витрина, /authors) просит сообщать
    // ей, когда состав эфиров меняется: кто-то вышел или ушёл. Открыто всем,
    // включая гостей, — витрина и так открыта без входа, а в комнату уходит
    // только «состав изменился», без единого названия и ключа.
    socket.on('live:watch', () => socket.join(LIVE_ROOM));
    socket.on('live:unwatch', () => socket.leave(LIVE_ROOM));

    // «Ты живой?» от вернувшейся вкладки (public/tk-app.js, wake). Телефон
    // замораживает страницу вместе с соединением, и браузер об этом не знает:
    // сокет числится подключённым, а на деле не доставит уже ничего. Само
    // соединение заметит разрыв только по таймауту пинга — до двадцати секунд
    // молчания, за которые человек успеет решить, что сайт не работает.
    socket.on('tk:alive', (ack) => { if (typeof ack === 'function') ack(); });

    socket.on('presence:unsubscribe', (ids) => {
      if (!Array.isArray(ids)) return;
      for (const id of ids.slice(0, PRESENCE_SUBSCRIBE_LIMIT)) {
        if (typeof id === 'string' && OBJECT_ID.test(id)) socket.leave(`presence:${id}`);
      }
    });

    let currentStreamKey = null;

    // Вход в комнату эфира: чат, счётчик зрителей, смена типа эфира.
    // Ключ приходит от клиента — только строка: объект ушёл бы в запрос
    // к базе оператором Mongo.
    socket.on('join-stream-room', async (streamKey, callback) => {
      if (typeof streamKey !== 'string' || !streamKey || streamKey === 'undefined' || streamKey === 'null') {
        console.warn('[socket] join-stream-room с негодным streamKey:', streamKey);
        if (callback) callback({ error: 'Invalid streamKey' });
        return;
      }

      currentStreamKey = streamKey;
      const roomName = `stream:${streamKey}`;

      // Ключ эфира — ключ пользователя: вкладку ведущего узнаём по нему.
      try {
        if (socket.data.userId && await User.exists({ _id: socket.data.userId, streamKey })) {
          socket.data.ownStreamKey = streamKey;
        }
      } catch (e) {
        errorLog.server(e, 'socket.ownerCheck');
      }

      socket.join(roomName);
      const count = viewersIn(roomName, streamKey);
      io.to(roomName).emit('viewers-count-updated', { streamKey, count });
      if (callback) callback({ success: true, count });
    });

    socket.on('disconnect', async () => {
      // Если был в комнате стрима, обновляем счет
      if (currentStreamKey) {
        const roomName = `stream:${currentStreamKey}`;

        // Небольшая задержка чтобы socket точно покинул комнату
        setTimeout(() => {
          io.to(roomName).emit('viewers-count-updated', {
            streamKey: currentStreamKey,
            count: viewersIn(roomName, currentStreamKey),
          });
        }, 50);
      }

      try {
        const userId = socket.data.userId;
        if (userId) {
          const set = userRooms.get(userId) || new Set();
          if (set.has(socket.id)) set.delete(socket.id);
          if (set.size === 0) userRooms.delete(userId); else userRooms.set(userId, set);

          // Звонки завершаем, только если человек не вернулся ни одной вкладкой.
          if (set.size === 0) {
            setTimeout(() => {
              if (!userRooms.has(userId)) finishCallsOf(userId);
            }, CALL_GRACE_MS).unref();
          }

          const cur = (userConnections.get(userId) || 1) - 1;
          if (cur <= 0) {
            userConnections.delete(userId);
            clearTimeout(offlineTimers.get(userId));
            offlineTimers.set(userId, setTimeout(() => {
              offlineTimers.delete(userId);
              if (!userConnections.has(userId)) syncPresence(userId);
            }, PRESENCE_GRACE_MS).unref());
          } else {
            userConnections.set(userId, cur);
          }
        }
      } catch (e) {
        errorLog.server(e, 'socket.disconnect');
      }

    });

    // Звонки. Каждое действие проверяет, кто его совершает: раньше принять,
    // отклонить или завершить чужой звонок мог любой сокет, знающий callId.

    // own — браузер принявшего помнит, что Daily у него не соединялся.
    // Хоть у одного из двоих так — звонок сразу идёт через свой сервер.
    socket.on('call:accept', async ({ callId, own } = {}) => {
      const call = pendingCalls.get(callId);
      if (!call || call.calleeId !== socket.data.userId) return;
      pendingCalls.delete(callId);

      const ownPath = turn.configured() && (call.own || own === true);
      // В активные — до запроса к Daily, чтобы отмена или обрыв во время
      // создания комнаты нашли звонок и завершили его.
      const roomName = `call_${callId}`;
      const active = { ...call, engine: ownPath ? 'own' : 'daily', roomName: ownPath ? null : roomName, startedAt: Date.now() };
      activeCalls.set(callId, active);
      callLog.answered(callId, active.engine);

      // Остальные вкладки того, кому звонят, перестают звонить: разговор
      // идёт в той, где приняли. Иначе в комнату на двоих ломились бы все.
      socket.to(`user:${call.calleeId}`).emit('call:canceled', { callId });

      if (ownPath) return goOwn(callId, active, 'call:accepted');

      try {
        if (!daily.configured()) throw new Error('DAILY_API_KEY или DAILY_DOMAIN не заданы');
        await daily.createRoom(roomName, { max_participants: 2 });
        // Звонок кончился или ушёл на свой сервер, пока создавалась комната.
        if (!activeCalls.has(callId) || active.engine !== 'daily') {
          await daily.deleteRoom(roomName);
          return;
        }
        const url = daily.roomUrl(roomName);
        const [callerToken, calleeToken] = await Promise.all([
          daily.meetingToken({ room: roomName, userId: call.callerId, canSend: true }),
          daily.meetingToken({ room: roomName, userId: call.calleeId, canSend: true }),
        ]);
        io.to(`user:${call.callerId}`).emit('call:accepted', { callId, type: call.type, url, token: callerToken });
        socket.emit('call:accepted', { callId, type: call.type, url, token: calleeToken });
      } catch (e) {
        errorLog.external(e, 'daily.callRoom');
        finishCall(callId, 'call:failed');
      }
    });

    socket.on('call:decline', ({ callId } = {}) => {
      const call = pendingCalls.get(callId);
      if (!call || call.calleeId !== socket.data.userId) return;
      pendingCalls.delete(callId);
      callLog.ended(io, callId, 'declined');
      io.to(`user:${call.callerId}`).emit('call:declined', { callId });
      socket.to(`user:${call.calleeId}`).emit('call:canceled', { callId });
    });

    socket.on('call:cancel', ({ callId } = {}) => {
      const call = pendingCalls.get(callId);
      if (!call || call.callerId !== socket.data.userId) return;
      pendingCalls.delete(callId);
      callLog.ended(io, callId, 'canceled');
      io.to(`user:${call.calleeId}`).emit('call:canceled', { callId });
    });

    socket.on('call:end', ({ callId } = {}) => {
      if (isParty(pendingCalls.get(callId) || activeCalls.get(callId), socket.data.userId)) finishCall(callId);
    });

    // Повторный вход после обрыва: Daily выкинул участника, а звонок жив.
    // Токен выдаётся заново, только участнику и только пока звонок активен.
    socket.on('call:token', async ({ callId } = {}, ack) => {
      if (typeof ack !== 'function') return;
      const call = activeCalls.get(callId);
      const userId = socket.data.userId;
      if (!isParty(call, userId) || call.engine !== 'daily') return ack({ error: 'not_found' });
      try {
        const token = await daily.meetingToken({ room: call.roomName, userId, canSend: true });
        ack({ url: daily.roomUrl(call.roomName), token });
      } catch (e) {
        errorLog.external(e, 'daily.callToken');
        ack({ error: 'token_failed' });
      }
    });

    // Daily у одного из двоих не соединился (tk-daily.js, onStuck): оба
    // переходят на свой сервер. Повтор от второго участника не нужен —
    // звонок уже там. Без TURN переходить некуда: Daily пробует дальше.
    socket.on('call:fallback', ({ callId, reason } = {}) => {
      const call = activeCalls.get(callId);
      if (!isParty(call, socket.data.userId) || call.engine !== 'daily' || !turn.configured()) return;
      const room = call.roomName;
      call.roomName = null;
      callLog.switched(callId, String(reason || '').slice(0, 200));
      goOwn(callId, call, 'call:switch');
      if (room) daily.deleteRoom(room).catch((e) => errorLog.external(e, 'daily.deleteRoom', { call: callId }));
    });

    // Сигналы своего пути — собеседнику как есть. Сервер их не разбирает:
    // проверяет только, что шлёт участник звонка, идущего этим путём.
    socket.on('call:signal', ({ callId, data } = {}) => {
      const call = activeCalls.get(callId);
      const userId = socket.data.userId;
      if (!isParty(call, userId) || call.engine !== 'own' || !data || typeof data !== 'object') return;
      if (JSON.stringify(data).length > SIGNAL_MAX) return;
      const other = userId === call.callerId ? call.calleeId : call.callerId;
      io.to(`user:${other}`).emit('call:signal', { callId, data });
    });
  });

  // ── Сэмплер зрителей ───────────────────────────────────────────────────────
  //
  // Счёт зрителей живёт только в памяти этого процесса и уходит в браузер
  // событием. В базу его не писал никто: Stream.viewers всегда оставался
  // нулём, хотя витрина и поиск по нему сортируют, а после эфира число
  // зрителей пропадало вместе с самим эфиром.
  //
  // Раз в полминуты снимаем счёт по всем идущим эфирам сразу: одна запись
  // в базу на все эфиры, а не на каждый вход и выход зрителя.
  const SAMPLE_MS = 30000;

  setInterval(() => {
    const samples = [];
    for (const room of io.sockets.adapter.rooms.keys()) {
      if (!room.startsWith('stream:')) continue;
      const streamKey = room.slice('stream:'.length);
      samples.push({ streamKey, viewers: viewersIn(room, streamKey) });
    }
    if (!samples.length) return;

    Stream.bulkWrite(
      samples.map(({ streamKey, viewers }) => ({
        updateOne: { filter: { streamKey, isActive: true }, update: { $set: { viewers } } },
      })),
      { ordered: false }
    ).catch((e) => errorLog.server(e, 'socket.viewers'));

    streamLog.sample(samples, SAMPLE_MS / 1000);
  }, SAMPLE_MS).unref();

  return { userConnections, userRooms, pendingCalls, activeCalls };
}

module.exports = { registerSockets };
