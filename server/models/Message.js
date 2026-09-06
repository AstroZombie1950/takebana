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
  }
}, {
  timestamps: true // Автоматически добавляет поля createdAt и updatedAt
});

const Message = mongoose.model('Message', messageSchema);

// Экспорт модели
// Лента переписки: выборка по диалогу с сортировкой по времени
messageSchema.index({ conversationId: 1, sentAt: -1 });

module.exports = Message;
