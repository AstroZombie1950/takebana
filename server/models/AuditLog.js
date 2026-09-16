// Журнал действий: кто, что, над чем и чем кончилось.
//
// Отдельная коллекция, а не строки в pm2: по логу в файле нельзя ни найти
// все действия одного человека, ни показать их в панели постранично.
// Пишется через utils/audit.js — оттуда же список кодов действий.
//
// Имя и роль актора хранятся снимком рядом со ссылкой: аккаунт могут
// переименовать или удалить, а запись «кто это сделал» должна остаться
// читаемой и через год. То же с названием цели.
const mongoose = require('mongoose');

// Сколько держим журнал. Меняется переменной окружения, но учтите: Mongo
// не пересоздаёт TTL-индекс с новым сроком сам — после смены значения
// индекс нужно удалить руками, иначе останется прежний срок.
const TTL_DAYS = Number(process.env.AUDIT_TTL_DAYS) || 180;

const AuditLogSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  actorLogin: { type: String, default: '' },
  actorRole: { type: String, default: '' },
  // Код из ACTIONS в utils/audit.js. Строкой, а не enum: новое действие
  // не должно требовать миграции схемы, а список всё равно один на проект.
  action: { type: String, required: true },
  targetType: { type: String, default: '' },
  targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
  targetLabel: { type: String, default: '' },
  // ok — получилось, fail — не получилось (неверный пароль, занятая почта),
  // denied — не хватило прав или сработал лимит.
  result: { type: String, enum: ['ok', 'fail', 'denied'], default: 'ok' },
  ip: { type: String, default: '' },
  ua: { type: String, default: '' },
  // Подробности действия. Держим маленькими: журнал читают списком, а не
  // разбирают по одной записи.
  meta: { type: mongoose.Schema.Types.Mixed, default: null },
}, { versionKey: false });

// Лента журнала — свежие сверху, это его главный запрос
AuditLogSchema.index({ at: -1 });
// Досье пользователя: его действия
AuditLogSchema.index({ actor: 1, at: -1 });
// Фильтр по виду действия
AuditLogSchema.index({ action: 1, at: -1 });
// Всё, что делали с одним объектом: история правок заведения, разбор жалобы
AuditLogSchema.index({ targetType: 1, targetId: 1, at: -1 });
// Подбор пароля и накрутка регистраций видны по адресу
AuditLogSchema.index({ ip: 1, at: -1 });
// Уборка по сроку
AuditLogSchema.index({ at: 1 }, { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60 });

module.exports = mongoose.model('AuditLog', AuditLogSchema);
