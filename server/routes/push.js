// Подписка устройства на пуш-уведомления. Сама отправка — utils/push.js,
// приём на устройстве — public/sw.js, включение — public/tk-push.js.
//
// Публичный ключ VAPID страницам отдаёт app.locals (app.js), отдельного
// маршрута под него нет: он нужен ровно в момент подписки, а страница
// настроек и так рисуется сервером.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { requireAuthApi } = require('../middleware/auth');
const { langOf } = require('../utils/i18n');
const PushSubscription = require('../models/PushSubscription');
const push = require('../utils/push');

// Включили пуши на этом устройстве — или зашли с него ещё раз, и браузер
// прислал ту же подписку: обе дороги ведут сюда, запись одна на адрес.
router.post('/api/push/subscribe', requireAuthApi, async (req, res) => {
  if (!push.pushConfigured) return res.status(503).json({ message: 'Пуш-уведомления не настроены' });
  const { subscription, preview, live } = req.body || {};
  try {
    await push.subscribe(req.session.userId, subscription, {
      ua: req.headers['user-agent'],
      lang: langOf(req),
      preview,
      live,
    });
  } catch (e) {
    return res.status(400).json({ message: 'Негодная подписка' });
  }
  // Запоминаем адрес, чтобы выход из аккаунта снял подписку этого устройства
  // (routes/pages.js, /logout).
  req.session.pushEndpoint = subscription.endpoint;
  res.json({ ok: true });
});

// Выключили пуши или вышли из аккаунта. Без входа тоже принимаем: выход
// уже мог закрыть сессию, а подписку на чужом теперь устройстве оставлять
// нельзя — иначе следующий вошедший получит чужие уведомления.
router.post('/api/push/unsubscribe', async (req, res) => {
  const endpoint = (req.body || {}).endpoint;
  if (endpoint) await push.unsubscribe(String(endpoint));
  res.json({ ok: true });
});

// Что выбрано на этом устройстве. Страница настроек не помнит ничего сама:
// подписка живёт дольше вкладки, и единственный, кто знает выбор, — сервер.
router.get('/api/push/state', requireAuthApi, async (req, res) => {
  const sub = await PushSubscription.findOne({ endpoint: String(req.query.endpoint || ''), user: req.session.userId })
    .select('preview live')
    .lean();
  if (!sub) return res.status(404).json({ message: 'Запись не найдена' });
  res.json({ preview: !!sub.preview, live: !!sub.live });
});

// Показывать ли текст сообщения и слать ли про эфиры — выбор для этого
// устройства, а не для аккаунта.
router.post('/api/push/prefs', requireAuthApi, async (req, res) => {
  const { endpoint, preview, live } = req.body || {};
  if (!endpoint) return res.status(400).json({ message: 'Недостаточно данных' });
  const saved = await push.setPrefs(req.session.userId, String(endpoint), { preview, live });
  if (!saved) return res.status(404).json({ message: 'Запись не найдена' });
  res.json({ ok: true, preview: saved.preview, live: saved.live });
});

// «Проверить» в настройках. Остаётся насовсем: когда на новом телефоне
// уведомления молчат, это единственный способ отличить «не дошло» от
// «выключено в системе», не трогая чужую переписку.
router.post('/api/push/test', requireAuthApi, async (req, res) => {
  if (!push.pushConfigured) return res.status(503).json({ message: 'Пуш-уведомления не настроены' });
  const out = await push.send(req.session.userId, {
    topic: 'message',
    title: 'Takebana',
    bodyKey: 'push.test',
    tag: 'test',
    url: '/settings',
  });
  if (!out.sent) return res.status(404).json({ message: 'Ни одно устройство не подписано' });
  res.json(out);
});

module.exports = router;
