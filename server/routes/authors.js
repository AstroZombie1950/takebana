// Страница авторов (/authors): кто сейчас в эфире, кого смотрят, кто появился
// недавно и у кого есть записи; /authors/all — все списком с фильтрами. Кого показывать и в каком порядке — решает
// utils/authors.js; сюда же ходит витрина за тройкой авторов в колонку.
//
// Открыта гостю: это витрина людей, а не кабинет.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { commonDataMiddleware } = require('./streaming/shared');
const authors = require('../utils/authors');
const { notFound } = require('../middleware/errors');

router.get('/authors', commonDataMiddleware, async (req, res) => {
  res.render('authors', { groups: await authors.groups({ viewer: req.session.userId }) });
});

// Все авторы (04.10): фильтр и порядок из адреса — GET-форма работает и без
// скрипта, ссылкой можно поделиться. Чужие значения молча отбрасываются,
// как в каталоге. Листалка — как у галереи: ?page=1 → 301, за краем — 404.
router.get('/authors/all', commonDataMiddleware, async (req, res) => {
  const show = authors.SHOWS.includes(req.query.show) ? req.query.show : '';
  const sort = authors.SORTS.includes(req.query.sort) ? req.query.sort : '';
  const asked = req.query.page;
  const list = await authors.all({ show, sort, page: parseInt(asked, 10) || 1, viewer: req.session.userId });
  const qs = (n) => {
    const q = new URLSearchParams();
    if (show) q.set('show', show);
    if (sort) q.set('sort', sort);
    if (n > 1) q.set('page', n);
    const s = q.toString();
    return '/authors/all' + (s ? '?' + s : '');
  };
  if (asked !== undefined) {
    if (asked === '1') return res.redirect(301, qs(1));
    if (asked !== String(list.page) || list.page === 1) return notFound(req, res);
  }
  res.render('authorsAll', { ...list, show, sort, pageHref: qs });
});

module.exports = router;
