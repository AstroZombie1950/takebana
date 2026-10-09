// Встреча в заведении (07.10, docs/MEETUPS.md) — отметка «хочу сюда в такой
// день». Этап А: человек отмечается на странице заведения, другие видят,
// жмут «Я тоже» и списываются сами. Только с 18 лет — по дате рождения
// (utils/age.js). Правила — utils/meetups.js, маршруты — routes/meetups.js.
//
// Задел на следующие этапы заложен в схему сразу, чтобы потом не
// переписывать данные: страна и город — для поиска «кто в городе в эти
// дни» без заведения; members — для приёма откликов автором (появится
// поле state) и общего чата (group).
const mongoose = require('mongoose');
const { Schema } = mongoose;

const memberSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  at: { type: Date, default: Date.now },
}, { _id: false });

const meetupSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  venue: { type: Schema.Types.ObjectId, ref: 'Establishments', required: true },
  // Код страны (utils/places.js) — копия с заведения на момент отметки.
  // Город писался до 09.10, у заведений его больше нет.
  country: { type: String, default: '' },
  // День по местному календарю заведения, «2026-10-17»: строкой, а не Date —
  // у дня нет пояса, и сравнение строк даёт тот же порядок.
  day: { type: String, required: true },
  // Время, если человек его указал, «21:30».
  time: { type: String, default: '' },
  note: { type: String, default: '' },
  members: { type: [memberSchema], default: [] },
  // Отметка сама уходит из базы, когда её день прошёл везде на Земле
  // (utils/meetups.js, expiresFor) — уборки не нужно.
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

// Страница заведения: его отметки от сегодняшнего дня.
meetupSchema.index({ venue: 1, day: 1 });
// Один человек — одна отметка на заведение в день; сколько у него открытых.
meetupSchema.index({ user: 1, venue: 1, day: 1 }, { unique: true });
meetupSchema.index({ 'members.user': 1 });
meetupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Meetup', meetupSchema);
