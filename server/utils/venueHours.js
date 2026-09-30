// Открыто ли заведение сейчас — для карточек выдачи /venues и фильтра
// «Открыто сейчас». Заведения все в Сербии, поэтому время — белградское:
// ни пояс сервера, ни пояс посетителя тут ни при чём.
//
// Часы лежат строками «ЧЧ:ММ», по будням и по выходным. Закрытие раньше
// открытия — работа за полночь: «18:00–02:00» в час ночи ещё открыто
// (по часам того же дня недели — для карточки этого хватает).

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Belgrade', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const minutes = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

// → { open, from, to } или null, если часы не заданы.
function hoursState(venue, now = new Date()) {
  const p = Object.fromEntries(clock.formatToParts(now).map((x) => [x.type, x.value]));
  const hours = p.weekday === 'Sat' || p.weekday === 'Sun' ? venue.weekendHours : venue.weekdayHours;
  if (!hours || !HHMM.test(hours.open) || !HHMM.test(hours.close)) return null;
  const at = Number(p.hour) * 60 + Number(p.minute);
  const from = minutes(hours.open);
  let to = minutes(hours.close);
  if (to <= from) to += 1440;
  const open = (at >= from && at < to) || (at + 1440 >= from && at + 1440 < to);
  return { open, from: hours.open, to: hours.close };
}

module.exports = { hoursState };
