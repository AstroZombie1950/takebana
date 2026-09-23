// Журнал звонков: кто, кому, аудио или видео, чем кончилось и сколько длилось.
// Сам звонок живёт в памяти процесса (sockets/index.js), здесь — его след.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const callSchema = new Schema({
  callId: { type: String, required: true, unique: true },
  caller: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  callee: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['audio', 'video'], required: true },
  // ringing — звонит; answered — разговор был; declined — отклонён;
  // canceled — звонящий передумал до ответа; missed — не ответили за 30 секунд;
  // failed — не поднялась комната Daily.
  status: {
    type: String,
    enum: ['ringing', 'answered', 'declined', 'canceled', 'missed', 'failed'],
    default: 'ringing'
  },
  startedAt: { type: Date, default: Date.now },
  answeredAt: { type: Date, default: null },
  endedAt: { type: Date, default: null },
  // Пропущенный увиден: получатель открыл журнал. Счётчик в левой панели —
  // по неувиденным.
  seen: { type: Boolean, default: false },
  // Каким путём шёл разговор: daily — через Daily; own — через свой сервер
  // (utils/turn.js): сразу, если кто-то из двоих уже на нём, или переходом
  // посреди звонка. fallback — почему перешли, со слов браузера.
  path: { type: String, enum: ['daily', 'own'], default: 'daily' },
  fallback: { type: String, default: null },
  // Групповой разговор (до четырёх, решение 23.09): к паре caller/callee
  // добавляются приглашённые. Старые поля остаются как были — по ним
  // считается журнал и расходы, — а participants заполняется только здесь.
  group: { type: Boolean, default: false },
  participants: [{
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    joinedAt: { type: Date, default: Date.now },
    leftAt: { type: Date, default: null },
  }],
  // Кто убрал звонок из своего журнала и ленты переписки. Только «у себя»:
  // запись общая на двоих, и по ней же панель считает разговоры и расходы
  // на Daily — поэтому сам документ не стирается никогда.
  deletedFor: [{ type: Schema.Types.ObjectId, ref: 'User' }]
});

callSchema.index({ caller: 1, startedAt: -1 });
callSchema.index({ callee: 1, startedAt: -1 });
callSchema.index({ callee: 1, seen: 1, status: 1 });

module.exports = mongoose.model('Call', callSchema);
