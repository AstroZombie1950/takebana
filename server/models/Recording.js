// Запись эфира: ведущий завершил эфир кнопкой «Сохранить запись». Хранится,
// пока автор не удалит. Куски пишет HLS-конвейер (utils/hls.js), склейку
// и выгрузку в хранилище делает utils/recording.js.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const fileSchema = new Schema({
  url: { type: String, default: '' },
  key: { type: String, default: '' },   // путь в хранилище (utils/storage.js)
}, { _id: false });

const recordingSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  // Карточка эфира на момент завершения: сам эфир при этом удаляется.
  title: { type: String, required: true },
  description: { type: String, default: '' },
  category: { type: String, default: '' },
  subcategory: { type: String, default: '' },
  city: { type: String, default: '' },
  // Метка 18+ переходит с эфира: смотреть — после подтверждения возраста.
  isAdult: { type: Boolean, default: false },
  // processing — склеивается и выгружается; ready — можно смотреть;
  // failed — не получилось, автору видно, удаляется им же.
  status: { type: String, enum: ['processing', 'ready', 'failed'], default: 'processing' },
  duration: { type: Number, default: 0 },   // секунды
  size: { type: Number, default: 0 },       // байты
  video: { type: fileSchema, default: () => ({}) },
  // Несколько качеств (utils/recordingHls.js): главный плейлист и все файлы
  // в хранилище. Появляется через несколько минут после готовности;
  // тогда MP4 из video удаляется.
  hls: {
    url: { type: String, default: '' },
    files: { type: [String], default: undefined },
  },
  thumb: { type: fileSchema, default: () => ({}) },
  recordedAt: { type: Date, default: null }, // первый выход в эфир
  // Счётчики для страницы и карточек; источники — RecordingView,
  // RecordingReaction, RecordingComment. Дизлайки видит только автор.
  views: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  dislikes: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

// Записи на странице пользователя — новые сверху.
recordingSchema.index({ userId: 1, createdAt: -1 });
// Рекомендации: готовые записи раздела, популярные сверху.
recordingSchema.index({ status: 1, category: 1, views: -1 });

module.exports = mongoose.model('Recording', recordingSchema);
