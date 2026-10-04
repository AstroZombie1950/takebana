// Нагрузка сервера раз в минуту (utils/loadStats.js; панель → «Система»).
// 1 440 строк в сутки, хранится 30 дней: графики за час, сутки, неделю и месяц
// строятся из них же, отдельных сводок нет.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const KEEP_DAYS = 30;

const loadSampleSchema = new Schema({
  at: { type: Date, default: Date.now },
  cpu: { type: Number, default: 0 },    // % всего процессора сервера
  // Ядра по процессам: 1 — одно ядро целиком. Вне Linux (локально) — null.
  procs: { type: Schema.Types.Mixed, default: null },
  mem: { type: Number, default: 0 },    // % памяти занято
  load: { type: Number, default: 0 },   // load average за минуту
  net: { type: Schema.Types.Mixed, default: null }, // { rx, tx } Мбит/с; вне Linux — null
  disk: { type: Number, default: null }, // % диска эфиров занято
  streams: { type: Schema.Types.Mixed, default: null }, // { full, lite, copy, venue }
  viewers: { type: Number, default: 0 },
  lf: { type: Number, default: 0 },     // из них на запасном пути /lf/
  calls: { type: Number, default: 0 },
  turn: { type: Number, default: 0 },   // порты реле, оценка (utils/turn.js)
  encode: { type: Schema.Types.Mixed, default: null }, // очереди пережатия { recording, chat, gallery }
}, { versionKey: false });

loadSampleSchema.index({ at: 1 }, { expireAfterSeconds: KEEP_DAYS * 86400 });

module.exports = mongoose.model('LoadSample', loadSampleSchema);
