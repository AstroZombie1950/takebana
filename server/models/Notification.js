// models/Notification.js
const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    // message — новое сообщение, call — пропущенный звонок,
    // comment — комментарий к записи эфира, live — автор, на которого
    // подписан получатель, вышел в эфир (utils/liveNotify.js),
    // follow — на получателя подписались (routes/streaming/subscriptions.js)
    enum: ['message', 'call', 'comment', 'live', 'follow'],
    required: true
  },
  content: {
    type: String, // Можно хранить текст последнего сообщения
    required: false
  },
  // Куда ведёт строка уведомления, если не в переписку: комментарий — к записи.
  link: {
    type: String,
    default: ''
  },
  isRead: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Счётчик непрочитанных и лента уведомлений получателя
NotificationSchema.index({ recipient: 1, isRead: 1 });
NotificationSchema.index({ recipient: 1, createdAt: -1 });
// Срок хранения — 180 дней: колокольчик показывает свежее, а без срока
// коллекция растёт с каждой подпиской, эфиром и пропущенным звонком.
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('Notification', NotificationSchema);