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
  // Код из config/catalog.js, пустая строка — город не указан. Такой эфир
  // виден в каталоге только без фильтра по городу.
  city: {
    type: String,
    default: ''
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
  },
  // ── Модерация ───────────────────────────────────────────────────────────────
  // Метка 18+ ставится вещателем при создании эфира и снимается только
  // модерацией. Зритель перед входом подтверждает возраст (User.adultConfirmedAt).
  isAdult: {
    type: Boolean,
    default: false
  },
  // Эфир, погашенный модерацией. isActive при этом уходит в false, но отдельный
  // флаг нужен, чтобы вещатель не поднял его обратно тем же ключом как ни в чём
  // не бывало, а причина осталась видимой и ему, и в разборе жалобы.
  stoppedByModeration: {
    type: Boolean,
    default: false
  },
  stopReason: {
    type: String,
    default: ''
  },
  stoppedAt: {
    type: Date,
    default: null
  },
  stoppedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
});

// Активный эфир пользователя — самый частый запрос страницы трансляции
StreamSchema.index({ userId: 1, isActive: 1 });
// Поиск эфира по ключу вещания (RTMP/OBS)
StreamSchema.index({ streamKey: 1 });
// Каталог: только идущие эфиры, по умолчанию по числу зрителей. Категория,
// подкатегория и город отсекаются уже внутри активных — их единицы, а не
// тысячи. Прежний индекс isActive + streamType + streamProvider не
// обслуживал ни одного запроса.
StreamSchema.index({ isActive: 1, viewers: -1 });
// Уборка мёртвых эфиров перебирает по паре isActive + updatedAt
StreamSchema.index({ isActive: 1, updatedAt: 1 });
// Погашенные модерацией — отдельный список в панели, строк единицы
StreamSchema.index({ stoppedByModeration: 1 }, { partialFilterExpression: { stoppedByModeration: true } });
// Сопоставление комнаты Daily.co с эфиром
StreamSchema.index({ dailyRoomName: 1 });

module.exports = mongoose.model('Stream', StreamSchema);