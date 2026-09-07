// Идёт ли эфир по этому ключу. Спрашивает страница вещателя, чтобы понять,
// подключился ли OBS: views/streamPage.ejs.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { activeStreams } = require('../mediaServer');

// Заголовки CORS были глобальным app.use в самом низу цепочки: до него доходил
// только этот маршрут и запросы, не совпавшие ни с чем. Поэтому они переехали
// на сам маршрут — поведение то же, но видно, кому это нужно.
router.use('/api/check-stream', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// API эндпоинт для проверки статуса стрима который через обс
router.get('/api/check-stream/:streamKey', (req, res) => {
  try {
      const { streamKey } = req.params;
      
      // Проверяем есть ли активный стрим с таким ключом
      const isStreamActive = activeStreams.has(streamKey);
      
      res.json({
          isLive: isStreamActive,
          streamKey: streamKey,
          timestamp: new Date()
      });

  } catch (error) {
      console.error('Error checking stream status:', error);
      res.status(500).json({
          error: 'Failed to check stream status',
          message: error.message
      });
  }
});

module.exports = router;
