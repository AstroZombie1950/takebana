// Бывший streamingRouter — 1870 строк и 35 маршрутов в одном файле.
//
// Порядок подключения повторяет прежний порядок объявления маршрутов: там, где
// пути пересекаются, выигрывает объявленный первым. Конкретно это важно для
// `/streaming/:category?` и `/stream/:streamId` — параметрические маршруты
// перехватили бы всё, что окажется под ними.

const express = require('express');
const router = express.Router();

router.use(require('./profile'));
router.use(require('./notifications'));
router.use(require('./catalog'));
router.use(require('./subscriptions'));
router.use(require('./messages'));
router.use(require('./streams'));
router.use(require('./streamPages'));
router.use(require('./streamChat'));
router.use(require('./legal'));

module.exports = router;
