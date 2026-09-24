// Служебный API панели: всё под /api/admin.
//
// Отдельной папкой, а не одним файлом: вкладок десяток, и каждая тянет свои
// модели. Порядок подключения здесь значения не имеет — пути не пересекаются.
//
// Права проверяет каждая вкладка сама (shared.js): модератору открыты люди,
// жалобы и эфиры, администратору — ещё журнал, ошибки, заведения, расходы,
// хранилище и система.

const express = require('express');
const router = express.Router();

router.use('/api/admin', require('./summary'));
router.use('/api/admin', require('./people'));
router.use('/api/admin', require('./streams'));
router.use('/api/admin', require('./venues'));
router.use('/api/admin', require('./reports'));
router.use('/api/admin', require('./journal'));
router.use('/api/admin', require('./storage'));

module.exports = router;
