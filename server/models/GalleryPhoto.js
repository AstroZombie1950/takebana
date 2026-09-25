// Фото в галерее профиля. До 25.09.2026 фото жили строками в User.gallery:
// у строки нет ни подписи, ни оценок, ни комментариев, а заказчик попросил
// ленту фото «как в Инстаграме» — с подписью, лайками и комментариями.
// Перенос старых строк — utils/galleryPhotos.js, migrate (при запуске).
//
// У каждого фото своя страница /photo/:id (routes/watch.js) — тот же
// обработчик, что у записи эфира и видео. Оценки и комментарии лежат
// в общих коллекциях RecordingReaction и RecordingComment: id в Mongo
// уникальны, recordingId указывает на любое из трёх. Просмотров у фото нет.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const galleryPhotoSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  // Адрес на CDN или, у загруженных до переезда в Bunny, /uploads/gallery/…
  // Сжатие и знак — при загрузке (utils/galleryPhotos.js).
  url: { type: String, required: true },
  // Подпись: при загрузке и потом со страницы фото.
  caption: { type: String, default: '' },
  // Только «нравится»: дизлайка у фото нет, но счётчик общий обработчик
  // оценок ведёт у всех трёх видов одинаково.
  likes: { type: Number, default: 0 },
  dislikes: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

// Лента человека — новые сверху; соседи на странице фото — тот же индекс.
galleryPhotoSchema.index({ userId: 1, createdAt: -1 });
// Перенос из User.gallery идёт повторно после сбоя — дубль адреса не пройдёт.
galleryPhotoSchema.index({ url: 1 }, { unique: true });

module.exports = mongoose.model('GalleryPhoto', galleryPhotoSchema);
