// Страницы, которые рендерит сам сервер: главная, вход, регистрация, кабинет,
// админка, выход. API и эфиры живут в соседних роутерах.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const User = require('../models/User');
const Establishments = require('../models/Establishments');

function checkLoggedIn(req, res, next) {
  if (!req.session.login) {
    res.redirect('/login');
  } else {
    next();
  }
}

// Куда вернуть человека после входа. Значение кладётся в сессию, читают его
// маршруты / , /login и /register ниже.
router.get('/set-next', (req, res) => {
  const next = req.query.next || 'default'; // Получаем желаемый маршрут из параметров запроса
  req.session.next = next; // Сохраняем его в сессии

  // Перенаправляем на страницу входа или регистрации
  res.redirect('/login'); // Или '/register' в зависимости от вашей логики
});


// Функция для генерации случайного градиента из массива градиентов


// Определение маршрута
router.get('/', (req, res) => {
  let userLoggedIn = !!req.session.login;
  if (userLoggedIn) {
      let nextRoute = req.session.next || 'default';
      let redirectUrl = '/main'; // Значение по умолчанию
      if (nextRoute === 'service1' || nextRoute === 'default') {
          redirectUrl = '/main';
      } else if (nextRoute === 'service2') {
          redirectUrl = '/streaming';
      }
      res.redirect(redirectUrl);
  } 
  else {
      res.render('index', { title: 'Главная страница', userLoggedIn: userLoggedIn });
  }
});

router.get('/about', async (req, res) => {
  res.render('about', { title: 'О сервисе Takebana'});
});

router.get('/panel', async (req, res) => {
  if (req.session && req.session.userId) {
      const user = await User.findById(req.session.userId);
      if (user && (user.role === 'admin' || user.role === 'moderator')) {
          res.render('admin', { title: 'Панель администрирования'});
      } else {
          res.redirect('/main'); // Редирект на домашнюю страницу
      }
  } else {
      res.redirect('/main'); // Редирект на домашнюю страницу
  }
});

router.get('/login', (req, res) => {
  if (req.session && req.session.login) {
    let nextRoute = req.session.next || 'default';
      let redirectUrl = '/main'; // Значение по умолчанию
      if (nextRoute === 'service1' || nextRoute === 'default') {
          redirectUrl = '/main';
      } else if (nextRoute === 'service2') {
          redirectUrl = '/streaming';
      }
      res.redirect(redirectUrl);
  } else {
    res.render('login', { title: 'Главная страница', userLoggedIn: !!req.session.login });
  }
});

router.get('/register', (req, res) => {
  if (req.session && req.session.login) {
    let nextRoute = req.session.next || 'default';
      let redirectUrl = '/main'; // Значение по умолчанию
      if (nextRoute === 'service1' || nextRoute === 'default') {
          redirectUrl = '/main';
      } else if (nextRoute === 'service2') {
          redirectUrl = '/streaming';
      }
      res.redirect(redirectUrl);
  } else {
    res.render('register', { title: 'Главная страница', userLoggedIn: !!req.session.login });
  }
});

router.get('/company-register', (req, res) => {
  let userLoggedIn = !!req.session.login;
  res.render('newCompany.ejs', { title: 'Главная страница', userLoggedIn: userLoggedIn });
});


router.get('/main', checkLoggedIn, async (req, res) => {
  const userId = req.session.userId;
  // Найти пользователя по ID
  const user = await User.findById(userId);
  if (!user) {
    return res.status(400).json({ message: 'User not found' });
  }
  const userLogin = user ? user.login : '';
  // Найти все заведения, принадлежащие пользователю
  const establishments = await Establishments.find({ owner: userId });
  // Проверить, есть ли у пользователя зарегистрированные заведения
  const hasEstablishments = establishments.length > 0;
  res.render('map', { title: 'map', userLogin: userLogin, hasEstablishments: hasEstablishments, userId: userId });
});


router.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.redirect('/');
    }
    res.clearCookie('connect.sid'); // имя по умолчанию у express-session, было 'sid'
    res.redirect('/');
  });
});

module.exports = router;
