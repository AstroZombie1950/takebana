// Живое состояние для вошедшего: кто в сети и что в счётчиках шапки.
// Сокет присылает и то и другое сам, событиями и приращениями; эти два
// маршрута — чтобы свериться с сервером, когда сокета какое-то время не было
// (public/tk-app.js, пробуждение вкладки и переподключение).

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { requireAuthApi } = require('../middleware/auth');
const User = require('../models/User');
const Message = require('../models/Message');
const Stream = require('../models/Stream');
const Notification = require('../models/Notification');
const callLog = require('../utils/callLog');

// ===== Presence API =====
// Онлайн-статусы нужны мессенджеру, то есть вошедшему пользователю.
// Без проверки любой желающий мог опрашивать присутствие произвольных
// идентификаторов и снимать, кто когда в сети.
router.get('/api/presence', requireAuthApi, async (req, res) => {
  // Повтор ключа (?ids=a&ids=b) даёт массив, а у массива нет split — было 500.
  const ids = (typeof req.query.ids === 'string' ? req.query.ids : '')
    .split(',')
    .map(s => s.trim())
    // Список приходит из адреса: негодный идентификатор ронял весь запрос
    // CastError-ом. Отсеиваем, как это делает presence:subscribe в сокетах.
    .filter((s) => /^[a-f\d]{24}$/i.test(s))
    .slice(0, 200);
  if (!ids.length) return res.json({ users: [] });
  // isLive — идёт ли у человека эфир прямо сейчас. Отдаём вместе с присутствием,
  // потому что спрашивают их всегда вместе: вернувшаяся вкладка сверяет и точки
  // «в сети», и метки «в эфире» (public/tk-app.js, refreshCounters).
  const [users, live] = await Promise.all([
    User.find({ _id: { $in: ids } }, { _id: 1, isOnline: 1, lastSeen: 1 }).lean(),
    Stream.find({ userId: { $in: ids }, isActive: true }).distinct('userId'),
  ]);
  const liveSet = new Set(live.map(String));
  res.json({ users: users.map((u) => ({ ...u, isLive: liveSet.has(String(u._id)) })) });
});

// Счётчики шапки: непрочитанные сообщения, пропущенные звонки, точка
// на колокольчике. Ровно те же три числа, что считает commonDataMiddleware
// при отрисовке страницы (routes/streaming/shared.js), — иначе шапка после
// сверки показывала бы не то, что показала бы перезагрузка.
//
// Нужен потому, что в браузере эти числа живут приращениями от сокета: одно
// пропущенное событие — и значок врёт до следующей перезагрузки страницы.
router.get('/api/badge', requireAuthApi, async (req, res) => {
  const me = req.session.userId;
  const [unreadMessages, missedCalls, notifications] = await Promise.all([
    Message.countDocuments({ recipient: me, readAt: null, deletedFor: { $ne: me } }),
    callLog.missedCount(me),
    Notification.countDocuments({ recipient: me, isRead: false, type: { $ne: 'message' } }),
  ]);
  res.set('Cache-Control', 'no-store').json({ unreadMessages, missedCalls, notifications });
});

module.exports = router;
