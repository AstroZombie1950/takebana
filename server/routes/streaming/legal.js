// Юридические страницы: условия обслуживания, конфиденциальность, cookie.
// Обложка — views/legal.ejs, текст — views/legal/<doc>.<lang>.ejs.
// commonDataMiddleware — ради шапки и панели вошедшего: документы открывают
// и гость, и вошедший.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { commonDataMiddleware } = require('./shared');

const DOCS = ['terms', 'privacy', 'cookies'];

for (const doc of DOCS) {
  router.get('/' + doc, commonDataMiddleware, (req, res) => res.render('legal', { doc }));
}

// Прежние адреса. Ссылки на них стоят снаружи — в кабинете Google, в письмах
// и в чужих закладках, — поэтому это постоянный перенос, а не удаление.
// «Правила» и «Пользовательское соглашение» слились в условия обслуживания.
const MOVED = {
  '/terms_of_service': '/terms',
  '/user_agreement': '/terms',
  '/personal_data_processing': '/privacy',
};

for (const [from, to] of Object.entries(MOVED)) {
  router.get(from, (req, res) => res.redirect(301, to));
}

module.exports = router;
