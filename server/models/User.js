const mongoose = require('mongoose');
// crypto.randomUUID() встроен в Node и даёт тот же формат, что uuid v4.
// Пакет uuid убран: использовался только ради v4, а его advisory
// (буфер в v3/v5/v6) тянулся в аудит на пустом месте.
const { randomUUID: uuidv4 } = require('crypto'); // Генератор уникальных ключей

const UserSchema = new mongoose.Schema({
  // Имя — свободная строка на любом языке; пока нигде не показывается.
  login: String,
  // Никнейм — под ним человека видят везде (utils/userView.js). Уникальный,
  // в нижнем регистре; правила и выдача — utils/nickname.js.
  nickname: String,
  nicknameChangedAt: { type: Date, default: null },
  // Прежние ники, новые в конце: /@старый уводит 301 на нынешний адрес
  // (routes/streaming/catalog.js). Пока ник не занял кто-то другой — тогда
  // адрес его. Хранятся последние 10.
  formerNicknames: { type: [String], default: undefined },
  // Картинка карточки профиля для мессенджеров в облаке (utils/ogImage.js):
  // адрес, ключ в хранилище и версия — имя файла аватара, из которого собрана.
  ogCard: { url: String, key: String, v: String },
  // В нижнем регистре и без пробелов по краям — и при записи, и в фильтрах
  // запросов (mongoose применяет lowercase и к ним). Старые адреса перевёл
  // jobs/lowercaseEmails.js.
  email: { type: String, lowercase: true, trim: true },
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
  // Когда подписчикам в последний раз сказали, что этот автор в эфире
  // (utils/liveNotify.js). Не память ради памяти: эфир с OBS оживает при
  // каждом переподключении вещателя, паузой он гаснет и загорается снова,
  // а завершённый эфир удаляется вместе со своей отметкой — без этой строки
  // подписчики получали бы «эфир начался» по десять раз за вечер. Повтор —
  // не раньше чем через два часа.
  liveNotifiedAt: {
    type: Date,
    default: null
  },
  avatar: {
    type: String,
    default: null // Ссылка на фото профиля, по умолчанию пустая
  },
  // Настройки последнего эфира: студия подставляет их в форму, чтобы
  // регулярный эфир не заполнять заново. Пишет /start-stream.
  streamDefaults: {
    title: { type: String, default: '' },
    category: { type: String, default: '' },
    subcategory: { type: String, default: '' },
    city: { type: String, default: '' },
    description: { type: String, default: '' },
    isAdult: { type: Boolean, default: false },
    source: { type: String, enum: ['web', 'obs'], default: 'web' },
    // Обложка — переходит на следующий эфир, пока её не убрали или не сменили.
    thumbnail: { type: String, default: '' }
  },
  gallery: {
    type: [String],
    default: [] // Массив URL фотографий личной галереи (макс. 30)
  },
  // ── Модерация ───────────────────────────────────────────────────────────────
  // Бан не закрывает вход: аккаунт живёт, страницы открываются, но писать
  // в чат и переписку и выходить в эфир нельзя. Так забаненный видит причину
  // на своей странице, а снятие бана не требует трогать чужие сессии.
  // Кому владелец закрыл свой канал: эфиры, записи, галерею, подписку
  // (utils/restrict.js).
  restricted: {
    type: [mongoose.Schema.Types.ObjectId],
    default: []
  },
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
  },
  // Восстановление пароля (routes/passwordReset.js). Хранится хеш токена из
  // письма, а не сам токен: копия базы не даёт действующих ссылок. Одна
  // ссылка на человека — новый запрос заменяет прежнюю; после смены пароля
  // поле снимается. requestedAt — чтобы не слать письма чаще раза в минуту.
  passwordReset: {
    tokenHash: String,
    expiresAt: Date,
    requestedAt: Date
  },
  // Смена почты (routes/emailChange.js): новый адрес ждёт подтверждения по
  // ссылке из письма на него же. В базе — хеш токена, как у пароля.
  emailChange: {
    email: String,
    tokenHash: String,
    expiresAt: Date,
    requestedAt: Date
  },
  // Почта подтверждена ссылкой из письма (routes/emailChange.js): после
  // регистрации или смены почты. Ничего не запирает — только статус
  // в настройках. У входа через Google почту подтвердил Google.
  emailVerifiedAt: {
    type: Date,
    default: null
  },
  emailVerify: {
    tokenHash: String,
    expiresAt: Date,
    requestedAt: Date
  }
});

// Новому аккаунту — ник сразу, каким бы путём он ни появился: регистрация,
// Google, сиды, панель. Потом его можно сменить в настройках.
UserSchema.pre('save', async function () {
  if (this.isNew && !this.nickname) {
    this.nickname = await require('../utils/nickname').free(this.constructor, this.login || this.email || 'user');
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

// Переход по ссылке из письма ищет по хешу токена. Частичный: ссылка открыта
// у единиц, остальным строкам место в индексе не нужно.
UserSchema.index({ 'passwordReset.tokenHash': 1 }, { partialFilterExpression: { 'passwordReset.tokenHash': { $exists: true } } });
UserSchema.index({ 'emailChange.tokenHash': 1 }, { partialFilterExpression: { 'emailChange.tokenHash': { $exists: true } } });
UserSchema.index({ 'emailVerify.tokenHash': 1 }, { partialFilterExpression: { 'emailVerify.tokenHash': { $exists: true } } });

// Ник уникален. Частичный индекс, а не sparse: пустая строка тоже «нет ника»,
// и таких до выдачи при запуске может быть несколько.
UserSchema.index({ nickname: 1 }, { unique: true, partialFilterExpression: { nickname: { $type: 'string', $gt: '' } } });
UserSchema.index({ formerNicknames: 1 }, { sparse: true });

module.exports = mongoose.model('User', UserSchema);