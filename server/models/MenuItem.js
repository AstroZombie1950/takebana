// Позиция видео-меню заведения (29.09, docs/VENUES.md п. 10): название,
// описание, цена, раздел и короткий ролик — без звука, по кругу. Меню видно
// на вкладке /venue/:id/menu, когда владелец включил его в настройках
// (Establishments.features.videoMenu). Ролик пережимается со знаком
// и лежит в Bunny — utils/venueMenu.js.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const fileSchema = new Schema({
  url: { type: String, default: '' },
  key: { type: String, default: '' }, // путь в хранилище (utils/storage.js)
}, { _id: false });

const menuItemSchema = new Schema({
  venue: { type: Schema.Types.ObjectId, ref: 'Establishments', required: true },
  // Раздел — строкой, как написал владелец («Горячее», «Напитки»). Порядок
  // разделов — по первой позиции каждого.
  section: { type: String, default: '' },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  // Цена — текстом: «450 ₽», «от 300», «1200 RSD». Валюты у заведений разные,
  // считать по ней сайту нечего.
  price: { type: String, default: '' },
  order: { type: Number, default: 0 },
  // none — ролика нет; processing — пережимается; ready — готов; failed — не
  // вышло (error — причина: novideo, long, restart, convert).
  clip: {
    status: { type: String, enum: ['none', 'processing', 'ready', 'failed'], default: 'none' },
    error: { type: String, default: '' },
    // Какое пережатие сейчас в работе: ролик заменили или убрали, пока шло
    // прежнее, — его результат не записывается поверх (utils/venueMenu.js).
    job: { type: String, default: '' },
    video: { type: fileSchema, default: () => ({}) },
    thumb: { type: fileSchema, default: () => ({}) },
    duration: { type: Number, default: 0 },
  },
  createdAt: { type: Date, default: Date.now },
});

menuItemSchema.index({ venue: 1, order: 1 });
// Оборванное перезапуском пережатие (utils/venueMenu.js, sweep).
menuItemSchema.index({ 'clip.status': 1 }, { partialFilterExpression: { 'clip.status': 'processing' } });

module.exports = mongoose.model('MenuItem', menuItemSchema);
