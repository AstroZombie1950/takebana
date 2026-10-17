// Контакт: личная записная книжка. Связь односторонняя — я записал человека
// себе, он об этом не узнаёт и в своих контактах меня не получает. Так же
// устроена книжка в телефоне, и решение заказчика от 23.09 то же: в список
// попадают только те, кого добавили руками.
//
// Лента «недавние» над списком диалогов — не отсюда: она считается на лету
// (utils/recentPeers.js) и отвечает на другой вопрос — «кто под рукой
// сейчас», а не «кого я записал».
const mongoose = require('mongoose');
const { Schema } = mongoose;

const contactSchema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  peer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  addedAt: { type: Date, default: Date.now },
  // Избранные идут первыми в списке, остальные — по алфавиту.
  favorite: { type: Boolean, default: false },
  note: { type: String, default: '', maxlength: 200 },
  // Своё имя для человека (17.10), как в телефонной книжке: видно только
  // владельцу — в списках, шапке диалога, пушах и звонках (utils/contactNames.js).
  // Пусто — показывается ник.
  name: { type: String, default: '', trim: true, maxlength: 64 },
  // Откуда добавлен — для понимания, какие кнопки работают, а какие стоят зря.
  source: { type: String, enum: ['profile', 'call', 'search', 'chat', 'recent'], default: 'profile' },
});

// Один человек — одна запись: повторное «в контакты» ничего не дублирует.
contactSchema.index({ owner: 1, peer: 1 }, { unique: true });
contactSchema.index({ owner: 1, favorite: -1, addedAt: -1 });

module.exports = mongoose.model('Contact', contactSchema);
