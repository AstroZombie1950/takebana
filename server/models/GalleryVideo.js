// Видео в галерее профиля («Фото и видео»). Фото лежат строками в
// User.gallery, видео — здесь: у него есть обработка (пережатие со знаком,
// utils/galleryVideo.js), обложка и длительность. С 23.09.2026 у готового
// видео своя страница /video/:id (routes/watch.js) — с названием, оценками,
// комментариями и просмотрами, как у записи эфира.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const fileSchema = new Schema({
  url: { type: String, default: '' },
  key: { type: String, default: '' }, // путь в хранилище (utils/storage.js)
}, { _id: false });

const galleryVideoSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  // uploading — файл ещё едет кусками со страницы загрузки (/upload);
  // draft — доехал, ждёт «Опубликовать»; processing — пережимается;
  // ready — можно смотреть; failed — не вышло. Всё, кроме ready, видит
  // только владелец.
  status: { type: String, enum: ['uploading', 'draft', 'processing', 'ready', 'failed'], default: 'processing' },
  // Загрузка кусками (routes/streaming/upload.js): сколько всего и сколько
  // доехало. Файл копится в media/upload/<id>.part.
  upload: {
    name: { type: String, default: '' },
    size: { type: Number, default: 0 },
    received: { type: Number, default: 0 },
  },
  // Правка со страницы загрузки: обрезка (секунды от начала исходника),
  // без звука, кадр обложки. Своя картинка обложки — media/upload/<id>.cover,
  // флаг cover. publish — «Опубликовать» нажали: доедет файл — пережимаем.
  edit: {
    start: { type: Number, default: 0 },
    end: { type: Number, default: 0 },   // 0 — до конца
    mute: { type: Boolean, default: false },
    coverAt: { type: Number, default: -1 }, // -1 — кадр выбирает сервер
    cover: { type: Boolean, default: false },
  },
  publish: { type: Boolean, default: false },
  // Пусто — страница подписывает видео датой (routes/watch.js).
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  error: { type: String, default: '' },
  duration: { type: Number, default: 0 }, // секунды
  size: { type: Number, default: 0 },     // байты после пережатия
  video: { type: fileSchema, default: () => ({}) },
  thumb: { type: fileSchema, default: () => ({}) },
  // Счётчики — как у записи (models/Recording.js): источники те же
  // RecordingView, RecordingReaction, RecordingComment.
  views: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  dislikes: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

// Галерея человека — новые сверху.
galleryVideoSchema.index({ userId: 1, createdAt: -1 });
// Уборка брошенных загрузок (utils/galleryVideo.js, sweepDrafts).
galleryVideoSchema.index({ status: 1, createdAt: 1 });
// «Смотрите также»: популярные готовые (utils/recommend.js).
galleryVideoSchema.index({ status: 1, views: -1 });

module.exports = mongoose.model('GalleryVideo', galleryVideoSchema);
