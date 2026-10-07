// Возраст по дате рождения (User.birthDate, 07.10). Дата — календарная,
// без времени: хранится полночью UTC того дня, и считать возраст надо по
// UTC-полям, иначе пояс сервера сдвигал бы день рождения на сутки.

const ADULT = 18;
// Старше этого — опечатка в годе, а не человек.
const OLDEST = 120;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

// «1990-05-17» из поля даты → Date полночью UTC; кривая, несуществующая
// (31 февраля), будущая или старше OLDEST лет — null.
function parse(value, now = new Date()) {
  const m = DAY.exec(String(value || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  if (d > now) return null;
  if (ageOf(d, now) > OLDEST) return null;
  return d;
}

// Полных лет на сегодня.
function ageOf(birthDate, now = new Date()) {
  const b = new Date(birthDate);
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

// Совершеннолетие — только по дате рождения: самодекларация 18+
// (adultConfirmedAt) встречам не годится.
const isAdult = (user, now) => !!(user && user.birthDate) && ageOf(user.birthDate, now) >= ADULT;

// Для поля и подписи в настройках: «1990-05-17».
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

module.exports = { ADULT, parse, ageOf, isAdult, iso };
