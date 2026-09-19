// Видео в галерее профиля («Фото и видео»). Фото лежат строками в
// User.gallery, видео — здесь: у него есть обработка (пережатие со знаком,
// utils/galleryVideo.js), обложка и длительность.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const fileSchema = new Schema({
  url: { type: String, default: '' },
  key: { type: String, default: '' }, // путь в хранилище (utils/storage.js)
}, { _id: false });

const galleryVideoSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  // processing — пережимается; ready — можно смотреть; failed — не вышло,
  // видит только владелец и удаляет сам.
  status: { type: String, enum: ['processing', 'ready', 'failed'], default: 'processing' },
  error: { type: String, default: '' },
  duration: { type: Number, default: 0 }, // секунды
  size: { type: Number, default: 0 },     // байты после пережатия
  video: { type: fileSchema, default: () => ({}) },
  thumb: { type: fileSchema, default: () => ({}) },
  createdAt: { type: Date, default: Date.now },
});

// Галерея человека — новые сверху.
galleryVideoSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('GalleryVideo', galleryVideoSchema);
