// routes/userRoutes.js
const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
const { authLimiter, registerLimiter } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const bcrypt = require('bcrypt');
const User = require('../models/User');
const { PASSWORD_PROVIDER, PASSWORD_MIN, PASSWORD_MAX, hashPassword } = require('../utils/password');

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
      return res.status(400).json({ message: 'Неверная почта или пароль' });
    }
    
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ message: 'Неверная почта или пароль' });
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
    res.status(200).json({ message: 'Вход выполнен', redirectUrl });
  } catch (error) {
    console.error('Ошибка при входе:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
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
      return res.status(400).json({ message: 'Пользователь с такой почтой уже есть' });
    }

    const hashedPassword = await hashPassword(password);
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
    res.status(200).json({ message: 'Регистрация прошла успешно', redirectUrl });
  } catch (error) {
    console.error('Ошибка при регистрации:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
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
      return res.status(400).json({ message: 'Пользователь не найден' });
    }
    // Обновить логин пользователя
    user.login = login;
    // Сохранить обновленного пользователя
    await user.save();

    res.status(200).json({ message: 'Профиль успешно обновлен' });
  } catch (error) {
    console.error('Ошибка при обновлении профиля:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
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
      return res.status(400).json({ message: 'Пользователь не найден' });
    }
    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match) {
      return res.status(400).json({ message: 'Неверный старый пароль' });
    }
    user.password = await hashPassword(newPassword);
    await user.save();

    res.status(200).json({ message: 'Пароль успешно обновлен' });
  } catch (error) {
    console.error('Ошибка при обновлении профиля:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;