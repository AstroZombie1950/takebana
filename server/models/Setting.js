// Настройки сайта, которые меняют из панели, а не через .env: одна запись
// на настройку, _id — её имя. Первая — сроки хранения файлов
// (utils/retention.js, 28.09.2026).
const mongoose = require('mongoose');
const { Schema } = mongoose;

const settingSchema = new Schema({
  _id: { type: String },
  value: { type: Schema.Types.Mixed, default: () => ({}) },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { minimize: false });

module.exports = mongoose.model('Setting', settingSchema);
