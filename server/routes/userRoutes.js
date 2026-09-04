// routes/userRoutes.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const User = require('../models/User');
var session = require('express-session');
var MongoDBStore = require('connect-mongodb-session')(session);




// Маршрут входа
router.post('/login', async (req, res) => {
  const { email, password, provider = '' } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }
  try {
    const user = await User.findOne({ email: email, provider: provider });
    console.log('User found:', user);
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

    console.log('nextRoute:', nextRoute);

    // Определяем URL перенаправления
    let redirectUrl = '/main'; // Значение по умолчанию
    if (nextRoute === 'service1' || nextRoute === 'default') {
      redirectUrl = '/main';
    } else if (nextRoute === 'service2') {
      redirectUrl = '/streaming';
    }

    console.log('redirectUrl:', redirectUrl);

    // Отправляем JSON-ответ с URL перенаправления
    res.status(200).json({ message: 'User logged in successfully', redirectUrl });
  } catch (error) {
    console.error('Ошибка при входе:', error);
    res.status(500).json({ message: error.message });
  }
});

// Маршрут регистрации
router.post('/register', async (req, res) => {
  const { email, password, provider = '' } = req.body;
  const login = req.body.login || '';
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters long' });
  }
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

    console.log('nextRoute:', nextRoute);

    // Определяем URL перенаправления
    let redirectUrl = '/main'; // Значение по умолчанию
    if (nextRoute === 'service1' || nextRoute === 'default') {
      redirectUrl = '/main';
    } else if (nextRoute === 'service2') {
      redirectUrl = '/streaming';
    }

    console.log('redirectUrl:', redirectUrl);

    // Отправляем JSON-ответ с URL перенаправления
    res.status(200).json({ message: 'User registered successfully', redirectUrl });
  } catch (error) {
    console.error('Ошибка при регистрации:', error);
    res.status(500).json({ message: error.message });
  }
});



router.post('/update-profile', async (req, res) => {
  const { login } = req.body;
  const userId = req.session.userId;
  if (!login || !userId) {
    return res.status(400).json({ message: 'Login and user ID are required' });
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


router.post('/update-password', async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const userId = req.session.userId;
  if (!oldPassword || !newPassword || !userId) {
    return res.status(400).json({ message: 'Old password, new password and user ID are required' });
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