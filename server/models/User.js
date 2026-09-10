const mongoose = require('mongoose');
// crypto.randomUUID() встроен в Node и даёт тот же формат, что uuid v4.
// Пакет uuid убран: использовался только ради v4, а его advisory
// (буфер в v3/v5/v6) тянулся в аудит на пустом месте.
const { randomUUID: uuidv4 } = require('crypto'); // Генератор уникальных ключей

const UserSchema = new mongoose.Schema({
  login: String,
  email: String,
  password: String,
  provider: String,
  // Модератор заведён рядом с администратором сразу: точный набор его прав
  // ещё обсуждается, но дописать роль в enum задним числом дороже, чем оставить
  // ей место сейчас. Проверки — canModerate() в middleware/auth.js.
  role: {
    type: String,
    enum: ['user', 'moderator', 'admin'],
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
  },
  // ── Модерация ───────────────────────────────────────────────────────────────
  // Бан не закрывает вход: аккаунт живёт, страницы открываются, но писать
  // в чат и переписку и выходить в эфир нельзя. Так забаненный видит причину
  // на своей странице, а снятие бана не требует трогать чужие сессии.
  banned: {
    type: Boolean,
    default: false
  },
  banReason: {
    type: String,
    default: ''
  },
  bannedAt: {
    type: Date,
    default: null
  },
  bannedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // Гейт 18+: возраст подтверждается самодекларацией один раз и запоминается.
  // Дата, а не флаг — чтобы было видно, когда именно человек подтвердил.
  adultConfirmedAt: {
    type: Date,
    default: null
  }
});

// Вход и регистрация ищут ровно по этой паре (routes/userRoutes.js, app.js).
// Уникальность заодно не даёт завести два аккаунта с одним email у одного провайдера:
// email+provider, а не только email, — потому что у одной почты может быть
// и вход по паролю (provider: ''), и вход через Google (provider: 'google').
UserSchema.index({ email: 1, provider: 1 }, { unique: true });

// Список забаненных в панели. Частичный индекс: строк с banned: true единицы,
// а платить за индекс по всей коллекции ради них незачем.
UserSchema.index({ banned: 1 }, { partialFilterExpression: { banned: true } });

module.exports = mongoose.model('User', UserSchema);