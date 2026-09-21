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
const { saveImage, BadImageError } = require('../../utils/image');
const daily = require('../../utils/daily');
const webLive = require('../../utils/webLive');
const hls = require('../../utils/hls');
const recording = require('../../utils/recording');
const streamLog = require('../../utils/streamLog');
const { audit } = require('../../utils/audit');
// crypto.randomUUID() встроен в Node и даёт тот же формат, что uuid v4.
const { randomUUID: uuidv4 } = require('crypto');
const errorLog = require('../../utils/errorLog');
const liveSignal = require('../../utils/liveSignal');
const liveNotify = require('../../utils/liveNotify');

router.get('/stream-status/:streamId', async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.streamId)) return res.status(404).json({ message: 'Стрим не найден' });
  const stream = await Stream.findById(req.params.streamId);

  if (!stream) {
    return res.status(404).json({ message: 'Стрим не найден' });
  }

  res.status(200).json({ isActive: stream.isActive });
});


// Маршрут для получения активности стримера
router.post('/stream/active/:streamId', requireAuth, requireOwner(Stream, { param: 'streamId', field: 'userId' }), async (req, res) => {
  const { streamId } = req.params;

  // Обновляем время последней активности стримера
  await Stream.findByIdAndUpdate(streamId, { updatedAt: Date.now() });
  res.sendStatus(200); // Возвращаем успех
});

// Ведущий ушёл в другое приложение (?on=1) или вернулся (?on=0). Уход
// пульт шлёт sendBeacon — страницу в фоне телефон вот-вот заморозит, и
// обычный запрос или сокет могут не успеть. Только у идущего эфира.
router.post('/stream/away/:streamId', requireAuth, requireOwner(Stream, { param: 'streamId', field: 'userId' }), async (req, res) => {
  const away = req.query.on === '1';
  const stream = await Stream.findOneAndUpdate(
    { _id: req.params.streamId, isActive: true, hostAway: { $ne: away } },
    { hostAway: away, updatedAt: Date.now() },
    { new: true }
  );
  if (stream) {
    const io = req.app.get('io');
    if (io) {
      io.to(`stream:${stream.streamKey}`).emit('stream:update', { streamKey: stream.streamKey, away });
      // Пауза — это уход из эфира для всех, кто смотрит списки.
      liveSignal.changed(io, stream.userId, !away);
    }
  }
  res.sendStatus(204);
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
  // Обложка (21.09): keep — оставить прежнюю (черновика или прошлого эфира),
  // none — убрать. Новую картинку студия шлёт следом в /upload-thumbnail.
  cover: { type: 'string', default: 'keep', values: ['keep', 'none'], label: 'Обложка' },
}), async (req, res) => {
  const userId = req.session.userId;
  const { title, category, subcategory, city, description, isAdult, source, cover } = req.body;

  if (SUB_CATEGORY[subcategory] !== category) {
    return res.status(400).json({ message: 'Подкатегория не относится к выбранной категории' });
  }

  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });

  const thumbnail = cover === 'none' ? '' : (user.streamDefaults && user.streamDefaults.thumbnail) || '';
  const fields = { title, category, subcategory, city: city || '', description: description || '', isAdult };
  user.streamDefaults = { ...fields, source, thumbnail };
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
      await daily.deleteRoom(stream.dailyRoomName).catch((err) => errorLog.external(err, 'daily.deleteRoom', { draft: String(stream._id) }));
      stream.dailyRoomName = null;
      stream.dailyRoom = undefined;
    }
    Object.assign(stream, fields, SOURCES[source], { thumbnail: thumbnail || stream.thumbnail || null, streamKey: user.streamKey, updatedAt: Date.now() });
    if (cover === 'none') stream.thumbnail = null;
    await stream.save();
  } else {
    // Куски записи прошлого эфира с этим ключом, если он оборвался без завершения.
    await recording.discard(user.streamKey);
    stream = await Stream.create({ userId, streamKey: user.streamKey, ...fields, ...SOURCES[source], thumbnail: thumbnail || null, isActive: false });
  }

  audit(req, 'stream.setup', { targetType: 'stream', target: stream, meta: { source, category, subcategory, city: city || '', isAdult: !!isAdult } });
  res.json({ streamId: String(stream._id), streamKey: stream.streamKey });
});


