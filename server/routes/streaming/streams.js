// Управление эфиром: запуск, остановка, переключение на OBS и обратно,
// обложка, пауза, завершение.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const fs = require('fs');
const path = require('path');
const Stream = require('../../models/Stream');
const User = require('../../models/User');
const { requireAuth, requireOwner, requireNotBanned } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { resolveWithin, isPlainFileName } = require('../../utils/safePath');
const { upload } = require('./uploads');
// crypto.randomUUID() встроен в Node и даёт тот же формат, что uuid v4.
const { randomUUID: uuidv4 } = require('crypto');

router.get('/stream-status/:streamId', async (req, res) => {
  try {
    const stream = await Stream.findById(req.params.streamId);

    if (!stream) {
      return res.status(404).json({ message: 'Стрим не найден' });
    }

    res.status(200).json({ isActive: stream.isActive });
  } catch (error) {
    console.error('Ошибка при проверке статуса стрима:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});


// Маршрут для получения активности стримера
router.post('/stream/active/:streamId', requireAuth, requireOwner(Stream, { param: 'streamId', field: 'userId' }), async (req, res) => {
  const { streamId } = req.params;

  try {
      // Обновляем время последней активности стримера
      await Stream.findByIdAndUpdate(streamId, { updatedAt: Date.now() });
      res.sendStatus(200); // Возвращаем успех
  } catch (error) {
      console.error('Ошибка при обновлении активности стримера:', error);
      res.sendStatus(500);
  }
});


// ===== Auto cleanup abandoned streams =====
// Why: old streams (especially isActive:false) never got removed and accumulated in DB.
// Policy:
// - Active streams: if no activity ping updates `updatedAt` for N minutes -> delete
// - Inactive streams: if `updatedAt` older than M days -> delete

router.post('/start-stream', requireNotBanned, validate({
  title: { type: 'string', required: true, min: 1, max: 200, label: 'Название' },
  category: { type: 'string', required: true, max: 100, label: 'Категория' },
  subcategory: { type: 'string', required: true, max: 100, label: 'Подкатегория' },
  description: { type: 'string', max: 5000, label: 'Описание' },
  // Метку 18+ ставит сам вещатель при создании эфира. Снять её может только
  // модерация — иначе смысл гейта теряется на первом же нажатии.
  isAdult: { type: 'bool', required: false, default: false, label: 'Контент 18+' },
}), async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: 'Пользователь не авторизован' });
  }

  const { title, category, subcategory, description, isAdult } = req.body;

  try {
    // Проверка на наличие активного стрима - улучшенная логика
    const existingStream = await Stream.findOne({ 
      userId: userId, 
      $or: [
        { isActive: true },
        { dailyRoom: { $exists: true, $ne: null } } // Проверяем также наличие Daily.co комнаты
      ]
    });
    
    if (existingStream) {
      // Если есть активный стрим или комната Daily.co, но стрим неактивен
      if (existingStream.isActive) {
        return res.status(400).json({ message: 'У вас уже есть активный стрим.' });
      } else if (existingStream.dailyRoom && existingStream.dailyRoom.name) {
        // Очищаем зависшую Daily.co комнату
        console.log('🧹 Очищаем зависшую Daily.co комнату для пользователя:', userId);
        await Stream.findByIdAndDelete(existingStream._id);
      }
    }

    // Получение пользователя из базы
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'Пользователь не найден' });
    }

    // Проверка на наличие streamKey
    if (!user.streamKey || user.streamKey === '') {
      // Генерация нового streamKey
      user.streamKey = uuidv4();
      await user.save(); // Сохранение ключа в базе
    }


  // Создание новой трансляции и запись streamKey
  const newStream = new Stream({
    userId,
    streamKey: user.streamKey, // Сохранение streamKey в стриме
    title,
    category,
    subcategory,
    description,
    isAdult,
    isActive: false
  });

  await newStream.save();

    // Отправка streamKey и данных трансляции клиенту
    res.status(200).json({
      message: 'Трансляция запущена',
      streamId: newStream._id.toString(),
      streamKey: user.streamKey
    });
  } catch (error) {
    console.error('Ошибка при запуске трансляции:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});


// Роут для активации стрима (isActive: true)
router.post('/set-active', requireAuth, requireNotBanned, validate({
  streamKey: { type: 'key', required: true, label: 'Ключ трансляции' },
}), async (req, res) => {
  const { streamKey } = req.body;

  if (!streamKey) {
    return res.status(400).json({ message: 'streamKey обязателен' });
  }

  try {
    // Находим стрим по streamKey и обновляем isActive на true, устанавливаем время начала.
    // userId в фильтре обязателен: streamKey знают и зрители (по нему идёт
    // подписка на комнату сокета), поэтому без него любой вошедший мог
    // включать и гасить чужой эфир. Чужой стрим просто не найдётся — 404.
    const stream = await Stream.findOneAndUpdate(
      { streamKey, userId: req.session.userId },
      { 
        isActive: true,
        startedAt: new Date() // Устанавливаем время начала стрима
      },
      { new: true } // Возвращаем обновлённый документ
    );

    if (!stream) {
      return res.status(404).json({ message: 'Стрим не найден' });
    }

    // notify viewers (e.g. WEB stream started -> reconnect)
    try {
      const io = req.app && req.app.get ? req.app.get('io') : null;
      if (io && stream && stream.streamKey) {
        io.to(`stream:${stream.streamKey}`).emit('stream:update', {
          streamKey: stream.streamKey,
          streamType: stream.streamType,
          streamProvider: stream.streamProvider,
          isActive: true,
          startedAt: stream.startedAt
        });
      }
    } catch (_) {}

    res.status(200).json({
      message: 'Стрим активирован',
      streamId: stream._id,
      isActive: stream.isActive,
    });
  } catch (err) {
    console.error('Ошибка при активации стрима:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// // Роут для деактивации стрима (isActive: false)
router.post('/set-inactive', requireAuth, validate({
  streamKey: { type: 'key', required: true, label: 'Ключ трансляции' },
}), async (req, res) => {
  const { streamKey } = req.body;

  if (!streamKey) {
    return res.status(400).json({ message: 'streamKey обязателен' });
  }

  try {
    // Находим стрим по streamKey и обновляем isActive на false, сбрасываем время начала.
    // userId в фильтре — чтобы гасить можно было только свой эфир (см. /set-active).
    const stream = await Stream.findOneAndUpdate(
      { streamKey, userId: req.session.userId },
      { 
        isActive: false,
        startedAt: null // Сбрасываем время начала при деактивации
      },
      { new: true } // Возвращаем обновлённый документ
    );

    if (!stream) {
      return res.status(404).json({ message: 'Стрим не найден' });
    }

    // notify viewers
    try {
      const io = req.app && req.app.get ? req.app.get('io') : null;
      if (io && stream && stream.streamKey) {
        io.to(`stream:${stream.streamKey}`).emit('stream:update', {
          streamKey: stream.streamKey,
          streamType: stream.streamType,
          streamProvider: stream.streamProvider,
          isActive: false
        });
      }
    } catch (_) {}

    res.status(200).json({
      message: 'Стрим деактивирован',
      streamId: stream._id,
      isActive: stream.isActive,
    });
  } catch (err) {
    console.error('Ошибка при деактивации стрима:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});


// Новые эндпоинты специально для OBS
router.post('/obs-stream-start', requireAuth, requireNotBanned, validate({
  streamKey: { type: 'key', required: true, label: 'Ключ трансляции' },
}), async (req, res) => {
  try {
      const { streamKey } = req.body;
      
      // userId в фильтре — иначе чужой streamKey переключал чужой эфир (см. /set-active)
      const updatedStream = await Stream.findOneAndUpdate(
          { streamKey: streamKey, userId: req.session.userId },
          { 
              streamType: 'obs-stream',
              streamProvider: 'obs',
              updatedAt: Date.now() 
          },
          { new: true }
      );

      if (!updatedStream) {
          return res.status(404).json({ error: 'Stream not found' });
      }

      // notify viewers to swap player if needed
      try {
        const io = req.app && req.app.get ? req.app.get('io') : null;
        if (io && updatedStream && updatedStream.streamKey) {
          io.to(`stream:${updatedStream.streamKey}`).emit('stream:update', {
            streamKey: updatedStream.streamKey,
            streamType: updatedStream.streamType,
            streamProvider: updatedStream.streamProvider,
            isActive: !!updatedStream.isActive
          });
        }
      } catch (_) {}

      res.json({ 
          success: true, 
          message: 'OBS stream started',
          stream: updatedStream 
      });
  } catch (error) {
      console.error('Error updating OBS stream status:', error);
      res.status(500).json({ error: 'Server error' });
  }
});

router.post('/obs-stream-end', requireAuth, validate({
  streamKey: { type: 'key', required: true, label: 'Ключ трансляции' },
}), async (req, res) => {
  try {
      const { streamKey } = req.body;
      
      // userId в фильтре — иначе чужой streamKey переключал чужой эфир (см. /set-active)
      const updatedStream = await Stream.findOneAndUpdate(
          { streamKey: streamKey, userId: req.session.userId },
          { 
              streamType: 'daily-stream',
              streamProvider: 'web-stream',
              updatedAt: Date.now() 
          },
          { new: true }
      );

      if (!updatedStream) {
          return res.status(404).json({ error: 'Stream not found' });
      }

      // notify viewers to swap player if needed
      try {
        const io = req.app && req.app.get ? req.app.get('io') : null;
        if (io && updatedStream && updatedStream.streamKey) {
          io.to(`stream:${updatedStream.streamKey}`).emit('stream:update', {
            streamKey: updatedStream.streamKey,
            streamType: updatedStream.streamType,
            streamProvider: updatedStream.streamProvider,
            isActive: !!updatedStream.isActive
          });
        }
      } catch (_) {}

      res.json({ 
          success: true, 
          message: 'OBS stream ended',
          stream: updatedStream 
      });
  } catch (error) {
      console.error('Error updating OBS stream status:', error);
      res.status(500).json({ error: 'Server error' });
  }
});


// Маршрут для загрузки заглавной картинки (thumbnail).
// requireAuth перед multer — см. комментарий у /profile/avatar.
router.post('/upload-thumbnail', requireAuth, upload.single('thumbnail'), validate({
  streamId: { type: 'objectId', required: true, label: 'Эфир' },
  oldThumbnailPath: { type: 'string', max: 300, label: 'Прежняя обложка' },
}), async (req, res) => {
  const { streamId, oldThumbnailPath } = req.body;
  const userId = req.session.userId;

  if (!streamId || !userId) {
      return res.status(400).json({ message: 'Недостаточно данных.' });
  }

  try {
      // Найдем стрим и проверим, что он принадлежит текущему пользователю
      const stream = await Stream.findOne({ _id: streamId, userId: userId });

      if (!stream) {
          return res.status(404).json({ message: 'Стрим не найден.' });
      }

      if (req.file) {
          // Удаляем старое изображение, если оно существует
          // oldThumbnailPath приходит из тела запроса. Без проверки границ
          // сюда подставлялось `../что-угодно` и удалялся произвольный файл.
          // Старую обложку ищем только внутри папки обложек и только по имени.
          const thumbsDir = path.join(__dirname, '..', 'public', 'uploads', 'thumbnails');
          const oldName = oldThumbnailPath ? path.basename(String(oldThumbnailPath)) : null;
          const fullOldPath = isPlainFileName(oldName) ? resolveWithin(thumbsDir, oldName) : null;

          if (fullOldPath) {
              fs.unlink(fullOldPath, (err) => {
                  if (err) {
                      console.error('Ошибка при удалении старого изображения:', err);
                  } else {
                      console.log('Старое изображение успешно удалено.');
                  }
              });
          }

          // Обновляем поле thumbnail в документе Stream
          stream.thumbnail = `/uploads/thumbnails/${req.file.filename}`;
          await stream.save();

          res.status(200).json({ message: 'Заглавная картинка загружена.', thumbnailPath: stream.thumbnail });
      } else {
          res.status(400).json({ message: 'Изображение не загружено.' });
      }
  } catch (error) {
      console.error('Ошибка при загрузке заглавной картинки:', error);
      res.status(500).json({ message: 'Ошибка сервера.' });
  }
});


// Маршрут для постановки стрима на паузу
router.post('/api/pause-stream', validate({
  streamKey: { type: 'key', required: true, label: 'Ключ трансляции' },
}), async (req, res) => {
  const { streamKey } = req.body;
  const userId = req.session.userId;

  console.log(`Запрос на паузу стрима: streamKey=${streamKey}, userId=${userId}`);

  if (!streamKey || !userId) {
      console.log('Недостаточно данных для постановки стрима на паузу');
      return res.status(400).json({ message: 'Недостаточно данных.' });
  }

  try {
      const stream = await Stream.findOne({ streamKey: streamKey, userId: userId, isActive: true });

      if (!stream) {
          console.log('Активный стрим не найден для паузы');
          return res.status(404).json({ message: 'Активный стрим не найден.' });
      }

      stream.isActive = false;
      stream.startedAt = null; // Сбрасываем время начала при паузе
      await stream.save();

      console.log('Стрим поставлен на паузу:', stream._id);

      res.json({ message: 'Стрим успешно поставлен на паузу.', stream: stream });
  } catch (error) {
      console.error('Ошибка при постановке стрима на паузу:', error);
      res.status(500).json({ message: 'Ошибка сервера.' });
  }
});

// // Маршрут для возобновления стрима

//       // Проверяем, есть ли уже другой активный стрим

// Маршрут для завершения стрима
router.post('/terminate-stream', validate({
  streamId: { type: 'objectId', required: true, label: 'Эфир' },
}), async (req, res) => {
  const { streamId } = req.body;
  const userId = req.session.userId;

  console.log(`Запрос на завершение стрима: streamId=${streamId}, userId=${userId}`);

  if (!streamId || !userId) {
      console.log('Недостаточно данных для завершения стрима');
      return res.status(400).json({ message: 'Недостаточно данных.' });
  }

  try {
      // Завершаем стрим независимо от его текущего состояния
      const stream = await Stream.findOneAndDelete({ _id: streamId, userId: userId });

      if (!stream) {
          console.log('Стрим не найден или уже завершен');
          return res.status(404).json({ message: 'Стрим не найден или уже завершен.' });
      }

      console.log('Стрим завершён и удалён:', stream._id);

      res.json({ message: 'Стрим успешно завершен и удален.' });
  } catch (error) {
      console.error('Ошибка при завершении стрима:', error);
      res.status(500).json({ message: 'Ошибка сервера.' });
  }
});


// Эндпоинт для отправки сообщений

module.exports = router;
