// Онлайн-статусы для мессенджера.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { requireAuthApi } = require('../middleware/auth');
const User = require('../models/User');

// ===== Presence API =====
// Онлайн-статусы нужны мессенджеру, то есть вошедшему пользователю.
// Без проверки любой желающий мог опрашивать присутствие произвольных
// идентификаторов и снимать, кто когда в сети.
router.get('/api/presence', requireAuthApi, async (req, res) => {
  const ids = (req.query.ids || '')
    .split(',')
    .map(s => s.trim())
    // Список приходит из адреса: негодный идентификатор ронял весь запрос
    // CastError-ом. Отсеиваем, как это делает presence:subscribe в сокетах.
    .filter((s) => /^[a-f\d]{24}$/i.test(s))
    .slice(0, 200);
  if (!ids.length) return res.json({ users: [] });
  const users = await User.find({ _id: { $in: ids } }, { _id: 1, isOnline: 1, lastSeen: 1 }).lean();
  res.json({ users });
});

module.exports = router;
