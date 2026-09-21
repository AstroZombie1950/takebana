// Страница загрузки фото и видео в галерею: /upload (решение заказчика
// 21.09.2026). Видео — кусками с докачкой, правка (обрезка, без звука,
// обложка) и «Опубликовать». Фото уходят прежним /profile/gallery.
//
// Кусок — PUT /upload/video/:id?offset=N, тело — байты файла с этого места.
// Сервер принимает кусок, только если offset равен тому, что уже доехало:
// так повтор оборванного куска не задваивает байты, а вкладка, пропустившая
// ответ, спрашивает у сервера, откуда продолжать (409 с received). Кто и как
// качает в фоне с любой страницы — public/tk-upload.js.
//
// Черновик — тот же GalleryVideo со статусом uploading/draft
// (utils/galleryVideo.js), его файл — media/upload/<id>.part.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const fs = require('fs');
const sharp = require('sharp');
const GalleryVideo = require('../../models/GalleryVideo');
const galleryVideo = require('../../utils/galleryVideo');
const { requireAuth, requireAuthApi, requireNotBanned } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { commonDataMiddleware } = require('./shared');
const { uploadGallery } = require('./uploads');
const { audit } = require('../../utils/audit');

const OBJECT_ID = /^[a-f\d]{24}$/i;
const CHUNK = galleryVideo.CHUNK_MB * 1024 * 1024;
// Кусок пишется в файл по одному на черновик: две вкладки, качающие
// одно и то же, иначе дописали бы байты друг поверх друга.
const writing = new Set();

// Черновик для браузера: без ключей хранилища и путей на диске.
function draftView(v) {
  return {
    id: String(v._id),
    status: v.status,
    error: v.error || '',
    name: (v.upload && v.upload.name) || '',
    size: (v.upload && v.upload.size) || 0,
    received: (v.upload && v.upload.received) || 0,
    edit: {
      start: (v.edit && v.edit.start) || 0,
      end: (v.edit && v.edit.end) || 0,
      mute: !!(v.edit && v.edit.mute),
      coverAt: v.edit && typeof v.edit.coverAt === 'number' ? v.edit.coverAt : -1,
      cover: !!(v.edit && v.edit.cover),
    },
    publish: !!v.publish,
    thumb: (v.thumb && v.thumb.url) || '',
    duration: v.duration || 0,
  };
}

function mine(req, extra = {}) {
  if (!OBJECT_ID.test(req.params.id)) return null;
  return GalleryVideo.findOne({ _id: req.params.id, userId: req.session.userId, ...extra });
}

// Страница. Незаконченное — недокачанное, неопубликованное и то, что ещё
// пережимается, — показывается сразу: с него человек и продолжает.
router.get('/upload', requireAuth, commonDataMiddleware, async (req, res) => {
  const drafts = await GalleryVideo.find({ userId: req.session.userId, status: { $in: ['uploading', 'draft', 'processing'] } })
    .sort({ createdAt: -1 }).limit(galleryVideo.MAX_PER_USER).lean();
  res.render('upload', {
    drafts: drafts.map(draftView),
    videoEnabled: galleryVideo.enabled,
    maxSeconds: galleryVideo.MAX_SECONDS,
  });
});

// Начать загрузку видео: черновик и пустой файл под него.
router.post('/upload/video', requireAuthApi, requireNotBanned, validate({
  name: { type: 'string', max: 200, default: '', label: 'Имя файла' },
  size: { type: 'int', required: true, min: 1, max: galleryVideo.MAX_MB * 1024 * 1024, label: 'Размер' },
}), async (req, res) => {
  if (!galleryVideo.enabled) return res.status(503).json({ success: false, message: 'Видео сейчас не принимаются' });
  const n = await GalleryVideo.countDocuments({ userId: req.session.userId, status: { $ne: 'failed' } });
  if (n >= galleryVideo.MAX_PER_USER) {
    return res.status(400).json({ success: false, message: 'В галерее уже 30 видео — удалите что-нибудь' });
  }
  const doc = await GalleryVideo.create({
    userId: req.session.userId,
    status: 'uploading',
    upload: { name: req.body.name, size: req.body.size, received: 0 },
  });
  await fs.promises.writeFile(galleryVideo.partPath(doc._id), '');
  res.json({ success: true, chunk: CHUNK, video: draftView(doc) });
});

router.get('/upload/video/:id', requireAuthApi, async (req, res) => {
  const v = await mine(req);
  if (!v) return res.status(404).json({ success: false, message: 'Видео не найдено' });
  res.json({ success: true, video: draftView(v) });
});

