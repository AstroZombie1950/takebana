// Вкладка «Лимиты» (15.10.2026): что и сколько люди загружают и записывают,
// пороги диска и баланса Bunny (utils/limits.js) — всем и отдельным людям.
// Сроки хранения — на той же вкладке, своим маршрутом (routes/admin/retention.js).

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const { requireAdmin, personBrief } = require('./shared');
const limits = require('../../utils/limits');
const { audit } = require('../../utils/audit');

const OBJECT_ID = /^[a-f\d]{24}$/i;

const view = () => ({ limits: limits.get(), fields: limits.FIELDS, own: limits.OWN, defaults: limits.DEFAULTS, updatedAt: limits.updatedAt() });

router.get('/limits', requireAdmin, async (req, res) => {
  await limits.load();
  const people = await limits.customized();
  res.json({
    ...view(),
    people: people.map((u) => ({ person: personBrief(u), own: limits.ownOf(u) })).filter((p) => Object.keys(p.own).length),
  });
});

router.put('/limits', requireAdmin, express.json({ limit: '2kb' }), async (req, res) => {
  const was = { ...(await limits.load()) };
  const now = await limits.save(req.body, req.session.userId);
  audit(req, 'admin.limits', { meta: { was, now } });
  res.json(view());
});

// Личные лимиты человека: null у поля — вернуть «как у всех».
router.put('/users/:id/limits', requireAdmin, express.json({ limit: '2kb' }), async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: 'Пользователь не найден' });
  const own = await limits.saveFor(req.params.id, req.body);
  if (!own) return res.status(404).json({ message: 'Пользователь не найден' });
  audit(req, 'admin.limits.user', { targetType: 'user', targetId: req.params.id, meta: { now: own } });
  res.json({ own, all: limits.get() });
});

module.exports = router;
