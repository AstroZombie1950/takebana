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
  }
}, {
  timestamps: true // Автоматически добавляет поля createdAt и updatedAt
});

const Conversation = mongoose.model('Conversation', conversationSchema);

// Экспорт модели
module.exports = Conversation;
