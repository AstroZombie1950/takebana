// Журнал ошибок: серверных, клиентских и от внешних сервисов.
//
// Строка здесь — не одна ошибка, а группа одинаковых: одна и та же поломка
// за час даёт тысячу записей, и список из тысячи одинаковых строк не читается.
// Ключ группы — отпечаток (fingerprint) из вида, места и текста; повтор
// увеличивает счётчик и сдвигает lastAt. Подробности храним от последнего
// случая: для разбора важен свежий, а не первый.
const mongoose = require('mongoose');

const TTL_DAYS = Number(process.env.ERRORLOG_TTL_DAYS) || 90;

const ErrorLogSchema = new mongoose.Schema({
  fingerprint: { type: String, required: true, unique: true },
  // server — маршрут Express, client — браузер посетителя, media — RTMP,
  // ffmpeg и HLS, external — Daily, Bunny, почта, геокодер, база.
  scope: { type: String, enum: ['server', 'client', 'media', 'external'], required: true },
  name: { type: String, default: '' },
  message: { type: String, default: '' },
  stack: { type: String, default: '' },
  // Для серверных — метод и путь, для клиентских — страница, где упало.
  route: { type: String, default: '' },
  status: { type: Number, default: 0 },
  count: { type: Number, default: 1 },
  firstAt: { type: Date, default: Date.now },
  lastAt: { type: Date, default: Date.now },
  lastUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  lastIp: { type: String, default: '' },
  lastUa: { type: String, default: '' },
  lastMeta: { type: mongoose.Schema.Types.Mixed, default: null },
  // Разобрано: строка уходит из основного списка, но остаётся в истории.
  // Вернётся сама, если ошибка повторится после отметки.
  resolved: { type: Boolean, default: false },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolvedAt: { type: Date, default: null },
}, { versionKey: false });

// Список ошибок: неразобранные, свежие сверху
ErrorLogSchema.index({ resolved: 1, lastAt: -1 });
// Разбивка по виду
ErrorLogSchema.index({ scope: 1, lastAt: -1 });
// Уборка по сроку: считается от последнего случая, а не от первого
ErrorLogSchema.index({ lastAt: 1 }, { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60 });

module.exports = mongoose.model('ErrorLog', ErrorLogSchema);
