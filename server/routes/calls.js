// Исходящий звонок: маршрут только создаёт заявку и будит собеседника через
// сокет. Всё остальное — приём, отказ, отмена, завершение — живёт в sockets/.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { requireAuthApi } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const User = require('../models/User');
// crypto.randomUUID() встроен в Node и даёт тот же формат, что uuid v4.
const { randomUUID: uuidv4 } = require('crypto');

// ===== Call API (create outgoing call) =====
// requireAuthApi отвечает тем же 401 { error: 'unauthorized' }, что стояло
// внутри обработчика, но до схемы: анониму незачем узнавать имена полей.
router.post('/api/calls/create', requireAuthApi, validate({
  calleeId: { type: 'objectId', required: true, label: 'Собеседник' },
  // Ровно то, что шлёт шапка (views/partials/header.ejs): аудио или видео.
  type: { type: 'string', required: true, values: ['audio', 'video'], label: 'Тип звонка' },
}), async (req, res) => {
  try {
    const callerId = String(req.session.userId);
    const { calleeId, type } = req.body;
    const callId = uuidv4();
    // Общие хранилища кладёт app.js после запуска сокетов.
    const io = req.app.get('io');
    const pendingCalls = req.app.get('pendingCalls');
    console.log('[call] create', callId, { callerId, calleeId, type, hasIO: !!io, hasStore: !!pendingCalls });
    if (pendingCalls) {
      pendingCalls.set(callId, { callerId, calleeId: String(calleeId), type, createdAt: Date.now() });
    }
    // user info
    const caller = await User.findById(callerId).lean();
    const displayName = caller?.login || (caller?.email ? caller.email.split('@')[0] : 'Пользователь');
    const avatarUrl = caller?.avatar || null;
    // notify callee via socket room
    if (io) {
      console.log('[call] notify callee room', `user:${calleeId}`);
      io.to(`user:${calleeId}`).emit('incoming_call', { callId, type, from: { userId: callerId, displayName, avatarUrl } });
      setTimeout(() => {
        if (pendingCalls && pendingCalls.has(callId)) {
          console.log('[call] timeout', callId);
          io.to(`user:${callerId}`).emit('call:timeout', { callId });
          io.to(`user:${calleeId}`).emit('call:timeout', { callId });
          pendingCalls.delete(callId);
        }
      }, 30000);
    } else {
      console.warn('[call] io not available in route');
    }
    res.json({ success: true, callId });
  } catch (e) {
    console.error('create call error', e);
    res.status(500).json({ error: 'call_create_failed' });
  }
});

module.exports = router;
