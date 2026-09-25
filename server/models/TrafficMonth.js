// Трафик сервера за календарный месяц (utils/traffic.js). Строка на месяц:
// сколько вошло и вышло, последние показания счётчиков ядра — от них
// считается следующая прибавка, — и какой порог предупреждения уже прозвучал.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const trafficSchema = new Schema({
  month: { type: String, required: true, unique: true }, // '2026-09', UTC
  rx: { type: Number, default: 0 },
  tx: { type: Number, default: 0 },
  lastRx: { type: Number, default: 0 },
  lastTx: { type: Number, default: 0 },
  warned: { type: Number, default: 0 }, // 0, 70 или 90 — процент лимита
  startedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('TrafficMonth', trafficSchema);
