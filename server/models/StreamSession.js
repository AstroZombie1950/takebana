// След эфира: один отрезок «в эфире», от выхода до ухода.
//
// Заводится потому, что сам эфир следа не оставляет: /terminate-stream
// удаляет документ Stream целиком, брошенные удаляет уборщик
// (jobs/streamCleanup.js). После эфира в базе остаётся только запись — и то
// если ведущий нажал «Сохранить запись». Посчитать по этому «сколько человек
// отвещал» нельзя ни задним числом, ни вперёд.
//
// Отрезок, а не эфир: пауза закрывает сессию, следующий выход открывает новую.
// Иначе час эфира с получасовым перерывом считался бы полутора часами.
// Сумма duration по пользователю и есть его время в эфире.
const mongoose = require('mongoose');

const StreamSessionSchema = new mongoose.Schema({
  // Исходный эфир: документа уже нет, но по нему находится чат (ChatMessage)
  // и сходятся жалобы, написанные, пока эфир шёл.
  stream: { type: mongoose.Schema.Types.ObjectId, default: null },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  streamKey: { type: String, default: '' },

  // Карточка на момент выхода в эфир: название потом не восстановить.
  title: { type: String, default: '' },
  category: { type: String, default: '' },
  subcategory: { type: String, default: '' },
  city: { type: String, default: '' },
  isAdult: { type: Boolean, default: false },
  source: { type: String, enum: ['web', 'obs'], default: 'web' },

  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  // Последний удар сэмплера. Нужен на случай, когда процесс перезапустили
  // с открытой сессией: чем закрывать её началом эфира, честнее закрыть
  // последним мигом, когда эфир заведомо шёл.
  heartbeatAt: { type: Date, default: null },
  duration: { type: Number, default: 0 }, // секунды, считается при закрытии

  // Зрители: счёт живёт в памяти сокетов, поэтому сюда его складывает
  // сэмплер (sockets/index.js) раз в полминуты. viewerSeconds — зрителе-
  // секунды, из них получается средний зритель: viewerSeconds / duration.
  peakViewers: { type: Number, default: 0 },
  viewerSeconds: { type: Number, default: 0 },
  chatMessages: { type: Number, default: 0 },

  // owner — ведущий завершил или поставил паузу, moderation — погасили,
  // cleanup — эфир бросили и его убрал сборщик, restart — процесс
  // перезапустился с открытой сессией.
  endedBy: { type: String, enum: ['owner', 'moderation', 'cleanup', 'restart', ''], default: '' },
  stopReason: { type: String, default: '' },
  stoppedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Запись, если её сохранили. Размер — тот же, что у Recording: по нему
  // считается место в хранилище на вкладке расходов.
  recording: { type: mongoose.Schema.Types.ObjectId, ref: 'Recording', default: null },
  recordingSize: { type: Number, default: 0 },
}, { versionKey: false });

// Эфиры пользователя в досье и подсчёт его часов
StreamSessionSchema.index({ user: 1, startedAt: -1 });
// Общий журнал эфиров в панели
StreamSessionSchema.index({ startedAt: -1 });
// Ссылка на закончившийся эфир: куда её увести (routes/streaming/streamPages.js)
StreamSessionSchema.index({ stream: 1 }, { partialFilterExpression: { stream: { $type: 'objectId' } } });
// Открытая сессия по ключу: её ищут закрытие и сэмплер, строк единицы
StreamSessionSchema.index({ streamKey: 1, endedAt: 1 }, { partialFilterExpression: { endedAt: null } });

module.exports = mongoose.model('StreamSession', StreamSessionSchema);
