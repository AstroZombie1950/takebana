// models/Stream.js
const mongoose = require('mongoose');

const StreamSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String
  },
  category: {
    type: String,
    required: true
  },
  subcategory: {
    type: String,
    required: true
  },
  streamKey: {
    type: String,
    required: true // Stream должен содержать streamKey
  },
  isActive: {
    type: Boolean,
    default: true
  },
  startedAt: {
    type: Date,
    default: null // Время начала стрима
  },
  viewers: {
    type: Number,
    default: 0
  },
  thumbnail: {
    type: String, // Путь к изображению
    default: null // Оставляем пустым по умолчанию
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  streamType: {
    type: String,
    default: 'web-stream' // Значение по умолчанию
  },
  // Daily.co поля для веб-стрима
  dailyRoomName: {
    type: String,
    default: null // Имя комнаты в Daily.co
  },
  dailyRoom: {
    name: { type: String, default: null },
    url: { type: String, default: null }
  },
  streamProvider: {
    type: String,
    enum: ['web-stream', 'obs'], // 'web-stream' = Daily.co, 'obs' = OBS через RTMP
    default: 'web-stream'
  }
});

// Активный эфир пользователя — самый частый запрос страницы трансляции
StreamSchema.index({ userId: 1, isActive: 1 });
// Поиск эфира по ключу вещания (RTMP/OBS)
StreamSchema.index({ streamKey: 1 });
// Списки на витрине: фильтр по категории всегда идёт вместе с isActive
StreamSchema.index({ isActive: 1, streamType: 1, streamProvider: 1 });
// Уборка мёртвых эфиров перебирает по паре isActive + updatedAt
StreamSchema.index({ isActive: 1, updatedAt: 1 });
// Сопоставление комнаты Daily.co с эфиром
StreamSchema.index({ dailyRoomName: 1 });

module.exports = mongoose.model('Stream', StreamSchema);