// models/ChatMessage.js
const mongoose = require('mongoose');

const ChatMessageSchema = new mongoose.Schema({
  streamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Stream',
    required: true
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

module.exports = mongoose.model('ChatMessage', ChatMessageSchema);
