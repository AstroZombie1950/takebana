// Рассылка от аккаунта поддержки (utils/support.js): кто отправил, что,
// кому и сколько дошло. История — на вкладке «Рассылка» панели.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const broadcastSchema = new Schema({
  by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  // Заготовка, с которой начинали (utils/support.js, TEMPLATES), или '' — от руки.
  template: { type: String, default: '' },
  // Текст на двух языках: каждому уходит на его языке (User.lang).
  text: { ru: { type: String, default: '' }, en: { type: String, default: '' } },
  audience: {
    kind: { type: String, enum: ['all', 'recent', 'nopush', 'self'], required: true },
    days: Number,
  },
  push: { type: Boolean, default: true },
  total: { type: Number, default: 0 },
  sent: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  // stopped — процесс перезапустили посреди рассылки: дошло sent из total.
  status: { type: String, enum: ['running', 'done', 'stopped'], default: 'running' },
  createdAt: { type: Date, default: Date.now },
  finishedAt: { type: Date, default: null },
});

broadcastSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Broadcast', broadcastSchema);
