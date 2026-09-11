// Socket.IO: присутствие, комнаты эфиров, звонки.
//
// Состояние держится в памяти процесса, поэтому pm2 запускает приложение
// в одном экземпляре (ops/ecosystem.config.js). Второй процесс не увидит ни
// счётчика зрителей, ни звонков — для этого нужен Redis-адаптер, он в списке
// работ за рамками текущего объёма.

const User = require('../models/User');
const daily = require('../utils/daily');

// Список подписок приходит от клиента, поэтому и формат, и длина проверяются.
const OBJECT_ID = /^[a-f\d]{24}$/i;
const PRESENCE_SUBSCRIBE_LIMIT = 200;

// Сколько ждать возвращения человека, прежде чем считать обрыв сокета концом
// звонка. Звук и видео идут через Daily, а не через сокет: смена сети на
// телефоне рвёт сокет на секунды, а разговор при этом продолжается. Раньше
// любой такой обрыв завершал звонок у обоих. 20 секунд — столько же Daily
// сам ждёт восстановления своей сигнализации, прежде чем выкинуть участника.
const CALL_GRACE_MS = 20000;

// Возвращает общие хранилища, чтобы app.js положил их в app.set(...):
// маршрут /api/calls/create достаёт их оттуда.
function registerSockets(io) {
  const userConnections = new Map(); // userId -> count
  const userRooms = new Map(); // userId -> Set(socketIds)
  const pendingCalls = new Map(); // callId -> {callerId, calleeId, type, createdAt}
  const activeCalls = new Map(); // callId -> {callerId, calleeId, type, roomName, startedAt}

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

  // Комнату звонка удаляем сразу: иначе она жила бы до своего exp,
  // и в неё можно было бы вернуться с ещё действующим токеном.
  function finishCall(callId, event = 'call:ended') {
    const call = pendingCalls.get(callId) || activeCalls.get(callId);
    if (!call) return;
    pendingCalls.delete(callId);
    activeCalls.delete(callId);
    bothSides(call).emit(event, { callId });
    if (call.roomName) {
      daily.deleteRoom(call.roomName).catch((e) => console.error('[call] room delete', e.message));
    }
  }

  function finishCallsOf(userId) {
    for (const [id, c] of pendingCalls) if (isParty(c, userId)) finishCall(id);
    for (const [id, c] of activeCalls) if (isParty(c, userId)) finishCall(id);
  }

  io.on('connection', async (socket) => {
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
          await User.updateOne({ _id: userId }, { $set: { isOnline: true } });
          io.to(`presence:${userId}`).emit('presence:update', { userId, isOnline: true });
          console.log('[presence] user online', userId);
        }
      }
    } catch (e) {
      console.error('presence connect error:', e);
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
        console.error('[socket] owner check', e.message);
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
            const lastSeen = new Date();
            await User.updateOne({ _id: userId }, { $set: { isOnline: false, lastSeen } });
            io.to(`presence:${userId}`).emit('presence:update', { userId, isOnline: false, lastSeen });
            console.log('[presence] user offline', userId, 'lastSeen=', lastSeen.toISOString());
          } else {
            userConnections.set(userId, cur);
          }
        }
      } catch (e) {
        console.error('presence disconnect error:', e);
      }

    });

    // Звонки. Каждое действие проверяет, кто его совершает: раньше принять,
    // отклонить или завершить чужой звонок мог любой сокет, знающий callId.

    socket.on('call:accept', async ({ callId } = {}) => {
      const call = pendingCalls.get(callId);
      if (!call || call.calleeId !== socket.data.userId) return;
      pendingCalls.delete(callId);

      // В активные — до запроса к Daily, чтобы отмена или обрыв во время
      // создания комнаты нашли звонок и завершили его.
      const roomName = `call_${callId}`;
      const active = { ...call, roomName, startedAt: Date.now() };
      activeCalls.set(callId, active);

      // Остальные вкладки того, кому звонят, перестают звонить: разговор
      // идёт в той, где приняли. Иначе в комнату на двоих ломились бы все.
      socket.to(`user:${call.calleeId}`).emit('call:canceled', { callId });

      try {
        if (!daily.configured()) throw new Error('DAILY_API_KEY или DAILY_DOMAIN не заданы');
        await daily.createRoom(roomName, { max_participants: 2 });
        if (!activeCalls.has(callId)) {
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
        console.error('[call] room create', e.message);
        finishCall(callId, 'call:failed');
      }
    });

    socket.on('call:decline', ({ callId } = {}) => {
      const call = pendingCalls.get(callId);
      if (!call || call.calleeId !== socket.data.userId) return;
      pendingCalls.delete(callId);
      io.to(`user:${call.callerId}`).emit('call:declined', { callId });
      socket.to(`user:${call.calleeId}`).emit('call:canceled', { callId });
    });

    socket.on('call:cancel', ({ callId } = {}) => {
      const call = pendingCalls.get(callId);
      if (!call || call.callerId !== socket.data.userId) return;
      pendingCalls.delete(callId);
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
      if (!isParty(call, userId)) return ack({ error: 'not_found' });
      try {
        const token = await daily.meetingToken({ room: call.roomName, userId, canSend: true });
        ack({ url: daily.roomUrl(call.roomName), token });
      } catch (e) {
        console.error('[call] token', e.message);
        ack({ error: 'token_failed' });
      }
    });
  });

  return { userConnections, userRooms, pendingCalls, activeCalls };
}

module.exports = { registerSockets };
