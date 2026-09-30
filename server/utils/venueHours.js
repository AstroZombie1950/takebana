// Открыто ли заведение сейчас — для карточек выдачи /venues, страницы
// заведения и фильтра «Открыто сейчас».
//
// Часы владелец пишет местные — как висят на двери, без пометок о поясе.
// Поэтому «сейчас» берётся по часам заведения: его пояс определяется по
// точке на карте и лежит в нём (tz, 30.09). Посетитель из другой страны
// видит те же «с 10:00 до 23:00», а «открыто» — верное для этой минуты.
// Ни пояс сервера, ни пояс посетителя тут ни при чём. До 30.09 пояс был
// один на всех — белградский: заведения были только в Сербии.
//
// Часы лежат строками «ЧЧ:ММ», по будням и по выходным. Закрытие раньше
// открытия — работа за полночь: «18:00–02:00» в час ночи ещё открыто
// (по часам того же дня недели — для карточки этого хватает).

const tzAt = require('@photostructure/tz-lookup');
const errorLog = require('./errorLog');

// Без точки — белградское: так считались все заведения до 30.09.
const FALLBACK = 'Europe/Belgrade';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

// Часы-форматтер на пояс: создавать его на каждую карточку дорого.
const clocks = new Map();
function clock(tz) {
  let c = clocks.get(tz);
  if (!c) {
    c = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    clocks.set(tz, c);
  }
  return c;
}

// Пояс по точке; нет точки или она кривая — пусто.
function zoneAt(location) {
  const { lat, lng } = location || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  try { return tzAt(lat, lng); } catch (e) { return ''; }
}

// → { open, from, to } или null, если часы не заданы.
function hoursState(venue, now = new Date()) {
  let parts;
  try { parts = clock(venue.tz || FALLBACK).formatToParts(now); } catch (e) { parts = clock(FALLBACK).formatToParts(now); }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const hours = p.weekday === 'Sat' || p.weekday === 'Sun' ? venue.weekendHours : venue.weekdayHours;
  if (!hours || !HHMM.test(hours.open) || !HHMM.test(hours.close)) return null;
  const at = Number(p.hour) * 60 + Number(p.minute);
  const from = minutes(hours.open);
  let to = minutes(hours.close);
  if (to <= from) to += 1440;
  const open = (at >= from && at < to) || (at + 1440 >= from && at + 1440 < to);
  return { open, from: hours.open, to: hours.close };
}

// Заведения до 30.09 пояса не имеют — досчитываем при запуске по их точкам.
function backfill() {
  const Establishments = require('../models/Establishments');
  Establishments.find({ tz: { $exists: false }, 'location.lat': { $type: 'number' } }).select('location').lean()
    .then((venues) => Promise.all(venues.map((v) => {
      const tz = zoneAt(v.location);
      return tz ? Establishments.updateOne({ _id: v._id }, { $set: { tz } }) : null;
    })))
    .catch((e) => errorLog.server(e, 'venueHours.backfill'));
}

module.exports = { hoursState, zoneAt, backfill };
