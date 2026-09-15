// Управление эфиром: настройки со студии, выход в эфир и пауза, обложка,
// завершение с записью или без.

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
const { CATEGORIES, SUB_CATEGORY, CITY_NAME } = require('../../config/catalog');
const { UPLOADS, upload } = require('./uploads');
const daily = require('../../utils/daily');
const webLive = require('../../utils/webLive');
const hls = require('../../utils/hls');
const recording = require('../../utils/recording');
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


// Источник эфира: что пульт делает дальше. Веб — ведущий выходит в эфир
// кнопкой, картинка идёт через Daily; OBS — эфир начинается, когда программа
// начала слать поток на наш приём (mediaServer.js).
const SOURCES = {
  web: { streamType: 'daily-stream', streamProvider: 'web-stream' },
  obs: { streamType: 'obs-stream', streamProvider: 'obs' },
};

// Студия (/studio) отправляет настройки перед выходом в эфир. Черновик —
// эфир, который ещё ни разу не выходил, — обновляется на месте: у OBS-эфира
// его ключ уже вставлен в программу, а у веба могла не подняться камера.
// Эфир, который уже выходил, так не переписать: сначала его завершают.
router.post('/start-stream', requireAuth, requireNotBanned, validate({
  title: { type: 'string', required: true, min: 1, max: 200, label: 'Название' },
  // Коды из закрытых списков config/catalog.js. Любая другая строка давала
  // эфир, который каталог не показывает ни на одной вкладке и ни в одном фильтре.
  category: { type: 'string', required: true, values: Object.keys(CATEGORIES), label: 'Категория' },
  subcategory: { type: 'string', required: true, values: Object.keys(SUB_CATEGORY), label: 'Подкатегория' },
  city: { type: 'string', values: Object.keys(CITY_NAME), label: 'Город' },
  description: { type: 'string', max: 5000, label: 'Описание' },
  // Метку 18+ ставит сам вещатель при создании эфира. Снять её может только
  // модерация — иначе смысл гейта теряется на первом же нажатии.
  isAdult: { type: 'bool', required: false, default: false, label: 'Контент 18+' },
  source: { type: 'string', required: true, values: Object.keys(SOURCES), label: 'Источник' },
}), async (req, res) => {
  const userId = req.session.userId;
  const { title, category, subcategory, city, description, isAdult, source } = req.body;

  if (SUB_CATEGORY[subcategory] !== category) {
    return res.status(400).json({ message: 'Подкатегория не относится к выбранной категории' });
  }

  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });

  const fields = { title, category, subcategory, city: city || '', description: description || '', isAdult };
  user.streamDefaults = { ...fields, source };
  // Ключ создаёт ещё студия, когда показывает его для OBS; здесь — страховка.
  if (!user.streamKey) user.streamKey = uuidv4();
  await user.save();

  let stream = await Stream.findOne({ userId });
  if (stream && (stream.firstLiveAt || stream.isActive)) {
    return res.status(409).json({ message: 'У вас уже есть эфир: завершите его, чтобы начать новый', streamId: String(stream._id) });
  }

  if (stream) {
    // Сменили веб на OBS — комната Daily черновику больше не нужна.
    if (source === 'obs' && stream.dailyRoomName) {
      await daily.deleteRoom(stream.dailyRoomName).catch((err) => console.error('[daily] комната черновика', err.message));
      stream.dailyRoomName = null;
      stream.dailyRoom = undefined;
    }
    Object.assign(stream, fields, SOURCES[source], { streamKey: user.streamKey, updatedAt: Date.now() });
    await stream.save();
  } else {
    // Куски записи прошлого эфира с этим ключом, если он оборвался без завершения.
    await recording.discard(user.streamKey);
    stream = await Stream.create({ userId, streamKey: user.streamKey, ...fields, ...SOURCES[source], isActive: false });
  }

  res.json({ streamId: String(stream._id), streamKey: stream.streamKey });
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
    // userId в фильтре обязателен: streamKey знают и зрители (по нему идёт
    // подписка на комнату сокета), поэтому без него любой вошедший мог
    // включать и гасить чужой эфир. Чужой стрим просто не найдётся — 404.
    const current = await Stream.findOne({ streamKey, userId: req.session.userId })
      .select('streamKey streamType dailyRoomName').lean();
    if (!current) {
      return res.status(404).json({ message: 'Стрим не найден' });
    }

    // Веб-эфир зрители смотрят в HLS: до отметки «в эфире» комната должна
    // пойти на наш приём (utils/webLive.js). Не пошла — эфира для зрителей
    // нет, и ведущему об этом говорим сразу, а не молчаливым чёрным экраном.
    if (current.streamType === 'daily-stream') {
      if (!current.dailyRoomName) {
        return res.status(409).json({ message: 'Комната эфира не создана' });
      }
      try {
        await webLive.start(current, req.hostname);
      } catch (err) {
        console.error('[webLive] выход Daily не запустился:', err.message);
        return res.status(502).json({ message: 'Сервис видео не запустил трансляцию, попробуйте ещё раз' });
      }
    }

    // В эфире с этой секунды; первый выход запоминается навсегда (firstLiveAt).
    const now = new Date();
    const stream = await Stream.findOneAndUpdate(
      { streamKey, userId: req.session.userId },
      [{ $set: { isActive: true, startedAt: now, updatedAt: now, firstLiveAt: { $ifNull: ['$firstLiveAt', now] } } }],
      { new: true }
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

    if (stream.streamType === 'daily-stream') {
      await webLive.stop(stream).catch((err) => console.error('[webLive] выход Daily не остановлен:', err.message));
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

// Маршрут для загрузки заглавной картинки (thumbnail).
// requireAuth перед multer — см. комментарий у /profile/avatar.
router.post('/upload-thumbnail', requireAuth, upload.single('thumbnail'), validate({
  streamId: { type: 'objectId', required: true, label: 'Эфир' },
  oldThumbnailPath: { type: 'string', max: 300, label: 'Прежняя обложка' },
}), async (req, res) => {
  const { streamId, oldThumbnailPath } = req.body;
  const userId = req.session.userId;

  if (!streamId || !userId) {
      return res.status(400).json({ message: 'Недостаточно данных' });
  }

  try {
      // Найдем стрим и проверим, что он принадлежит текущему пользователю
      const stream = await Stream.findOne({ _id: streamId, userId: userId });

      if (!stream) {
          return res.status(404).json({ message: 'Стрим не найден' });
      }

      if (req.file) {
          // Удаляем старое изображение, если оно существует
          // oldThumbnailPath приходит из тела запроса. Без проверки границ
          // сюда подставлялось `../что-угодно` и удалялся произвольный файл.
          // Старую обложку ищем только внутри папки обложек и только по имени.
          const thumbsDir = path.join(UPLOADS, 'thumbnails');
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
      res.status(500).json({ message: 'Ошибка сервера' });
  }
});


// Завершение эфира. save — «Сохранить запись»: куски склеиваются в запись
// на странице автора (utils/recording.js); без него куски удаляются.
// Сохранить можно только эфир, который выходил в эфир и не погашен
// модерацией, и не с ограниченного аккаунта — запись видят все.
router.post('/terminate-stream', requireAuth, validate({
  streamId: { type: 'objectId', required: true, label: 'Эфир' },
  save: { type: 'bool', default: false, label: 'Сохранить запись' },
}), async (req, res) => {
  const { streamId, save } = req.body;
  const userId = req.session.userId;

  const stream = await Stream.findOneAndDelete({ _id: streamId, userId });
  if (!stream) {
    return res.status(404).json({ message: 'Стрим не найден или уже завершен.' });
  }

  // Завершить можно и из другой вкладки, пока пульт в эфире: комната Daily
  // и её RTMP-выход пережили бы запись, а HLS писался бы для эфира, которого нет.
  if (stream.dailyRoomName) {
    webLive.stop(stream).catch(() => {});
    daily.deleteRoom(stream.dailyRoomName).catch((err) => console.error('[daily] комната завершённого эфира', err.message));
  }
  const media = require('../../mediaServer');
  media.dropPublisher(stream.streamKey, 'эфир завершён');
  hls.stop(stream.streamKey);
  // Кусок записи закрывается, когда ffmpeg вышел: до этого ни склеивать,
  // ни удалять нельзя. Обычно это доли секунды, в худшем случае — 5 с.
  await hls.stopped(stream.streamKey);

  const io = req.app.get('io');
  if (io) io.to(`stream:${stream.streamKey}`).emit('stream:update', { streamKey: stream.streamKey, isActive: false, ended: true });

  if (save && recording.enabled && stream.firstLiveAt && !stream.stoppedByModeration) {
    const owner = await User.findById(userId).select('banned').lean();
    if (owner && !owner.banned) {
      const rec = await recording.save(stream);
      return res.json({ message: 'Эфир завершён, запись сохраняется', recordingId: String(rec._id) });
    }
  }

  await recording.discard(stream.streamKey);
  res.json({ message: 'Стрим успешно завершен и удален.' });
});


module.exports = router;
