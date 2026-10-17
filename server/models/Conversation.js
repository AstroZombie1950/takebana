const mongoose = require('mongoose');
const { Schema } = mongoose;

const conversationSchema = new Schema({
  userOne: {
    type: Schema.Types.ObjectId,
    ref: 'User', // Ссылка на первого пользователя
    required: true
  },
  userTwo: {
    type: Schema.Types.ObjectId,
    ref: 'User', // Ссылка на второго пользователя
    required: true
  },
  lastMessage: {
    type: Schema.Types.ObjectId,
    ref: 'Message' // Ссылка на последнее сообщение в диалоге
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  // Кто удалил переписку у себя: диалог пропадает из его списка и
  // возвращается с первым новым сообщением.
  hiddenFor: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  // Заявка на переписку (utils/privacy.js): незнакомый написал тому, кто
  // принимает новых собеседников через заявки. Здесь — получатель: у него
  // диалог лежит в «Заявках», без пуша и звука, и не в счётчике. Снимается,
  // когда он ответил или принял.
  requestFor: { type: Schema.Types.ObjectId, ref: 'User', default: undefined },
  // Пара «меньший id:больший id» — для уникального индекса: два
  // одновременных «написать» (двойное нажатие, оба пишут друг другу)
  // заводили два диалога, и история расползалась. Есть только у диалогов
  // с 24.09.2026; старые находятся по userOne/userTwo, как и раньше.
  pair: { type: String },
  // Без звука (17.10): у каждого свой срок — пуши не приходят, вкладка
  // не пищит, счётчик идёт. until в прошлом — снова со звуком.
  muted: {
    type: [{ _id: false, user: { type: Schema.Types.ObjectId, ref: 'User' }, until: Date }],
    default: undefined
  },
  // Закреплённое сообщение (17.10) — одно на диалог, общее у двоих: шапка
  // ленты показывает его полосой (utils/chatInfo.js).
  pinned: { type: Schema.Types.ObjectId, ref: 'Message', default: null }
}, {
  timestamps: true // Автоматически добавляет поля createdAt и updatedAt
});

// Диалог ищется в обе стороны через $or, поэтому нужны оба порядка
conversationSchema.index({ userOne: 1, userTwo: 1 });
conversationSchema.index({ userTwo: 1, userOne: 1 });
// Список переписок человека страницами, от свежих (routes/streaming/messages.js).
conversationSchema.index({ userOne: 1, lastUpdated: -1 });
conversationSchema.index({ userTwo: 1, lastUpdated: -1 });
conversationSchema.index({ pair: 1 }, { unique: true, partialFilterExpression: { pair: { $exists: true } } });
// Папка «Заявки»: частичный — заявок единицы на фоне всех диалогов.
conversationSchema.index({ requestFor: 1, lastUpdated: -1 }, { partialFilterExpression: { requestFor: { $exists: true } } });

module.exports = mongoose.model('Conversation', conversationSchema);
