// Страница авторов (/authors): кто сейчас в эфире, кого смотрят, кто появился
// недавно и у кого есть записи. Кого показывать и в каком порядке — решает
// utils/authors.js; сюда же ходит витрина за тройкой авторов в колонку.
//
// Открыта гостю: это витрина людей, а не кабинет.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { commonDataMiddleware } = require('./streaming/shared');
const authors = require('../utils/authors');

router.get('/authors', commonDataMiddleware, async (req, res) => {
  res.render('authors', { groups: await authors.groups({ viewer: req.session.userId }) });
});

module.exports = router;