// Роут для активации стрима (isActive: true)
router.post('/set-active', requireAuth, requireNotBanned, validate({
  streamKey: { type: 'key', required: true, label: 'Ключ трансляции' },
  portrait: { type: 'bool', label: 'Вертикальная камера' },
}), async (req, res) => {
  const { streamKey } = req.body;

  if (!streamKey) {
    return res.status(400).json({ message: 'streamKey обязателен' });
  }

  // userId в фильтре обязателен: streamKey знают и зрители (по нему идёт
  // подписка на комнату сокета), поэтому без него любой вошедший мог
  // включать и гасить чужой эфир. Чужой стрим просто не найдётся — 404.
  const current = await Stream.findOne({ streamKey, userId: req.session.userId })
    .select('streamKey streamType dailyRoomName portrait').lean();
  if (!current) {
    return res.status(404).json({ message: 'Стрим не найден' });
  }

  // Веб-эфир зрители смотрят в HLS: до отметки «в эфире» комната должна
  // пойти на наш приём (utils/webLive.js). Не пошла — эфира для зрителей
  // нет, и ведущему об этом говорим сразу, а не молчаливым чёрным экраном.
  // Ориентация кадра — с первого выхода, дальше та же (models/Stream.js).
  const portrait = current.portrait ?? !!req.body.portrait;
  if (current.streamType === 'daily-stream') {
    if (!current.dailyRoomName) {
      return res.status(409).json({ message: 'Комната эфира не создана' });
    }
    try {
      await webLive.start({ ...current, portrait }, req.hostname);
    } catch (err) {
      errorLog.external(err, 'webLive.start', { stream: String(current._id) });
      return res.status(502).json({ message: 'Сервис видео не запустил трансляцию, попробуйте ещё раз' });
    }
  }

  // В эфире с этой секунды; первый выход запоминается навсегда (firstLiveAt).
  const now = new Date();
  const stream = await Stream.findOneAndUpdate(
    { streamKey, userId: req.session.userId },
    [{ $set: { isActive: true, hostAway: false, startedAt: now, updatedAt: now, firstLiveAt: { $ifNull: ['$firstLiveAt', now] }, portrait: { $ifNull: ['$portrait', portrait] } } }],
    { new: true }
  );

  if (!stream) {
    return res.status(404).json({ message: 'Стрим не найден' });
  }

  // Отрезок эфира в журнале: сам Stream после завершения удаляется, и без
  // этой записи «сколько человек отвещал» посчитать было бы не из чего.
  await streamLog.open(stream);
  audit(req, 'stream.live', { targetType: 'stream', target: stream, meta: { source: stream.streamProvider === 'obs' ? 'obs' : 'web' } });

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
      // Витрина, /authors и левая панель у подписчиков — тоже сейчас, а не
      // после перезагрузки (utils/liveSignal.js).
      liveSignal.changed(io, stream.userId, true);
    }
    // Подписчикам — строка в колокольчик и пуш. Вне проверки на io: эфир
    // начался и без сокета, а колокольчик человек увидит при следующем
    // заходе (utils/liveNotify.js).
    if (stream) liveNotify.quiet(io, stream);
  } catch (_) {}

  res.status(200).json({
    message: 'Стрим активирован',
    streamId: stream._id,
    isActive: stream.isActive,
  });
});

