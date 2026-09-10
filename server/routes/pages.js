// Страницы, которые рендерит сам сервер: главная, вход, регистрация, кабинет,
// админка, выход. API и эфиры живут в соседних роутерах.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const User = require('../models/User');
const Establishments = require('../models/Establishments');

// Куда вести человека после входа. Значение в сессию кладёт /set-next,
// читают его /, /login, /register и userRoutes. Блок был скопирован в трёх
// местах этого файла слово в слово.
function nextUrl(req) {
  return req.session.next === 'service2' ? '/streaming' : '/main';
}

function checkLoggedIn(req, res, next) {
  if (!req.session.login) {
    res.redirect('/login');
  } else {
    next();
  }
}

router.get('/set-next', (req, res) => {
  const next = req.query.next || 'default'; // Получаем желаемый маршрут из параметров запроса
  req.session.next = next; // Сохраняем его в сессии

  // Перенаправляем на страницу входа или регистрации
  res.redirect('/login'); // Или '/register' в зависимости от вашей логики
});

router.get('/', (req, res) => {
  // Вошедшему главная не нужна — он идёт в кабинет.
  if (req.session.login) return res.redirect(nextUrl(req));

  res.render('home', {
    title: 'Takebana — платформа прямых эфиров для бизнеса',
    description: 'Takebana — платформа, где производители, заведения, блогеры и эксперты выходят в прямой эфир: продают, показывают производство и отвечают на вопросы без посредников.',
  });
});

router.get('/about', async (req, res) => {
  res.render('about', { title: 'О сервисе Takebana'});
});

router.get('/panel', async (req, res) => {
  if (req.session && req.session.userId) {
      const user = await User.findById(req.session.userId);
      if (user && (user.role === 'admin' || user.role === 'moderator')) {
          // Модератору панель открыта, но заведения ему не показываются:
          // adminRouter всё равно отобьёт его по isAdmin, и вкладка, которая
          // отвечает «Access denied» на каждое действие, хуже отсутствующей.
          res.render('admin', {
              title: 'Панель администрирования',
              isAdmin: user.role === 'admin'
          });
      } else {
          res.redirect('/main'); // Редирект на домашнюю страницу
      }
  } else {
      res.redirect('/main'); // Редирект на домашнюю страницу
  }
});

router.get('/login', (req, res) => {
  if (req.session && req.session.login) {
    res.redirect(nextUrl(req));
  } else {
    res.render('login');
  }
});

router.get('/register', (req, res) => {
  if (req.session && req.session.login) {
    res.redirect(nextUrl(req));
  } else {
    res.render('register');
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
