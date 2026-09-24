// Звонки. Исходящий: маршрут только создаёт заявку и будит собеседника через
// сокет; приём, отказ, отмена, завершение — в sockets/. Журнал звонков —
// вкладка на странице переписки, пишет и читает его utils/callLog.js.

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { requireAuthApi, requireNotBanned } = require('../middleware/auth');
const Notification = require('../models/Notification');
const { validate } = require('../middleware/validate');
const userView = require('../utils/userView');
const User = require('../models/User');
const callLog = require('../utils/callLog');
const restriction = require('../utils/restrict');
const privacy = require('../utils/privacy');
// crypto.randomUUID() встроен в Node и даёт тот же формат, что uuid v4.
const { randomUUID: uuidv4 } = require('crypto');

// Десять звонков в минуту с человека. Каждый будит телефон собеседника
// пушем «пропущенный», и без предела это был способ травли, от которого
// спасало только «ограничить доступ».
const callLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: (req) => String(req.session.userId),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Слишком много звонков. Подождите минуту.' },
});

// ===== Call API (create outgoing call) =====
// requireAuthApi отвечает тем же 401 { error: 'unauthorized' }, что стояло
// внутри обработчика, но до схемы: анониму незачем узнавать имена полей.
// Звонок — это передача своего голоса, поэтому ограничение аккаунта
// действует и здесь, как на переписке и эфире.
router.post('/api/calls/create', requireAuthApi, requireNotBanned, callLimiter, validate({
  calleeId: { type: 'objectId', required: true, label: 'Собеседник' },
  // Ровно то, что шлёт шапка (views/partials/header.ejs): аудио или видео.
  type: { type: 'string', required: true, values: ['audio', 'video'], label: 'Тип звонка' },
  // Браузер звонящего помнит, что Daily у него не соединялся (tk-app.js).
  own: { type: 'bool', label: 'Свой путь' },
}), async (req, res) => {
  const callerId = String(req.session.userId);
  const { calleeId, type, own } = req.body;
  if (calleeId === callerId) return res.status(400).json({ error: 'self_call' });
  // Ограничение доступа закрывает и звонки — в обе стороны (utils/restrict.js).
  const barred = await restriction.between(callerId, calleeId);
  if (barred) return res.status(403).json({ success: false, restricted: barred, message: restriction.BLOCKED[barred] });
  // Кто может звонить — решает вызываемый (utils/privacy.js).
  const rule = await privacy.decide('calls', calleeId, callerId);
  if (!rule.ok) return res.status(403).json({ success: false, privacy: rule.rule, message: rule.message });
  const [caller, callee] = await Promise.all([
    User.findById(callerId).select('nickname login email avatar').lean(),
    User.exists({ _id: calleeId }),
  ]);
  if (!callee) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
  const callId = uuidv4();
  // Общие хранилища кладёт app.js после запуска сокетов.
  const io = req.app.get('io');
  const pendingCalls = req.app.get('pendingCalls');
  if (pendingCalls) {
    pendingCalls.set(callId, { callerId, calleeId: String(calleeId), type, own: own === true, createdAt: Date.now() });
  }
  callLog.created(callId, { callerId, calleeId, type });
  const displayName = caller ? userView.displayName(caller) : '';
  const avatarUrl = caller?.avatar || null;
  // notify callee via socket room
  if (io) {
    io.to(`user:${calleeId}`).emit('incoming_call', { callId, type, from: { userId: callerId, displayName, avatarUrl } });
    setTimeout(() => {
      if (pendingCalls && pendingCalls.has(callId)) {
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
});

// Журнал — вкладка «Звонки» на странице переписки. Старый адрес страницы
// ведёт туда же: на него могли остаться закладки.
router.get('/calls', (req, res) => res.redirect('/chatsPage?tab=calls'));

// Список для вкладки. Открыли — пропущенные увидены (utils/callLog.js).
// unread — осталось ли непрочитанное у колокольчика: уведомления о
// пропущенных только что погасли.
router.get('/api/calls', requireAuthApi, async (req, res) => {
  const me = String(req.session.userId);
  const calls = await callLog.journal(me);
  // Как у колокольчика (/api/badge): уведомления о сообщениях не в счёт.
  const unread = await Notification.countDocuments({ recipient: me, isRead: false, type: { $ne: 'message' } });
  res.json({ calls, unread });
});

// Убрать звонки у себя: крестик в журнале, выделение в ленте переписки.
// У собеседника они остаются — запись общая (models/Call.js). Остальным
// вкладкам этого же человека — call:deleted, чтобы строки пропали и там.
// В ответе — сколько пропущенных осталось: счётчик на иконке сообщений.
router.post('/api/calls/delete', requireAuthApi, validate({
  ids: { type: 'array', required: true, max: 100, of: { type: 'string', max: 64, pattern: /^[\w-]+$/ }, label: 'Звонки' },
}), async (req, res) => {
  const me = String(req.session.userId);
  const { ids } = req.body;
  const deleted = await callLog.remove(me, ids);
  const io = req.app.get('io');
  if (io) io.to(`user:${me}`).emit('call:deleted', { ids });
  res.json({ success: true, deleted, missed: await callLog.missedCount(me) });
});

router.post('/api/calls/clear', requireAuthApi, async (req, res) => {
  const me = String(req.session.userId);
  const ids = await callLog.removeAll(me);
  const io = req.app.get('io');
  if (io && ids.length) io.to(`user:${me}`).emit('call:deleted', { ids });
  res.json({ success: true, ids, missed: await callLog.missedCount(me) });
});

module.exports = router;
