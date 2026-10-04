// Сеанс камеры заведения: от «включить» до «выключить» (utils/venueLog.js).
//
// У эфира такой отрезок — StreamSession, у камеры его не было: публикации
// и сбои видели только попытки владельца и зрителей в браузере, а что
// делал сервер — просил ли камеру, пришла ли публикация в MediaMTX,
// стартовал ли ffmpeg и когда выдал плейлист — уходило с логами pm2.
// Это телеметрия, а не учёт: хранится 30 дней, как попытки (models/Trace.js).
const mongoose = require('mongoose');

const TTL_DAYS = 30;

const VenueSessionSchema = new mongoose.Schema({
  venue: { type: mongoose.Schema.Types.ObjectId, ref: 'Establishments', required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  // owner — кнопкой; moderation — бан, удаление, снятие одобрения;
  // lapsed — страница владельца пропала больше чем на минуту;
  // absent — зритель пришёл, а владельца на странице нет; restart — сеанс
  // не закрылся (перезапуск процесса) и его сменил новый.
  endedBy: { type: String, default: '' },
  peakViewers: { type: Number, default: 0 },
  // Хронология, до 200 последних: { at, e: 'cam.demand', d: { on: true } }.
  events: [{ _id: false, at: Date, e: String, d: mongoose.Schema.Types.Mixed }],
}, { versionKey: false });

VenueSessionSchema.index({ venue: 1, startedAt: -1 });
VenueSessionSchema.index({ startedAt: 1 }, { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60 });

module.exports = mongoose.model('VenueSession', VenueSessionSchema);
