// Оценка записи: нравится (1) или не нравится (-1). Один человек — одна
// оценка на запись; счётчики лежат в самой записи (Recording.likes/dislikes),
// чтобы страница и карточки не считали их на каждый показ.
// recordingId — id записи эфира или, с 23.09.2026, видео галереи (models/
// GalleryVideo.js): id в Mongo уникальны, одна коллекция служит обоим.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const reactionSchema = new Schema({
  recordingId: { type: Schema.Types.ObjectId, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  value: { type: Number, enum: [1, -1], required: true },
  createdAt: { type: Date, default: Date.now },
});

reactionSchema.index({ recordingId: 1, userId: 1 }, { unique: true });
// Удаление аккаунта убирает его оценки (utils/userDelete.js).
reactionSchema.index({ userId: 1 });

module.exports = mongoose.model('RecordingReaction', reactionSchema);