// Кусок файла. Тело читаем сами, потоком в файл: express.json его не трогает
// (тип application/octet-stream), в память целиком он не ложится.
router.put('/upload/video/:id', requireAuthApi, async (req, res) => {
  const v = await mine(req, { status: 'uploading' });
  if (!v) return res.status(404).json({ success: false, message: 'Видео не найдено' });
  const id = String(v._id);
  const offset = Number(req.query.offset);
  const length = Number(req.headers['content-length']);
  const { size, received } = v.upload;
  if (offset !== received) return res.status(409).json({ success: false, received });
  if (!Number.isInteger(length) || length < 1 || length > CHUNK || offset + length > size) {
    return res.status(400).json({ success: false, message: 'Неверный кусок файла' });
  }
  if (writing.has(id)) return res.status(409).json({ success: false, received, busy: true });
  writing.add(id);

  const part = galleryVideo.partPath(id);
  let bytes = 0;
  try {
    // Хвост от оборванного куска, которого сервер не засчитал, — прочь.
    await fs.promises.truncate(part, received);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part, { flags: 'a' });
      req.on('data', (c) => { bytes += c.length; if (bytes > length) req.destroy(new Error('кусок длиннее заявленного')); });
      req.on('aborted', () => reject(new Error('aborted')));
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
  } catch (e) {
    writing.delete(id);
    if (!res.headersSent && !req.destroyed) res.status(400).json({ success: false, received });
    return;
  }
  writing.delete(id);
  if (bytes !== length) return res.status(400).json({ success: false, received, message: 'Кусок пришёл не целиком' });

  const now = received + bytes;
  const done = now === size;
  const saved = await GalleryVideo.findOneAndUpdate(
    { _id: id, status: 'uploading', 'upload.received': received },
    { $set: { 'upload.received': now, ...(done ? { status: 'draft' } : {}) } },
    { new: true },
  ).lean();
  if (!saved) return res.status(409).json({ success: false, received });
  if (done) {
    audit(req, 'profile.gallery.video', { targetType: 'user', targetId: req.session.userId, meta: { video: id, size } });
    const started = await galleryVideo.publishIfReady(id);
    if (started) return res.json({ success: true, video: draftView(started) });
  }
  res.json({ success: true, video: draftView(saved) });
});

// Правка и «Опубликовать». Пока файл едет, можно и то и другое: нажали
// «Опубликовать» раньше конца — пережатие начнётся, как только файл доедет.
router.post('/upload/video/:id/edit', requireAuthApi, validate({
  start: { type: 'number', min: 0, max: 86400, default: 0, label: 'Начало' },
  end: { type: 'number', min: 0, max: 86400, default: 0, label: 'Конец' },
  mute: { type: 'bool', default: false, label: 'Без звука' },
  coverAt: { type: 'number', min: -1, max: 86400, default: -1, label: 'Кадр обложки' },
  publish: { type: 'bool', default: false, label: 'Опубликовать' },
}), async (req, res) => {
  const { start, end, mute, coverAt, publish } = req.body;
  if (end && end - start < 1) return res.status(400).json({ success: false, message: 'Видео короче секунды' });
  const v = await GalleryVideo.findOneAndUpdate(
    { _id: OBJECT_ID.test(req.params.id) ? req.params.id : null, userId: req.session.userId, status: { $in: ['uploading', 'draft'] } },
    { $set: { 'edit.start': start, 'edit.end': end, 'edit.mute': mute, 'edit.coverAt': coverAt, publish } },
    { new: true },
  ).lean();
  if (!v) return res.status(404).json({ success: false, message: 'Видео не найдено' });
  const started = publish ? await galleryVideo.publishIfReady(v._id) : null;
  res.json({ success: true, video: draftView(started || v) });
});

// Своя картинка обложки. Лежит у нас до пережатия, знак ставится там же
// (utils/galleryVideo.js, ownCover).
router.post('/upload/video/:id/cover', requireAuthApi, uploadGallery.single('cover'), async (req, res) => {
  const v = await mine(req, { status: { $in: ['uploading', 'draft'] } });
  if (!v) return res.status(404).json({ success: false, message: 'Видео не найдено' });
  if (!req.file) return res.status(400).json({ success: false, message: 'Файл не передан' });
  try {
    await sharp(req.file.buffer).metadata();
  } catch (e) {
    return res.status(400).json({ success: false, message: 'Не удалось обработать изображение' });
  }
  await fs.promises.writeFile(galleryVideo.coverPath(v._id), req.file.buffer);
  v.edit.cover = true;
  await v.save();
  res.json({ success: true, video: draftView(v) });
});

router.delete('/upload/video/:id/cover', requireAuthApi, async (req, res) => {
  const v = await mine(req, { status: { $in: ['uploading', 'draft'] } });
  if (!v) return res.status(404).json({ success: false, message: 'Видео не найдено' });
  await fs.promises.rm(galleryVideo.coverPath(v._id), { force: true });
  v.edit.cover = false;
  await v.save();
  res.json({ success: true, video: draftView(v) });
});

module.exports = router;
