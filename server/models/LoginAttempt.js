// Неудачные попытки ввести пароль (utils/loginGuard.js). Ключ — одно из трёх:
//   p:<почта>|<адрес>  — пара: по ней ставится пауза после пяти ошибок подряд;
//   a:<почта>          — аккаунт со всех адресов: подбор с сотни адресов;
//   i:<адрес>          — адрес по всем почтам: перебор чужих аккаунтов.
// Строка живёт сутки после последней ошибки и исчезает сама.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const attemptSchema = new Schema({
  key: { type: String, required: true, unique: true },
  fails: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  updatedAt: { type: Date, default: Date.now, expires: 24 * 3600 },
});

module.exports = mongoose.model('LoginAttempt', attemptSchema);
