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
  recipient: {
    type: Schema.Types.ObjectId,
    ref: 'User', // Ссылка на получателя сообщения
    required: true
  },
  content: {
    type: String,
    required: true,
    trim: true
  },
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
    name: String
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

module.exports = mongoose.model('Message', messageSchema);
