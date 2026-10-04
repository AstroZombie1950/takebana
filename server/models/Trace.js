// Телеметрия: одна попытка человека от начала до исхода — посмотреть эфир,
// выйти в эфир, позвонить, загрузить файл (docs/TELEMETRY.md).
//
// Журнал ошибок (ErrorLog) склеивает одинаковые ошибки в одну карточку, и
// «у кого именно и на каком шаге» из него не достать. А жалобы приходят
// именно такие: у одного кружок, у другого чёрный экран, третий без VPN
// не может. Тесты эфиров 30.09 и 01.10 не оставили в журнале ошибок ни
// одной записи о кружке — плеер о нём не сообщал.
//
// Запись заводит браузер (routes/telemetry.js) и досылает её по ходу:
// длинная попытка (эфир) присылает итог раз в минуту, потому что iPhone
// часто закрывает страницу молча. Хранится 30 дней.
const mongoose = require('mongoose');

const TTL_DAYS = 30;

// Направления — docs/TELEMETRY.md, «Что меряем». Новое направление
// добавляется сюда и в routes/telemetry.js.
// notice — сбои связи и запросов на странице (public/tk-net.js, docs/NOTICES.md).
const KINDS = ['live.view', 'live.host', 'venue.view', 'venue.host', 'call', 'upload', 'chat.media', 'notice'];

const TraceSchema = new mongoose.Schema({
  // Создаёт браузер, им же досылает продолжения.
  tid: { type: String, required: true, unique: true },
  kind: { type: String, enum: KINDS, required: true },
  // К чему относится: ключ эфира, id звонка, записи, сообщения.
  target: { type: String, default: '' },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  ip: { type: String, default: '' },
  ua: { type: String, default: '' },
  // Сеть по IP (utils/netInfo.js) и часовой пояс браузера.
  net: {
    country: { type: String, default: '' },
    asn: { type: Number, default: 0 },
    org: { type: String, default: '' },
    vpn: { type: Boolean, default: false },
    tz: { type: String, default: '' },
    // navigator.connection: тип и оценка скорости — есть только в Chrome.
    type: { type: String, default: '' },
    down: { type: Number, default: 0 },
  },
  // С иконки «Домой» или во вкладке браузера.
  standalone: { type: Boolean, default: false },
  // Как шло: cdn | fallback (Bunny заблокирован) | daily | own.
  route: { type: String, default: '' },
  // Этапы — миллисекунды от начала попытки: [{ s: 'manifest', ms: 840 }].
  steps: [{ _id: false, s: String, ms: Number }],
  // ok | fail | gave_up (ушёл, не дождавшись) | partial (началось и сломалось) | open (ещё идёт).
  outcome: { type: String, default: 'open' },
  reason: { type: String, default: '' },
  // Числа своего направления: подвисания, отдача ведущего, скорость загрузки.
  stats: { type: mongoose.Schema.Types.Mixed, default: null },
  // Что было дальше на сервере (03.10): у загрузки видео — ожидание
  // в очереди, пережатие, выгрузка в хранилище и исход. Отдельно от stats:
  // их браузер переписывает каждой досылкой (utils/uploadTrace.js).
  server: { type: mongoose.Schema.Types.Mixed, default: null },
  startedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false });

TraceSchema.index({ startedAt: -1 });
TraceSchema.index({ kind: 1, startedAt: -1 });
TraceSchema.index({ user: 1, startedAt: -1 });
// Зрители эфира в его карточке в панели.
TraceSchema.index({ target: 1, startedAt: -1 });
TraceSchema.index({ startedAt: 1 }, { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60 });

module.exports = mongoose.model('Trace', TraceSchema);
module.exports.KINDS = KINDS;
