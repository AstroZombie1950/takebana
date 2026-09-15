// Звонки. Исходящий: маршрут только создаёт заявку и будит собеседника через
// сокет; приём, отказ, отмена, завершение — в sockets/. Журнал звонков —
// страница /calls, пишет его utils/callLog.js.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { requireAuth, requireAuthApi, requireNotBanned } = require('../middleware/auth');
const { commonDataMiddleware } = require('./streaming/shared');
const Call = require('../models/Call');
const Notification = require('../models/Notification');
const { validate } = require('../middleware/validate');
const userView = require('../utils/userView');
const User = require('../models/User');
const callLog = require('../utils/callLog');
// crypto.randomUUID() встроен в Node и даёт тот же формат, что uuid v4.
const { randomUUID: uuidv4 } = require('crypto');

// ===== Call API (create outgoing call) =====
// requireAuthApi отвечает тем же 401 { error: 'unauthorized' }, что стояло
// внутри обработчика, но до схемы: анониму незачем узнавать имена полей.
// Звонок — это передача своего голоса, поэтому ограничение аккаунта
// действует и здесь, как на переписке и эфире.
router.post('/api/calls/create', requireAuthApi, requireNotBanned, validate({
  calleeId: { type: 'objectId', required: true, label: 'Собеседник' },
  // Ровно то, что шлёт шапка (views/partials/header.ejs): аудио или видео.
  type: { type: 'string', required: true, values: ['audio', 'video'], label: 'Тип звонка' },
}), async (req, res) => {
  try {
    const callerId = String(req.session.userId);
    const { calleeId, type } = req.body;
    if (calleeId === callerId) return res.status(400).json({ error: 'self_call' });
    const callId = uuidv4();
    // Общие хранилища кладёт app.js после запуска сокетов.
    const io = req.app.get('io');
    const pendingCalls = req.app.get('pendingCalls');
    console.log('[call] create', callId, { callerId, calleeId, type, hasIO: !!io, hasStore: !!pendingCalls });
    if (pendingCalls) {
      pendingCalls.set(callId, { callerId, calleeId: String(calleeId), type, createdAt: Date.now() });
    }
    callLog.created(callId, { callerId, calleeId, type });
    // user info
    const caller = await User.findById(callerId).lean();
    const displayName = caller ? userView.displayName(caller) : '';
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
          callLog.ended(io, callId, 'missed');
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

// Журнал: последние сто звонков в обе стороны. Открыли — пропущенные
// увидены: счётчик в левой панели и уведомления о них гаснут.
router.get('/calls', requireAuth, commonDataMiddleware, async (req, res) => {
  const me = String(req.session.userId);
  const calls = await Call.find({ $or: [{ caller: me }, { callee: me }] })
    .sort({ startedAt: -1 })
    .limit(100)
    .populate('caller callee', 'login email avatar')
    .lean();

  await Promise.all([
    Call.updateMany({ callee: me, seen: false }, { $set: { seen: true } }),
    Notification.updateMany({ recipient: me, type: 'call', isRead: false }, { $set: { isRead: true } }),
  ]);

  const rows = calls
    .filter((c) => c.caller && c.callee) // собеседник мог удалить аккаунт
    .map((c) => {
      const outgoing = String(c.caller._id) === me;
      const other = outgoing ? c.callee : c.caller;
      const displayName = userView.displayName(other);
      const seconds = c.answeredAt && c.endedAt ? Math.round((c.endedAt - c.answeredAt) / 1000) : 0;
      return {
        peer: { id: String(other._id), displayName, avatarStyle: userView.avatarStyle(other, displayName) },
        type: c.type,
        outgoing,
        status: c.status,
        missed: !outgoing && (c.status === 'missed' || c.status === 'canceled'),
        startedAt: c.startedAt,
        duration: seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '',
      };
    });

  // Пропущенные просмотрены — счётчик на этой же странице уже не нужен.
  res.locals.missedCalls = 0;
  res.render('calls', { calls: rows });
});

module.exports = router;
