// Встречи в заведениях (07.10, docs/MEETUPS.md): дни, пределы и список
// отметок для страницы заведения. Модель — models/Meetup.js, маршруты —
// routes/meetups.js, разметка — views/partials/venueMeetups.ejs.
//
// Кто что видит. Людей в списке — только совершеннолетним по дате рождения
// (utils/age.js). Гостю и человеку без даты — обезличенный список (день,
// время, сколько человек) и подсказка, как увидеть больше; младше 18 блока
// нет. Так поисковик и случайный посетитель не получают ни имён, ни планов,
// а несовершеннолетние — способа найти взрослых для встречи. Между теми,
// кто ограничил друг друга (utils/restrict.js), отметок не видно в обе стороны.

const mongoose = require('mongoose');
const Meetup = require('../models/Meetup');
const User = require('../models/User');
const userView = require('./userView');
const { profileUrl } = require('./profileUrl');
const age = require('./age');

// Открытых отметок у человека — столько: больше похоже на рассылку, чем на планы.
const MAX_ACTIVE = 3;
// «Я тоже» под одной отметкой; дальше это уже вечеринка, а не встреча.
const MAX_MEMBERS = 30;
const NOTE_MAX = 140;
// Насколько вперёд можно отметиться.
const AHEAD_DAYS = 60;
// Аватаров участников в строке, остальные — числом.
const FACES = 5;

const FALLBACK_TZ = 'Europe/Belgrade'; // как в utils/venueHours.js
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const days = new Map();
// Сегодняшний день по календарю заведения, «2026-10-17».
function todayIn(tz, now = new Date()) {
  const zone = tz || FALLBACK_TZ;
  let f = days.get(zone);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch (e) { return todayIn(FALLBACK_TZ, now); }
    days.set(zone, f);
  }
  return f.format(now);
}

const utcOf = (day) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));

function addDays(day, n) {
  return new Date(utcOf(day) + n * 86400000).toISOString().slice(0, 10);
}

// День закончился во всех поясах (последний — UTC−12) к полудню UTC
// следующего; ещё шесть часов — на встречи, что тянутся за полночь.
const expiresFor = (day) => new Date(utcOf(day) + (36 + 6) * 3600000);

// Подходит ли день: настоящий, от сегодня по календарю заведения и не
// дальше AHEAD_DAYS.
function dayOk(day, tz, now) {
  if (!DAY.test(day) || new Date(utcOf(day)).toISOString().slice(0, 10) !== day) return false;
  const today = todayIn(tz, now);
  return day >= today && day <= addDays(today, AHEAD_DAYS);
}

// «пт, 17 окт.» — у дня нет пояса, поэтому и формат в UTC.
const labels = new Map();
function dayLabel(day, lang) {
  let f = labels.get(lang);
  if (!f) {
    f = new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'ru-RU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
    labels.set(lang, f);
  }
  return f.format(utcOf(day));
}

const person = (u) => {
  const name = userView.displayName(u);
  return { _id: String(u._id), name, url: profileUrl(u), avatarStyle: userView.avatarStyle(u, name) };
};

// Дни для списка формы (07.10: системный календарь на телефоне рисовался
// мимо оформления): от сегодня до +AHEAD_DAYS. rel — «Сегодня»/«Завтра»
// словом из словаря, остальные — датой.
function dayOptions(today, lang) {
  const out = [];
  for (let i = 0; i <= AHEAD_DAYS; i++) {
    const day = addDays(today, i);
    out.push({ day, label: dayLabel(day, lang), rel: i === 0 ? 'meet.today' : i === 1 ? 'meet.tomorrow' : '' });
  }
  return out;
}

// Время — шагом в полчаса; «любое» — пустое.
const TIMES = Array.from({ length: 48 }, (x, i) => String(Math.floor(i / 2)).padStart(2, '0') + (i % 2 ? ':30' : ':00'));

// Обезличенно: день, время и сколько человек — тому, кто людей не видит
// (07.10: «одна отметка» без подробностей ничего не говорила). Без имён,
// комментариев и лиц; забаненных нет и здесь.
async function preview(where, today, lang) {
  const list = await Meetup.find(where).select('user day time members').sort({ day: 1, time: 1, _id: 1 }).limit(100).lean();
  const banned = list.length ? new Set((await User.find({ _id: { $in: list.map((m) => m.user) }, banned: true }).select('_id').lean()).map((u) => String(u._id))) : new Set();
  return list.filter((m) => !banned.has(String(m.user))).map((m) => ({
    _id: String(m._id), dayLabel: dayLabel(m.day, lang), today: m.day === today, time: m.time, people: 1 + m.members.length,
  }));
}

// Блок отметок страницы заведения. viewer — { _id, birthDate } или null.
// → { adult, items, preview, days }: items — сами отметки, только
// совершеннолетнему; preview — без людей, остальным; days и times — списки формы.
async function forVenue(venue, viewer, lang, now = new Date()) {
  const today = todayIn(venue.tz, now);
  const days = dayOptions(today, lang);
  const adult = age.isAdult(viewer, now);
  const where = { venue: venue._id, day: { $gte: today } };
  if (!adult) return { adult, items: [], preview: await preview(where, today, lang), days, times: TIMES };

  const me = new mongoose.Types.ObjectId(String(viewer._id));
  const [list, mine] = await Promise.all([
    Meetup.find(where).sort({ day: 1, time: 1, _id: 1 }).limit(100).lean(),
    User.findById(me).select('restricted').lean(),
  ]);
  const ids = [...new Set(list.flatMap((m) => [m.user, ...m.members.map((x) => x.user)]).map(String))];
  // restricted у каждого — только совпадение со мной, а не весь список.
  const users = ids.length
    ? await User.find({ _id: { $in: ids } }).select({ nickname: 1, login: 1, email: 1, avatar: 1, banned: 1, restricted: { $elemMatch: { $eq: me } } }).lean()
    : [];
  const blocked = new Set((mine && mine.restricted || []).map(String));
  // Ограниченного модерацией не видно вовсе: бан затыкает и это.
  for (const u of users) if (u.banned || (u.restricted && u.restricted.length)) blocked.add(String(u._id));
  const byId = new Map(users.map((u) => [String(u._id), u]));

  const items = [];
  for (const m of list) {
    const author = byId.get(String(m.user));
    if (!author || blocked.has(String(m.user))) continue;
    const members = m.members.filter((x) => byId.has(String(x.user)) && !blocked.has(String(x.user)));
    const mineRow = String(m.user) === String(me);
    const joined = m.members.some((x) => String(x.user) === String(me));
    items.push({
      _id: String(m._id),
      day: m.day,
      dayLabel: dayLabel(m.day, lang),
      today: m.day === today,
      time: m.time,
      note: m.note,
      author: person(author),
      faces: members.slice(0, FACES).map((x) => person(byId.get(String(x.user)))),
      more: Math.max(0, members.length - FACES),
      going: members.length,
      mine: mineRow,
      joined,
      full: m.members.length >= MAX_MEMBERS,
    });
  }
  return { adult, items, preview: [], days, times: TIMES };
}

module.exports = { MAX_ACTIVE, MAX_MEMBERS, NOTE_MAX, AHEAD_DAYS, TIME, todayIn, addDays, expiresFor, dayOk, forVenue };
