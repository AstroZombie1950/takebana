// routes/userRoutes.js
const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
const { authLimiter, registerLimiter } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const bcrypt = require('bcrypt');
const User = require('../models/User');
var session = require('express-session');
var MongoDBStore = require('connect-mongodb-session')(session);




// provider отличает вход по паролю (пустая строка) от входа через Google.
// Раньше значение приходило из тела запроса, и аноним мог зарегистрировать
// запись с provider: 'google' на чужой адрес. Когда владелец адреса впервые
// входил через Google, app.js находил именно её и сажал человека в аккаунт,
// пароль от которого знает посторонний. Здесь и в регистрации провайдер
// зафиксирован: эти два маршрута обслуживают только вход по паролю.
const PASSWORD_PROVIDER = '';

// Длина пароля сверху: bcrypt всё равно учитывает первые 72 байта, а принимать
// мегабайтную строку и считать по ней хеш — бесплатная нагрузка на процессор.
const PASSWORD_MAX = 200;
const PASSWORD_MIN = 6;

// Маршрут входа
router.post('/login', authLimiter, validate({
  email: { type: 'email', required: true, label: 'Почта' },
  // На входе длину не проверяем: пароли старых учёток могут быть короче
  // нынешнего минимума, и человек должен суметь войти и сменить его.
  password: { type: 'string', required: true, max: PASSWORD_MAX, trim: false, label: 'Пароль' },
}), async (req, res) => {
  const { email, password } = req.body;
  const provider = PASSWORD_PROVIDER;
  try {
    const user = await User.findOne({ email: email, provider: provider });
    if (!user) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }
    
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    req.session.userId = user._id.toString();
    req.session.login = user.login || 'anon';

    // Получаем значение `next` из сессии
    let nextRoute = req.session.next || 'default';
    // req.session.next = null; // Очищаем `next` из сессии

    // Определяем URL перенаправления
    let redirectUrl = '/main'; // Значение по умолчанию
    if (nextRoute === 'service1' || nextRoute === 'default') {
      redirectUrl = '/main';
    } else if (nextRoute === 'service2') {
      redirectUrl = '/streaming';
    }

    // Отправляем JSON-ответ с URL перенаправления
    res.status(200).json({ message: 'User logged in successfully', redirectUrl });
  } catch (error) {
    console.error('Ошибка при входе:', error);
    res.status(500).json({ message: error.message });
  }
});

// Маршрут регистрации
router.post('/register', registerLimiter, validate({
  email: { type: 'email', required: true, label: 'Почта' },
  password: { type: 'string', required: true, min: PASSWORD_MIN, max: PASSWORD_MAX, trim: false, label: 'Пароль' },
  login: { type: 'string', max: 64, default: '', label: 'Логин' },
}), async (req, res) => {
  const { email, password, login } = req.body;
  const provider = PASSWORD_PROVIDER; // см. комментарий выше
  try {
    const existingUser = await User.findOne({ email: email, provider: provider });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email or login already exists' });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const user = new User({ email: email, login: login, password: hashedPassword, provider: provider });
    await user.save();

    req.session.userId = user._id.toString();
    req.session.login = user.login || 'anon';

    // Получаем значение `next` из сессии
    let nextRoute = req.session.next || 'default';
    // req.session.next = null; // Очищаем `next` из сессии

    // Определяем URL перенаправления
    let redirectUrl = '/main'; // Значение по умолчанию
    if (nextRoute === 'service1' || nextRoute === 'default') {
      redirectUrl = '/main';
    } else if (nextRoute === 'service2') {
      redirectUrl = '/streaming';
    }

    // Отправляем JSON-ответ с URL перенаправления
    res.status(200).json({ message: 'User registered successfully', redirectUrl });
  } catch (error) {
    console.error('Ошибка при регистрации:', error);
    res.status(500).json({ message: error.message });
  }
});



router.post('/update-profile', validate({
  login: { type: 'string', required: true, min: 1, max: 64, label: 'Логин' },
}), async (req, res) => {
  const { login } = req.body;
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: 'Пользователь не авторизован' });
  }
  try {
    // Найти пользователя по ID
    const user = await User.findById(userId);
    if (!user) {
      return res.status(400).json({ message: 'User not found' });
    }
    // Обновить логин пользователя
    user.login = login;
    // Сохранить обновленного пользователя
    await user.save();

    res.status(200).json({ message: 'Profile updated successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


// Минимум тот же, что в регистрации: иначе через смену пароля он обходится.
router.post('/update-password', authLimiter, validate({
  oldPassword: { type: 'string', required: true, max: PASSWORD_MAX, trim: false, label: 'Старый пароль' },
  newPassword: { type: 'string', required: true, min: PASSWORD_MIN, max: PASSWORD_MAX, trim: false, label: 'Новый пароль' },
}), async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: 'Пользователь не авторизован' });
  }
  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(400).json({ message: 'User not found' });
    }
    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match) {
      return res.status(400).json({ message: 'Invalid old password' });
    }
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.status(200).json({ message: 'Password updated successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;