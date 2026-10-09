// Публикация поста (09.10.2026, models/Post.js) — из профиля и «Ленты»
// (partials/composer.ejs, public/tk-composer.js). Страница поста, правка,
// удаление, оценки и комментарии — общие с фото и видео (routes/watch.js).
//
// Тело — multipart: фото файлами (photos), текст, тема, id видео-черновиков
// (videos, JSON) — ролики к этому времени едут фоновой загрузкой кусками
// (tk-upload.js) — и порядок медиа (order, JSON). Всё остальное —
// utils/posts.js.

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { requireAuthApi, requireNotBanned } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { uploadGallery } = require('./streaming/uploads');
const { BadImageError } = require('../utils/image');
const mentions = require('../utils/mentions');
const topics = require('../utils/topics');
const posts = require('../utils/posts');
const { audit } = require('../utils/audit');

// Тридцать постов в час с человека — живому блогу хватает, спам-циклу нет.
const postLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => String(req.session.userId),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Слишком много постов подряд — попробуйте через час' },
});

router.post('/posts', requireAuthApi, requireNotBanned, postLimiter, uploadGallery.array('photos', posts.MEDIA_MAX), validate({
  text: { type: 'string', max: posts.TEXT_MAX, allowEmpty: true, default: '', label: 'Текст' },
  topic: { type: 'string', max: 40, allowEmpty: true, default: '', label: 'Тема' },
  videos: { type: 'array', json: true, max: posts.MEDIA_MAX, default: [], of: { type: 'objectId' }, label: 'Видео' },
  order: { type: 'array', json: true, max: posts.MEDIA_MAX, default: [], of: { type: 'string', max: 30 }, label: 'Порядок' },
}), async (req, res) => {
  const text = mentions.clean(req.body.text);
  if (text.foreign) return res.status(400).json({ message: mentions.FOREIGN_MESSAGE });
  const topic = topics.valid(req.body.topic) ? req.body.topic : '';
  let post;
  try {
    post = await posts.create(req.session.userId, {
      text: text.text, topic, files: req.files || [], videoIds: req.body.videos, order: req.body.order,
    });
  } catch (e) {
    if (e instanceof posts.PostError || e instanceof BadImageError) return res.status(400).json({ message: e.message });
    throw e;
  }
  audit(req, 'post.create', { targetType: 'post', targetId: post._id, meta: { topic, media: post.media.length, len: post.text.length } });
  res.status(201).json({ id: String(post._id), url: '/post/' + post._id, status: post.status });
});

module.exports = router;
