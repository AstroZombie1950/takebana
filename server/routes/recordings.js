// Записи эфиров: просмотр и удаление. Сохраняет запись завершение эфира
// (routes/streaming/streams.js), склеивает и выгружает utils/recording.js,
// список — на странице пользователя (routes/streaming/catalog.js).

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const Recording = require('../models/Recording');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { commonDataMiddleware } = require('./streaming/shared');
const recording = require('../utils/recording');
const userView = require('../utils/userView');

const OBJECT_ID = /^[a-f\d]{24}$/i;

// Страница записи. Чужому — только готовая; метка 18+ — через тот же гейт,
// что у эфира: подтверждение возраста хранится в аккаунте, гостя гейт зовёт войти.
router.get('/recording/:id', commonDataMiddleware, async (req, res) => {  const rec = OBJECT_ID.test(req.params.id)
    ? await Recording.findById(req.params.id).populate('userId', 'login email avatar').lean()
    : null;
  const isOwner = !!rec && !!rec.userId && String(rec.userId._id) === String(req.session.userId);
  if (!rec || !rec.userId || (rec.status !== 'ready' && !isOwner)) {
    return res.status(404).render('streamNotFound');
  }
  if (rec.isAdult && !isOwner && !(res.locals.currentUser && res.locals.currentUser.adultConfirmedAt)) {
    return res.render('ageGate');
  }

  const displayName = userView.displayName(rec.userId);
  res.render('recording', {
    rec,
    isOwner,
    author: { _id: rec.userId._id, displayName, avatarStyle: userView.avatarStyle(rec.userId, displayName) },
  });
});

// Удаляет автор (и администратор — так устроен requireOwner). Пока запись
// склеивается, удалять нечего: файлов ещё нет, а склейка допишет документ.
router.delete('/recording/:id', requireAuth,
  (req, res, next) => (OBJECT_ID.test(req.params.id) ? next() : res.status(404).json({ message: 'Запись не найдена' })),
  requireOwner(Recording, { field: 'userId' }), async (req, res) => {
  if (req.resource.status === 'processing') {
    return res.status(409).json({ message: 'Запись ещё сохраняется, удалить можно после' });
  }
  await recording.remove(req.resource);
  res.json({ success: true });
});

module.exports = router;
