// Вкладка «Водяной знак» (30.09.2026): где у эфиров знак — поверх плеера
// или в кадре (utils/streamWatermark.js). Здесь же — какие эфиры идут
// сейчас и как, чтобы видеть цену выбора в ядрах.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const { requireAdmin } = require('./shared');
const streamWatermark = require('../../utils/streamWatermark');
const hls = require('../../utils/hls');
const { audit } = require('../../utils/audit');

router.get('/watermark', requireAdmin, (req, res) => {
  res.json({ mode: streamWatermark.mode(), updatedAt: streamWatermark.updatedAt(), usage: hls.usage() });
});

router.put('/watermark', requireAdmin, express.json({ limit: '1kb' }), async (req, res) => {
  const was = streamWatermark.mode();
  const now = await streamWatermark.save(req.body && req.body.mode, req.session.userId);
  if (!now) return res.status(400).json({ message: 'Нет такого режима' });
  if (now !== was) audit(req, 'admin.watermark', { meta: { was, now } });
  res.json({ mode: now });
});

module.exports = router;
