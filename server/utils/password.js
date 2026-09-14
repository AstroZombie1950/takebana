// Пароль: одни правила для входа, регистрации, смены пароля и восстановления.

const bcrypt = require('bcrypt');

// provider отличает вход по паролю (пустая строка) от входа через Google.
// Раньше значение приходило из тела запроса, и аноним мог зарегистрировать
// запись с provider: 'google' на чужой адрес. Когда владелец адреса впервые
// входил через Google, app.js находил именно её и сажал человека в аккаунт,
// пароль от которого знает посторонний. Маршруты пароля провайдер не принимают.
const PASSWORD_PROVIDER = '';

// Длина сверху: bcrypt всё равно учитывает первые 72 байта, а принимать
// мегабайтную строку и считать по ней хеш — бесплатная нагрузка на процессор.
const PASSWORD_MAX = 200;
const PASSWORD_MIN = 6;

const hashPassword = (password) => bcrypt.hash(password, 10);

module.exports = { PASSWORD_PROVIDER, PASSWORD_MIN, PASSWORD_MAX, hashPassword };
