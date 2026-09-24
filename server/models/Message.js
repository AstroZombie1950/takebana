const mongoose = require('mongoose');
const { Schema } = mongoose;

const messageSchema = new Schema({
  conversationId: {
    type: Schema.Types.ObjectId,
    ref: 'Conversation', // Ссылка на диалог, к которому принадлежит сообщение
    required: true
  },
  sender: {
    type: Schema.Types.ObjectId,
    ref: 'User', // Ссылка на отправителя сообщения
    required: true
  },
  // Получатель — только в личной переписке. У сообщения группы
  // (models/Group.js) его нет: там conversationId — id группы.
  recipient: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // Служебная строка группы: «Анна добавила Бориса». Имена — снимком на
  // момент события, как у пересланного: человек мог потом смениться
  // или удалить аккаунт. Текста и вложений у такой строки нет.
  system: {
    type: new Schema({
      kind: { type: String, enum: ['created', 'added', 'removed', 'left', 'joined', 'title', 'photo', 'admin', 'unadmin', 'owner', 'call'], required: true },
      actor: { type: Schema.Types.ObjectId, ref: 'User' },
      actorName: String,
      target: { type: Schema.Types.ObjectId, ref: 'User' },
      targetName: String,
      text: String,        // новое название — у kind: 'title'
    }, { _id: false }),
    default: undefined
  },
  // Текст. У сообщения с вложением может быть пустым — тогда это подпись,
  // которой нет; «либо текст, либо вложение» проверяет маршрут отправки.
  content: {
    type: String,
    default: '',
    trim: true
  },
  // Вложения (utils/attachments.js): файлы лежат в хранилище по key, url —
  // адрес раздачи. Пересланное делит файлы с исходным: ключи те же, и файл
  // стирается, когда на него не ссылается ни одно сообщение.
  attachments: [{
    _id: false,
    kind: { type: String, enum: ['image', 'video', 'audio', 'voice', 'round', 'file'], required: true },
    key: { type: String, required: true },
    url: { type: String, required: true },
    // Картинка: уменьшенная копия для ленты; видео: кадр-обложка.
    previewKey: String,
    preview: String,
    name: String,
    size: Number,
    mime: String,
    width: Number,
    height: Number,
    duration: Number,
    // Голосовое: 48 столбиков громкости 0–31 для волны в ленте.
    wave: [Number]
  }],
  // Ограничение (utils/messageLimit.js): просмотры, таймер после открытия или
  // скачивания. Пока не открыто — ни текста, ни адреса файла браузеру
  // не отдаём. Исчерпано — текст и файлы стираются, остаётся заглушка
  // с expiredAt.
  limit: {
    type: new Schema({
      mode: { type: String, enum: ['views', 'timer', 'downloads'], required: true },
      n: Number,                        // сколько раз можно открыть или скачать
      seconds: Number,                  // таймер: сколько живёт после открытия
      used: { type: Number, default: 0 },
      openedAt: Date,
      grantUntil: Date,                 // до какого времени отдаём файл
      expiresAt: Date,                  // когда стереть; неоткрытое — через 7 дней
    }, { _id: false }),
    default: undefined
  },
  expiredAt: { type: Date, default: null },
  // Ответ: на какое сообщение этого же диалога. Хранится только ссылка,
  // цитату сервер собирает при выдаче (utils/messageView.js): текст,
  // удалённый «у всех» или исчезнувший, не должен жить дальше в цитате.
  replyTo: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
  sentAt: {
    type: Date,
    default: Date.now
  },
  // Статусы, как в мессенджерах: одна галочка — сохранено, две — дошло до
  // браузера получателя (был на связи или подключился позже), две цветные —
  // получатель открыл диалог.
  deliveredAt: { type: Date, default: null },
  readAt: { type: Date, default: null },
  // «Удалить у меня»: сообщение остаётся у собеседника. Когда удалили оба,
  // документ стирается совсем (routes/streaming/messages.js).
  deletedFor: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  // Пересланное: чьё оно было изначально. Имя — снимок на момент пересылки,
  // чтобы подпись не зависела от того, что автор потом сменил логин.
  forwardedFrom: {
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    name: String,
    // Когда было написано исходное и одна ли это пересылка: сообщения одной
    // пачки лента собирает в общую рамку «Переслано» (public/chats.js).
    sentAt: Date,
    batch: String
  }
}, {
  timestamps: true // Автоматически добавляет поля createdAt и updatedAt
});

// Индексы объявляются до mongoose.model: раньше они стояли после, и схема
// успевала скомпилироваться без них.
// Лента переписки: выборка по диалогу с сортировкой по времени
messageSchema.index({ conversationId: 1, sentAt: -1 });
// Непрочитанные и недоставленные получателя
messageSchema.index({ recipient: 1, readAt: 1 });
messageSchema.index({ recipient: 1, deliveredAt: 1 });
// Жив ли ещё файл: удаление вложения проверяет, не ссылается ли на него
// пересланная копия. Частичный — у большинства сообщений вложений нет.
messageSchema.index({ 'attachments.key': 1 }, { partialFilterExpression: { 'attachments.0': { $exists: true } } });
// Уборка исчерпанных и просроченных сообщений с ограничением.
messageSchema.index({ 'limit.expiresAt': 1 }, { partialFilterExpression: { 'limit.expiresAt': { $exists: true } } });

module.exports = mongoose.model('Message', messageSchema);
