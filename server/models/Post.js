// Пост (09.10.2026, решение заказчика): текст, фото и видео в любом
// сочетании — как в Инстаграме, — и тема по желанию. Пишут из своего
// профиля и из «Ленты» (partials/composer.ejs), показываются в «Ленте»
// и в ленте автора на его странице (utils/feed.js), у каждого — страница
// /post/:id (routes/watch.js).
//
// Фото и видео поста — обычные GalleryPhoto и GalleryVideo с полем post:
// они и в «Фото» и «Видео» автора, и в переписке из библиотеки. Здесь —
// ссылки на них по порядку. Оценки и комментарии — в общих RecordingReaction
// и RecordingComment, как у фото и видео (id в Mongo уникальны).
const mongoose = require('mongoose');
const { Schema } = mongoose;

const mediaSchema = new Schema({
  kind: { type: String, enum: ['photo', 'video'], required: true },
  ref: { type: Schema.Types.ObjectId, required: true },
}, { _id: false });

const postSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, default: '' },
  // Код темы или раздела (config/catalog.js, utils/topics.js); пусто — без темы.
  topic: { type: String, default: '' },
  media: { type: [mediaSchema], default: [] },
  // processing — ролики поста ещё пережимаются: пост видит только автор;
  // ready — в ленте. Без видео пост готов сразу.
  status: { type: String, enum: ['processing', 'ready'], default: 'ready' },
  // Счётчики — как у фото (models/GalleryPhoto.js): только «нравится»,
  // dislikes ведёт общий обработчик оценок.
  likes: { type: Number, default: 0 },
  dislikes: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

// Лента автора и «Лента» — новые сверху; фильтр по теме.
postSchema.index({ userId: 1, createdAt: -1 });
postSchema.index({ status: 1, createdAt: -1 });
postSchema.index({ topic: 1, createdAt: -1 }, { partialFilterExpression: { topic: { $gt: '' } } });
// Ролик поста дожат — найти пост по нему (utils/posts.js, videoDone).
postSchema.index({ 'media.ref': 1 });

module.exports = mongoose.model('Post', postSchema);
