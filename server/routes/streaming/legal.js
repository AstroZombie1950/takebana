// Юридические страницы. Тексты — в views/terms/. commonDataMiddleware — ради
// шапки и панели вошедшего: документы открывают и гость, и вошедший.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { commonDataMiddleware } = require('./shared');


router.get('/terms_of_service', commonDataMiddleware, (req, res) => {
  res.render('terms/terms_of_service');
});

router.get('/user_agreement', commonDataMiddleware, (req, res) => {
  res.render('terms/user_agreement');
});

router.get('/personal_data_processing', commonDataMiddleware, (req, res) => {
  res.render('terms/personal_data_processing');
});

module.exports = router;
