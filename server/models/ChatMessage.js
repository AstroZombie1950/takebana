// models/ChatMessage.js
const mongoose = require('mongoose');

// Чат эфира (streamId) или камеры заведения (venueId, с 24.09) — у сообщения
// одно из двух. Общая коллекция: срок хранения, удаление вместе с аккаунтом
// (utils/userDelete.js) и разбор жалоб — одни.
const ChatMessageSchema = new mongoose.Schema({
  streamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Stream',
    required: function () { return !this.venueId; }
  },
  venueId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Establishments'
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  username: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Чат эфира и дозагрузка новых сообщений после известного времени
ChatMessageSchema.index({ streamId: 1, createdAt: 1 });
// То же для камеры заведения — только по сообщениям, где заведение есть.
ChatMessageSchema.index({ venueId: 1, createdAt: 1 }, { partialFilterExpression: { venueId: { $exists: true } } });
// Срок хранения — 90 дней: чат нужен, пока идёт эфир, и какое-то время
// после — для жалоб. Без срока коллекция росла бы с каждым эфиром вечно.
ChatMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('ChatMessage', ChatMessageSchema);
