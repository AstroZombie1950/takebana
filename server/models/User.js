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

module.exports = mongoose.model('User', UserSchema);