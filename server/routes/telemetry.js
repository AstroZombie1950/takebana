// Приём телеметрии: итог попытки человека (models/Trace.js, docs/TELEMETRY.md).
//
// Браузер шлёт sendBeacon строкой — так он уходит и со страницы, которую
// закрывают. Одна запись на попытку: досылки с тем же tid перезаписывают
// этапы, исход и числа, а кто, откуда и с чего — ставится один раз,
// при первой.
//
// Маршрут открыт без входа: эфир смотрят и гости. Поэтому лимит по адресу,
// потолок размера и строгие поля — сюда пишет кто угодно. Лимит мягче, чем
// у журнала ошибок: зритель эфира присылает итог раз в минуту, а за одним
// адресом бывает десяток телефонов (бар, офис).

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const Trace = require('../models/Trace');
const netInfo = require('../utils/netInfo');
const errorLog = require('../utils/errorLog');

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 150,
  standardHeaders: false,
  legacyHeaders: false,
  handler: (req, res) => res.status(204).end(),
});

const TID = /^[\w-]{8,40}$/;
const CODE = /^[a-z][\w.]{0,39}$/;
const ROUTES = ['', 'cdn', 'fallback', 'daily', 'own'];
const OUTCOMES = ['open', 'ok', 'fail', 'gave_up', 'partial'];
const DAY_MS = 86400000;

const cut = (v, n) => String(v == null ? '' : v).slice(0, n);
const ms = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(DAY_MS, Math.round(v))) : null);

function steps(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40)
    .filter((x) => x && CODE.test(x.s) && ms(x.ms) != null)
    .map((x) => ({ s: x.s, ms: ms(x.ms) }));
}

// Числа направления: только плоские значения, коротко.
function stats(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, 24)) {
    if (!/^\w{1,24}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 60);
  }
  return out;
}

router.post('/api/t', limiter, express.text({ limit: '8kb', type: () => true }), (req, res) => {
  res.status(204).end();

  let b;
  try { b = JSON.parse(req.body); } catch (e) { return; }
  if (!b || !TID.test(b.tid) || !Trace.KINDS.includes(b.kind)) return;

  const now = Date.now();
  const tz = cut(b.tz, 40);
  const ip = req.ip || '';
  Trace.updateOne({ tid: b.tid }, {
    $setOnInsert: {
      tid: b.tid,
      kind: b.kind,
      target: cut(b.target, 60),
      user: (req.session && req.session.userId) || null,
      ip,
      ua: cut(req.get('user-agent'), 300),
      net: { ...netInfo.lookup(ip, tz), tz, type: cut(b.conn, 12), down: Number(b.down) || 0 },
      standalone: b.standalone === true,
      startedAt: new Date(now - (ms(b.ago) || 0)),
    },
    $set: {
      route: ROUTES.includes(b.route) ? b.route : '',
      steps: steps(b.steps),
      outcome: OUTCOMES.includes(b.outcome) ? b.outcome : 'open',
      reason: CODE.test(b.reason) ? b.reason : '',
      stats: stats(b.stats),
      updatedAt: new Date(now),
    },
  }, { upsert: true }).catch((e) => {
    // Две досылки одной попытки пришли разом — вторая упирается в уникальный
    // tid при вставке. Её данные новее не намного, терять не страшно.
    if (e.code !== 11000) errorLog.server(e, 'telemetry');
  });
});

module.exports = router;
