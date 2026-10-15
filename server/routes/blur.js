// Размытые обложки 18+ (utils/adultCover.js): /blur/stream/<id>.webp,
// /blur/recording/<id>.webp. Открыт всем — для того и сделан: это то, что
// видит гость. Отдаётся только у эфира или записи 18+ с обложкой, иначе 404.

const express = require('express');
const router = express.Router();
const adultCover = require('../utils/adultCover');

router.get('/blur/:kind(stream|recording)/:id.webp', async (req, res) => {
  const file = await adultCover.file(req.params.kind, req.params.id).catch(() => null);
  if (!file) return res.status(404).end();
  // Адрес меняется вместе с обложкой (?v=), поэтому кэш — на год.
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('image/webp').sendFile(file);
});

module.exports = router;