// // Роут для деактивации стрима (isActive: false)
router.post('/set-inactive', requireAuth, validate({
  streamKey: { type: 'key', required: true, label: 'Ключ трансляции' },
  portrait: { type: 'bool', label: 'Вертикальная камера' },
}), async (req, res) => {
  const { streamKey } = req.body;

  if (!streamKey) {
    return res.status(400).json({ message: 'streamKey обязателен' });
  }

  // Находим стрим по streamKey и обновляем isActive на false, сбрасываем время начала.
  // userId в фильтре — чтобы гасить можно было только свой эфир (см. /set-active).
  const stream = await Stream.findOneAndUpdate(
    { streamKey, userId: req.session.userId },
    { 
      isActive: false,
      hostAway: false,
      startedAt: null // Сбрасываем время начала при деактивации
    },
    { new: true } // Возвращаем обновлённый документ
  );

  if (!stream) {
    return res.status(404).json({ message: 'Стрим не найден' });
  }

  // Пауза закрывает отрезок: следующий выход в эфир откроет новый.
  // Иначе час эфира с получасовым перерывом считался бы полутора часами.
  await streamLog.close(stream.streamKey, { endedBy: 'owner', streamId: stream._id });
  audit(req, 'stream.pause', { targetType: 'stream', target: stream });

  if (stream.streamType === 'daily-stream') {
    await webLive.stop(stream).catch((err) => errorLog.external(err, 'webLive.stop', { stream: String(stream._id) }));
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
});

// Обложка эфира — из студии, после /start-stream (public/tk-studio.js).
// Та же картинка — обложка по умолчанию для следующих эфиров
// (User.streamDefaults.thumbnail) и обложка записи (utils/recording.js).
// requireAuth перед multer — см. комментарий у /profile/avatar.
router.post('/upload-thumbnail', requireAuth, upload.single('thumbnail'), validate({
  streamId: { type: 'objectId', required: true, label: 'Эфир' },
}), async (req, res) => {
  const userId = req.session.userId;
  const stream = await Stream.findOne({ _id: req.body.streamId, userId });
  if (!stream) return res.status(404).json({ message: 'Стрим не найден' });
  if (!req.file) return res.status(400).json({ message: 'Изображение не загружено.' });

  // Обложка ложится на диск уже подогнанной под 16:9, сжатой и со знаком
  // (utils/image.js).
  const thumbsDir = path.join(UPLOADS, 'thumbnails');
  let name;
  try {
    name = await saveImage(req.file.buffer, 'thumbnail', thumbsDir);
  } catch (e) {
    if (!(e instanceof BadImageError)) throw e;
    return res.status(400).json({ message: e.message });
  }

  // Прежнюю — с диска. Путь берём из базы, а не из запроса: раньше он
  // приходил в теле, и `../что-угодно` удаляло произвольный файл.
  const oldName = stream.thumbnail ? path.basename(stream.thumbnail) : null;
  const oldPath = isPlainFileName(oldName) ? resolveWithin(thumbsDir, oldName) : null;

  stream.thumbnail = `/uploads/thumbnails/${name}`;
  await stream.save();
  await User.updateOne({ _id: userId }, { $set: { 'streamDefaults.thumbnail': stream.thumbnail } });
  if (oldPath) fs.promises.rm(oldPath, { force: true }).catch(() => {});

  audit(req, 'stream.thumbnail', { targetType: 'stream', target: stream });
  res.json({ message: 'Заглавная картинка загружена.', thumbnailPath: stream.thumbnail });
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
    daily.deleteRoom(stream.dailyRoomName).catch((err) => errorLog.external(err, 'daily.deleteRoom', { ended: String(stream._id) }));
  }
  const media = require('../../mediaServer');
  media.dropPublisher(stream.streamKey, 'эфир завершён');
  hls.stop(stream.streamKey);
  // Кусок записи закрывается, когда ffmpeg вышел: до этого ни склеивать,
  // ни удалять нельзя. Обычно это доли секунды, в худшем случае — 5 с.
  await hls.stopped(stream.streamKey);

  const io = req.app.get('io');
  if (io) {
    io.to(`stream:${stream.streamKey}`).emit('stream:update', { streamKey: stream.streamKey, isActive: false, ended: true });
    liveSignal.changed(io, stream.userId, false);
  }

  // Закрываем отрезок до сохранения записи: привязка записи ищет последний,
  // и он к этому моменту должен быть уже закрыт.
  const session = await streamLog.close(stream.streamKey, { endedBy: 'owner', streamId: stream._id });
  audit(req, 'stream.end', {
    targetType: 'stream',
    target: stream,
    meta: { save: !!save, duration: session ? session.duration : 0, peakViewers: session ? session.peakViewers : 0 },
  });

  if (save && recording.enabled && stream.firstLiveAt && !stream.stoppedByModeration) {
    const owner = await User.findById(userId).select('banned').lean();
    if (owner && !owner.banned) {
      const rec = await recording.save(stream);
      streamLog.attachRecording(stream.streamKey, rec);
      audit(req, 'recording.save', { targetType: 'recording', target: rec });
      return res.json({ message: 'Эфир завершён, запись сохраняется', recordingId: String(rec._id) });
    }
  }

  await recording.discard(stream.streamKey);
  res.json({ message: 'Стрим успешно завершен и удален.' });
});


module.exports = router;
