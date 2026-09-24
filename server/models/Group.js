// Групповой чат (решение 24.09.2026). Метаданные — здесь, сообщения — в общей
// коллекции Message: у них conversationId — id группы, получателя нет.
// Личная переписка (models/Conversation.js) группы не видит вовсе: её
// запросы ищут пару userOne/userTwo.
//
// Роли: owner — один, может всё, в том числе удалить группу и назначать
// администраторов; admin — добавляет и удаляет участников, меняет название,
// фото и ссылку, удаляет чужие сообщения; member — пишет и выходит.
// Правила — utils/groups.js.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const memberSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['owner', 'admin', 'member'], default: 'member' },
  addedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  joinedAt: { type: Date, default: Date.now },
  // До какого времени прочитано: непрочитанное — сообщения позже этой
  // отметки, «прочитано» у автора — когда её перешёл кто-то из остальных.
  readAt: { type: Date, default: Date.now },
  // Без звука до этого времени: пуши не приходят, счётчик — идёт.
  mutedUntil: { type: Date, default: null },
}, { _id: false });

const groupSchema = new Schema({
  title: { type: String, required: true, trim: true },
  // Фото — на своём сервере, как аватары людей (utils/image.js).
  avatar: { type: String, default: '' },
  members: { type: [memberSchema], default: [] },
  // Код ссылки-приглашения /g/<код>; null — ссылка выключена. Вступление
  // по ней — сразу, без одобрения (решение 24.09).
  invite: { type: String, default: null },
  lastMessage: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
  lastUpdated: { type: Date, default: Date.now },
}, { timestamps: true });

// Группы человека страницами от свежих — рядом с личными диалогами.
groupSchema.index({ 'members.user': 1, lastUpdated: -1 });
groupSchema.index({ invite: 1 }, { unique: true, partialFilterExpression: { invite: { $type: 'string' } } });

module.exports = mongoose.model('Group', groupSchema);
