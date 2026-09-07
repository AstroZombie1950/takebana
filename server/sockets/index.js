// Socket.IO: присутствие, комнаты эфиров, звонки.
//
// Состояние держится в памяти процесса, поэтому pm2 запускает приложение
// в одном экземпляре (ops/ecosystem.config.js). Второй процесс не увидит ни
// счётчика зрителей, ни звонков — для этого нужен Redis-адаптер, он в списке
// работ за рамками текущего объёма.

const User = require('../models/User');

// Список подписок приходит от клиента, поэтому и формат, и длина проверяются.
const OBJECT_ID = /^[a-f\d]{24}$/i;
const PRESENCE_SUBSCRIBE_LIMIT = 200;

// Возвращает общие хранилища, чтобы app.js положил их в app.set(...):
// маршрут /api/calls/create достаёт их оттуда.
function registerSockets(io) {
  const userConnections = new Map(); // userId -> count
  const userRooms = new Map(); // userId -> Set(socketIds)
  const pendingCalls = new Map(); // callId -> {callerId, calleeId, type, createdAt}
  const activeCalls = new Map(); // callId -> {callerId, calleeId, roomName, roomUrl, startedAt}

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
    
    // Регистрируем обработчик сразу после подключения
    // Простая логика: join в комнату стрима
    socket.on('join-stream-room', (streamKey, callback) => {
      if (!streamKey || streamKey === 'undefined' || streamKey === 'null' || streamKey === '') {
        console.warn('[socket] join-stream-room с негодным streamKey:', streamKey);
        if (callback) callback({ error: 'Invalid streamKey' });
        return;
      }

      currentStreamKey = streamKey;
      const roomName = `stream:${streamKey}`;

      // Присоединяемся к комнате
      socket.join(roomName);

      // Небольшая задержка чтобы socket точно присоединился
      setTimeout(() => {
        // Получаем количество участников в комнате
        const room = io.sockets.adapter.rooms.get(roomName);
        const count = room ? room.size : 0;

        // Отправляем обновленный счет всем в комнате (включая стримера)
        io.to(roomName).emit('viewers-count-updated', { streamKey, count });

        if (callback) {
          callback({ success: true, count });
        }
      }, 100);
    });

    socket.on('disconnect', async () => {
      // Если был в комнате стрима, обновляем счет
      if (currentStreamKey) {
        const roomName = `stream:${currentStreamKey}`;
        
        // Небольшая задержка чтобы socket точно покинул комнату
        setTimeout(() => {
          const room = io.sockets.adapter.rooms.get(roomName);
          // Socket уже покинул комнату, поэтому просто берем размер
          const count = room ? room.size : 0;
          
          // Отправляем обновленный счет всем в комнате
          io.to(roomName).emit('viewers-count-updated', { streamKey: currentStreamKey, count });
        }, 50);
      }

      // Presence disconnect + end call if active
      try {
        const userId = socket.data.userId;
        if (userId) {
          // завершение активных звонков, где этот user участник
          try {
            for (const [id, c] of pendingCalls.entries()) {
              if (c.callerId === userId || c.calleeId === userId) {
                io.to(`user:${c.callerId}`).emit('call:ended', { callId: id });
                io.to(`user:${c.calleeId}`).emit('call:ended', { callId: id });
                pendingCalls.delete(id);
              }
            }
            for (const [id, c] of activeCalls.entries()) {
              if (c.callerId === userId || c.calleeId === userId) {
                io.to(`user:${c.callerId}`).emit('call:ended', { callId: id });
                io.to(`user:${c.calleeId}`).emit('call:ended', { callId: id });
                activeCalls.delete(id);
              }
            }
          } catch(e) { console.error('[call] cleanup on disconnect', e); }
          const set = userRooms.get(userId) || new Set();
          if (set.has(socket.id)) set.delete(socket.id);
          if (set.size === 0) userRooms.delete(userId); else userRooms.set(userId, set);
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

    // Calls: accept/decline/cancel/end
    socket.on('call:accept', ({ callId }) => {
      const call = pendingCalls.get(callId);
      if (!call) return;
      console.log('[call] accept', callId, call);
      // mark as no longer pending to prevent timeout firing
      try { pendingCalls.delete(callId); } catch(e) {}
      // Create Daily room for active call (2 hours)
      (async () => {
        let roomName = null;
        let roomUrl = null;
        try {
          if (process.env.DAILY_API_KEY) {
            const r = await fetch('https://api.daily.co/v1/rooms', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DAILY_API_KEY}` },
              body: JSON.stringify({ name: `call_${callId}`, properties: { exp: Math.floor(Date.now()/1000)+7200, start_video_off: true, start_audio_off: false, enable_chat: false } })
            });
            const j = await r.json();
            if (j && j.name) { roomName = j.name; roomUrl = j.url; }
            console.log('[daily] active room created', roomName);
          }
        } catch (e) { console.error('[daily] active room create error', e); }

        activeCalls.set(callId, { callerId: call.callerId, calleeId: call.calleeId, roomName, roomUrl, startedAt: Date.now() });
        io.to(`user:${call.callerId}`).emit('call:accepted', { callId, type: call.type, calleeId: call.calleeId, callerId: call.callerId, daily: { roomName, roomUrl } });
        io.to(`user:${call.calleeId}`).emit('call:accepted', { callId, type: call.type, calleeId: call.calleeId, callerId: call.callerId, daily: { roomName, roomUrl } });
      })();
    });

    socket.on('call:decline', ({ callId }) => {
      const call = pendingCalls.get(callId);
      if (!call) return;
      console.log('[call] decline', callId, call);
      io.to(`user:${call.callerId}`).emit('call:declined', { callId });
      pendingCalls.delete(callId);
    });

    socket.on('call:cancel', ({ callId }) => {
      const call = pendingCalls.get(callId);
      if (!call) return;
      console.log('[call] cancel', callId, call);
      io.to(`user:${call.calleeId}`).emit('call:canceled', { callId });
      pendingCalls.delete(callId);
    });

    socket.on('call:end', ({ callId }) => {
      const call = pendingCalls.get(callId);
      const active = activeCalls.get(callId);
      console.log('[call] end', callId, call || active);
      if (call) {
        io.to(`user:${call.callerId}`).emit('call:ended', { callId });
        io.to(`user:${call.calleeId}`).emit('call:ended', { callId });
        pendingCalls.delete(callId);
      }
      if (active) {
        io.to(`user:${active.callerId}`).emit('call:ended', { callId });
        io.to(`user:${active.calleeId}`).emit('call:ended', { callId });
        activeCalls.delete(callId);
      }
    });
  });

  return { userConnections, userRooms, pendingCalls, activeCalls };
}

module.exports = { registerSockets };
