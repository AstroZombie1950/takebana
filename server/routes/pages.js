// Страницы, которые рендерит сам сервер: «О нас», вход, регистрация, карта,
// админка, выход. Главная — витрина эфиров (routes/streaming/catalog.js),
// API и эфиры живут в соседних роутерах.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const User = require('../models/User');
const Establishments = require('../models/Establishments');
const catalog = require('../config/catalog');
const { commonDataMiddleware } = require('./streaming/shared');
const { requireAuth } = require('../middleware/auth');
const { readVenueFilters } = require('../utils/venueFilters');
const { audit, ACTIONS } = require('../utils/audit');
const userView = require('../utils/userView');

// «О нас» — бывший лендинг главной. Вошедшему шапка и панель — свои,
// поэтому commonDataMiddleware.
router.get('/about', commonDataMiddleware, (req, res) => {
  res.render('about');
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
              isAdmin: user.role === 'admin',
              // Панель подписывает действия человеческими названиями и из них
              // же строит фильтр журнала — список один, в utils/audit.js.
              actions: ACTIONS,
              me: { id: String(user._id), displayName: userView.displayName(user) },
              catalog,
          });
      } else {
          res.redirect('/');
      }
  } else {
      res.redirect('/');
  }
});

router.get('/login', (req, res) => {
  if (req.session && req.session.login) {
    res.redirect('/');
  } else {
    res.render('login');
  }
});

router.get('/register', (req, res) => {
  if (req.session && req.session.login) {
    res.redirect('/');
  } else {
    res.render('register');
  }
});

// Заявка на заведение — страница кабинета: без входа её всё равно не отправить.
router.get('/company-register', requireAuth, commonDataMiddleware, (req, res) => {
  res.render('newCompany', { catalog });
});


// Карта заведений — в каркасе кабинета, поэтому commonDataMiddleware:
// шапке и левой панели нужны профиль, подписки и уведомления. Гость карту
// смотрит, камеру и оценку — после входа (tk-venues.js).
router.get('/main', commonDataMiddleware, async (req, res) => {
  res.render('map', {
    catalog,
    filters: readVenueFilters(req.query),
    hasEstablishments: !!req.session.userId && !!(await Establishments.exists({ owner: req.session.userId })),
  });
});


router.get('/logout', (req, res) => {
  // До destroy: после него в сессии уже некого записывать.
  audit(req, 'auth.logout');
  // Подписка на пуши принадлежит устройству, а не человеку: оставить её —
  // значит слать уведомления вышедшего тому, кто войдёт на этом телефоне
  // следующим. Адрес запомнили при подписке (routes/push.js).
  if (req.session.pushEndpoint) require('../utils/push').unsubscribe(req.session.pushEndpoint).catch(() => {});
  req.session.destroy(err => {
    if (err) {
      return res.redirect('/');
    }
    res.clearCookie('connect.sid'); // имя по умолчанию у express-session, было 'sid'
    res.redirect('/');
  });
});

module.exports = router;
