// Вкладка «Сроки хранения» (28.09.2026): сколько хранить вложения
// переписки, фото и видео галереи и записи эфиров — всем и отдельным
// людям. Сами сроки пока не применяются (utils/retention.js): вкладка
// хранит решение и показывает, сколько файлов и места ушло бы сегодня.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const { requireAdmin, personBrief } = require('./shared');
const retention = require('../../utils/retention');
const { audit } = require('../../utils/audit');

const OBJECT_ID = /^[a-f\d]{24}$/i;

router.get('/retention', requireAdmin, async (req, res) => {
  const policy = await retention.policy();
  const [preview, people] = await Promise.all([retention.preview(policy), retention.customized()]);
  res.json({
    policy,
    updatedAt: retention.updatedAt(),
    preview,
    people: people
      .map((u) => ({ person: personBrief(u), own: retention.own(u) }))
      .filter((p) => Object.keys(p.own).length),
  });
});

router.put('/retention', requireAdmin, express.json({ limit: '2kb' }), async (req, res) => {
  const was = await retention.policy();
  const now = await retention.save(req.body, req.session.userId);
  audit(req, 'admin.retention', { meta: { was, now } });
  res.json({ policy: now });
});

// Личные сроки. null у вида — вернуть «как у всех».
router.put('/users/:id/retention', requireAdmin, express.json({ limit: '2kb' }), async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: 'Пользователь не найден' });
  const own = await retention.saveFor(req.params.id, req.body);
  if (!own) return res.status(404).json({ message: 'Пользователь не найден' });
  audit(req, 'admin.retention.user', { targetType: 'user', targetId: req.params.id, meta: { now: own } });
  res.json({ own, limits: retention.limits(await retention.policy(), { retention: own }) });
});

module.exports = router;
