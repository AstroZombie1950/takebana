// models/Report.js
//
// Жалоба на эфир, пользователя или сообщение чата. Отдельная коллекция, а не
// поле у объекта жалобы: на один эфир их приходит много, а разбирает их панель
// списком — по статусу и по свежести.
const mongoose = require('mongoose');

const ReportSchema = new mongoose.Schema({
  reporter: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  targetType: {
    type: String,
    enum: ['stream', 'user', 'message'],
    required: true
  },
  // Ссылка без ref: цель живёт в разных коллекциях, и populate тут всё равно
  // пришлось бы разводить по targetType вручную.
  targetId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  // Причина из закрытого списка. Свободный текст лежит рядом отдельным полем:
  // иначе жалобы нельзя ни группировать, ни считать, а модератору приходится
  // читать каждую, чтобы понять, о чём она.
  reason: {
    type: String,
    enum: ['spam', 'abuse', 'adult', 'violence', 'copyright', 'other'],
    required: true
  },
  comment: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['new', 'resolved', 'rejected'],
    default: 'new'
  },
  // Что модератор сделал по жалобе: остановил эфир, забанил, снял метку.
  // Хранится текстом — это журнал для человека, а не машинное состояние.
  action: {
    type: String,
    default: ''
  },
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  resolvedAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Панель открывается на списке новых жалоб, свежие сверху — это её главный запрос
ReportSchema.index({ status: 1, createdAt: -1 });
// Разбор одной цели: все жалобы на конкретный эфир или пользователя
ReportSchema.index({ targetType: 1, targetId: 1 });
// Один пользователь — одна жалоба на объект. Дешевле не дать задвоить в базе,
// чем потом чистить накрутку руками.
ReportSchema.index({ reporter: 1, targetType: 1, targetId: 1 }, { unique: true });

module.exports = mongoose.model('Report', ReportSchema);
