// Отметка «этот зритель уже смотрел запись сегодня»: просмотр считается
// раз в сутки на зрителя, иначе счётчик накручивается обновлением страницы.
// Зритель — id пользователя или, у гостя, хеш адреса и браузера
// (routes/recordings.js). Сами отметки живут сутки и исчезают сами.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const viewSchema = new Schema({
  recordingId: { type: Schema.Types.ObjectId, required: true },
  viewer: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 24 * 3600 },
});

viewSchema.index({ recordingId: 1, viewer: 1 }, { unique: true });

module.exports = mongoose.model('RecordingView', viewSchema);
