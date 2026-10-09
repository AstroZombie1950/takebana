// Системное «Поделиться» телефона → Takebana (09.10.2026, заказчик).
//
// Android ставит установленный с иконки сайт в список «Поделиться» по
// share_target в public/manifest.webmanifest: ссылка или текст из чужого
// приложения открывают /share?title=&text=&url=. Здесь — выбор, куда:
// «Новый пост» (форма в «Ленте» с этим текстом) или «В переписку» (текст
// ляжет в поле диалога, который выберут). iPhone так не умеет: Safari
// share_target не поддерживает (docs/POSTS.md, «Системное меню»).

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { commonDataMiddleware } = require('./streaming/shared');

const MAX = 2000;
const one = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX) : '');

router.get('/share', requireAuth, commonDataMiddleware, (req, res) => {
  // Приложения кладут ссылку кто в url, кто в text, а заголовок дублирует
  // текст: собираем без повторов.
  const parts = [];
  for (const v of [one(req.query.title), one(req.query.text), one(req.query.url)]) {
    if (v && !parts.some((p) => p.includes(v))) parts.push(v);
  }
  const text = parts.join('\n').slice(0, MAX);
  const qs = (extra) => new URLSearchParams({ ...extra, text }).toString();
  res.render('shareIn', { text, postHref: '/feed?' + qs({ compose: '1' }), chatHref: '/chatsPage?' + qs({}) });
});

module.exports = router;
