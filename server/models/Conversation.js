const mongoose = require('mongoose');
const { Schema } = mongoose;

const conversationSchema = new Schema({
  userOne: {
    type: Schema.Types.ObjectId,
    ref: 'User', // Ссылка на первого пользователя
    required: true
  },
  userTwo: {
    type: Schema.Types.ObjectId,
    ref: 'User', // Ссылка на второго пользователя
    required: true
  },
  lastMessage: {
    type: Schema.Types.ObjectId,
    ref: 'Message' // Ссылка на последнее сообщение в диалоге
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  // Кто удалил переписку у себя: диалог пропадает из его списка и
  // возвращается с первым новым сообщением.
  hiddenFor: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  // Пара «меньший id:больший id» — для уникального индекса: два
  // одновременных «написать» (двойное нажатие, оба пишут друг другу)
  // заводили два диалога, и история расползалась. Есть только у диалогов
  // с 24.09.2026; старые находятся по userOne/userTwo, как и раньше.
  pair: { type: String }
}, {
  timestamps: true // Автоматически добавляет поля createdAt и updatedAt
});

// Диалог ищется в обе стороны через $or, поэтому нужны оба порядка
conversationSchema.index({ userOne: 1, userTwo: 1 });
conversationSchema.index({ userTwo: 1, userOne: 1 });
// Список переписок человека страницами, от свежих (routes/streaming/messages.js).
conversationSchema.index({ userOne: 1, lastUpdated: -1 });
conversationSchema.index({ userTwo: 1, lastUpdated: -1 });
conversationSchema.index({ pair: 1 }, { unique: true, partialFilterExpression: { pair: { $exists: true } } });

module.exports = mongoose.model('Conversation', conversationSchema);
