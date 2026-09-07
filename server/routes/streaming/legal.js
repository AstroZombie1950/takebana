// Юридические страницы. Тексты — в views/terms/.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос


router.get('/terms_of_service', (req, res) => {
  res.render('terms/terms_of_service');
});

// Маршрут для "Пользовательского соглашения"
router.get('/user_agreement', (req, res) => {
  res.render('terms/user_agreement');
});

// Маршрут для "Политики обработки персональных данных"
router.get('/personal_data_processing', (req, res) => {
  res.render('terms/personal_data_processing');
});

module.exports = router;
