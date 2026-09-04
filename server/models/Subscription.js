const mongoose = require('mongoose');

const SubscriptionSchema = new mongoose.Schema({
    subscriberId: { 
      type: mongoose.Schema.Types.ObjectId, // Используем ObjectId для ссылок на пользователей
      required: true 
    },
    subscribedToId: { 
      type: mongoose.Schema.Types.ObjectId, // Используем ObjectId для ссылок на пользователей
      required: true 
    },
    createdAt: { 
      type: Date, 
      default: Date.now // Дата и время подписки
    }
  });

module.exports = mongoose.model('Subscription', SubscriptionSchema);