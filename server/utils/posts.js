// Посты (09.10.2026, models/Post.js): публикация, готовность и удаление.
//
// Фото поста сохраняются как фото галереи (utils/galleryPhotos.js: сжатие,
// знак, Bunny) — с полем post и подписью из текста поста: у каждого фото
// своя страница в индексе, и без подписи у неё не было бы описания
// (правило «описание и alt — у всего в индексе»). Видео едет заранее
// фоновой загрузкой кусками (tk-upload.js) черновиком; пост его забирает:
// post, «Опубликовать» и описание из текста. Пока ролики пережимаются,
// пост в работе — его видит только автор; дожаты — пост в ленте.

const mongoose = require('mongoose');
const Post = require('../models/Post');
const GalleryPhoto = require('../models/GalleryPhoto');
const GalleryVideo = require('../models/GalleryVideo');
const galleryPhotos = require('./galleryPhotos');
const galleryVideo = require('./galleryVideo');
const engagement = require('./engagement');
const indexNow = require('./indexNow');
const errorLog = require('./errorLog');

const TEXT_MAX = 5000;
// Сколько фото и видео в одном посте — как карусель Инстаграма.
const MEDIA_MAX = 10;

class PostError extends Error {}

// order — порядок медиа, как их расставил человек: 'p0' — фото по номеру
// файла, 'v<id>' — видео-черновик. Без порядка — фото, потом видео.
function arrange(order, photos, videos) {
  const p = photos.map((doc, i) => ['p' + i, { kind: 'photo', ref: doc._id }]);
  const v = videos.map((doc) => ['v' + doc._id, { kind: 'video', ref: doc._id }]);
  const all = new Map(p.concat(v));
  const out = [];
  for (const key of Array.isArray(order) ? order : []) {
    if (all.has(key)) { out.push(all.get(key)); all.delete(key); }
  }
  return out.concat([...all.values()]);
}

// files — фото из multer (память), videoIds — черновики видео этого человека.
// → пост; PostError — понятный человеку отказ.
async function create(userId, { text, topic, files, videoIds, order }) {
  if (files.length + videoIds.length > MEDIA_MAX) throw new PostError(`В посте — не больше ${MEDIA_MAX} фото и видео`);
  if (!text && !files.length && !videoIds.length) throw new PostError('Пустой пост: добавьте текст, фото или видео');

  const videos = videoIds.length
    ? await GalleryVideo.find({ _id: { $in: videoIds }, userId, post: null, status: { $in: ['uploading', 'draft'] } }).select('_id').lean()
    : [];
  if (videos.length !== videoIds.length) throw new PostError('Видео не найдено — загрузите его заново');
  if (files.length) {
    const left = galleryPhotos.MAX_PER_USER - await GalleryPhoto.countDocuments({ userId });
    if (files.length > left) throw new PostError(`Фото у вас уже ${galleryPhotos.MAX_PER_USER - left} из ${galleryPhotos.MAX_PER_USER} — удалите лишние`);
  }

  const _id = new mongoose.Types.ObjectId();
  const saved = files.length ? await galleryPhotos.save(userId, files) : [];
  // Время фото — с шагом в миллисекунду, как у пачки галереи: порядок
  // в «Фото» автора тот же, что в посте.
  const now = Date.now();
  const photos = saved.length ? await GalleryPhoto.insertMany(saved.map((x, i) => ({
    userId, url: x.url, width: x.width, height: x.height, post: _id,
    caption: text.slice(0, galleryPhotos.CAPTION_MAX), createdAt: new Date(now + saved.length - i),
  }))) : [];

  const post = await Post.create({
    _id, userId, text, topic,
    media: arrange(order, photos, videos),
    status: videos.length ? 'processing' : 'ready',
  });
  if (videos.length) {
    await GalleryVideo.updateMany({ _id: { $in: videos.map((v) => v._id) } },
      { $set: { post: _id, publish: true, description: text.slice(0, galleryVideo.DESCRIPTION_MAX) } });
    for (const v of videos) await galleryVideo.publishIfReady(v._id);
  } else {
    indexNow.ping('/post/' + _id);
  }
  if (photos.length) indexNow.ping(...photos.map((p) => '/photo/' + p._id));
  return post;
}

// Ролик поста дожат или не вышел: когда в работе ничего не осталось — пост
// готов, без не вышедших роликов. Остался пустым (ни текста, ни медиа) —
// удаляется: показывать нечего.
async function videoDone(postId) {
  const post = await Post.findById(postId).lean();
  if (!post || post.status === 'ready') return;
  const refs = post.media.filter((m) => m.kind === 'video').map((m) => m.ref);
  const videos = await GalleryVideo.find({ _id: { $in: refs } }).select('status').lean();
  if (videos.some((v) => ['uploading', 'draft', 'processing'].includes(v.status))) return;
  const ok = new Set(videos.filter((v) => v.status === 'ready').map((v) => String(v._id)));
  const media = post.media.filter((m) => m.kind === 'photo' || ok.has(String(m.ref)));
  if (!media.length && !post.text) return remove(post);
  await Post.updateOne({ _id: post._id }, { $set: { media, status: 'ready' } });
  indexNow.ping('/post/' + post._id);
}

// Фото или видео поста удалили по отдельности (со своей страницы) — из
// поста его тоже. Пустой пост уходит следом.
async function mediaGone(postId, ref) {
  const post = await Post.findOneAndUpdate({ _id: postId }, { $pull: { media: { ref } } }, { returnDocument: 'after' }).lean();
  if (!post) return;
  if (!post.media.length && !post.text) return remove(post);
  if (post.status === 'processing') await videoDone(post._id);
}

// Пост удалён: сначала он сам (его медиа, уходя, ищут пост — и не находят),
// потом фото и видео, оценки, комментарии и жалобы.
async function remove(post) {
  await Post.deleteOne({ _id: post._id });
  const [photos, videos] = await Promise.all([
    GalleryPhoto.find({ post: post._id }).lean(),
    GalleryVideo.find({ post: post._id }).lean(),
  ]);
  for (const p of photos) await galleryPhotos.remove(p).catch((e) => errorLog.server(e, 'posts.remove.photo'));
  for (const v of videos) await galleryVideo.remove(v).catch((e) => errorLog.server(e, 'posts.remove.video'));
  await engagement.forgetTarget(post._id, 'post');
}

// Удаление аккаунта: посты — документами; фото и видео уходят своей дорогой
// (utils/userDelete.js), оценки и комментарии — engagement.forgetTarget.
async function removeAll(userId) {
  const posts = await Post.find({ userId }).select('_id').lean();
  await Post.deleteMany({ userId });
  for (const p of posts) await engagement.forgetTarget(p._id, 'post');
}

// Пост, чьи ролики так и не доехали (загрузку бросили — черновик убрала
// уборка galleryVideo.sweepDrafts), — довести до конца раз в шесть часов.
async function sweep() {
  const stuck = await Post.find({ status: 'processing', createdAt: { $lt: new Date(Date.now() - 864e5) } }).select('_id').lean().catch(() => []);
  for (const p of stuck) await videoDone(p._id).catch((e) => errorLog.server(e, 'posts.sweep'));
}

function start() {
  sweep();
  setInterval(sweep, 6 * 3600 * 1000).unref();
}

module.exports = { TEXT_MAX, MEDIA_MAX, PostError, create, videoDone, mediaGone, remove, removeAll, start };
