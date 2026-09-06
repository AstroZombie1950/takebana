const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid'); // Генератор уникальных ключей

const UserSchema = new mongoose.Schema({
  login: String,
  email: String,
  password: String,
  provider: String,
  role: {
    type: String,
    default: 'user'
  },
  isOnline: {
    type: Boolean,
    default: false
  },
  lastSeen: {
    type: Date,
    default: null
  },
  streamKey: {
    type: String,
    default: '' // Изначально пустой, сгенерируем позже
  },
  avatar: {
    type: String,
    default: null // Ссылка на фото профиля, по умолчанию пустая
  },
  gallery: {
    type: [String],
    default: [] // Массив URL фотографий личной галереи (макс. 30)
  }
});

// Вход и регистрация ищут ровно по этой паре (routes/userRoutes.js, app.js).
// Уникальность заодно не даёт завести два аккаунта с одним email у одного провайдера:
// email+provider, а не только email, — потому что у одной почты может быть
// и вход по паролю (provider: ''), и вход через Google (provider: 'google').
UserSchema.index({ email: 1, provider: 1 }, { unique: true });

module.exports = mongoose.model('User', UserSchema);