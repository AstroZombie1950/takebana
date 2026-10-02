// Вкладка «Попытки» и карточка эфира — телеметрия (docs/TELEMETRY.md).
//
// Только администратору: в записях адреса и провайдеры людей.
//
// Карточка эфира собирает в одно место то, что 2 октября пришлось сводить
// руками из трёх источников: хронологию конвейера (StreamSession.events),
// попытки ведущего и зрителей (Trace) и журнал ведущего у Daily — его не
// храним, а берём у Daily по комнате эфира, когда карточку открыли.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const Trace = require('../../models/Trace');
const StreamSession = require('../../models/StreamSession');
const daily = require('../../utils/daily');
const errorLog = require('../../utils/errorLog');
const { requireAdmin, paging, list, period, namesFor, csvRoute, nameOf } = require('./shared');

const OBJECT_ID = /^[a-f\d]{24}$/i;
const OUTCOMES = ['open', 'ok', 'fail', 'gave_up', 'partial'];

// Устройство одной строкой: «iOS 18 · Safari», «Android 16 · Chrome».
// Приложение-обёртка (Google, Telegram) важнее браузера под ним: у них свои
// причуды с камерой и фоном.
function device(ua) {
  const s = String(ua || '');
  const os = /iPhone|iPad/.test(s) ? 'iOS ' + ((s.match(/OS (\d+)_/) || [])[1] || '')
    : /Android (\d+)/.test(s) ? 'Android ' + s.match(/Android (\d+)/)[1]
    : /Mac OS X/.test(s) ? 'macOS' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : '';
  const app = /GSA\//.test(s) ? 'Google' : /Telegram/i.test(s) ? 'Telegram' : /Instagram/.test(s) ? 'Instagram'
    : /YaBrowser|YaApp/.test(s) ? 'Яндекс' : /CriOS/.test(s) ? 'Chrome' : /FxiOS|Firefox/.test(s) ? 'Firefox'
    : /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  return [os.trim(), app].filter(Boolean).join(' · ');
}

function traceView(t, names) {
  return {
    id: String(t._id),
    at: t.startedAt,
    updatedAt: t.updatedAt,
    kind: t.kind,
    target: t.target || '',
    user: t.user ? names.get(String(t.user)) || null : null,
    ip: t.ip || '',
    net: t.net || {},
    device: device(t.ua),
    standalone: !!t.standalone,
    route: t.route || '',
    steps: t.steps || [],
    outcome: t.outcome,
    reason: t.reason || '',
    stats: t.stats || {},
  };
}

// ── Список попыток ───────────────────────────────────────────────────────────
function traceFilter(req) {
  const filter = { ...period(req, 'startedAt') };
  if (Trace.KINDS.includes(req.query.kind)) filter.kind = req.query.kind;
  if (OUTCOMES.includes(req.query.outcome)) filter.outcome = req.query.outcome;
  // «Не вышло» — всё, что не ok и не идёт сейчас.
  else if (req.query.outcome === 'bad') filter.outcome = { $in: ['fail', 'gave_up', 'partial'] };
  if (typeof req.query.user === 'string' && OBJECT_ID.test(req.query.user)) filter.user = req.query.user;
  if (req.query.target) filter.target = String(req.query.target).slice(0, 60);
  if (req.query.ip) filter.ip = String(req.query.ip).slice(0, 45);
  if (/^[A-Z]{2}$/.test(req.query.country || '')) filter['net.country'] = req.query.country;
  if (req.query.vpn === '1') filter['net.vpn'] = true;
  if (['cdn', 'fallback', 'daily', 'own'].includes(req.query.route)) filter.route = req.query.route;
  return filter;
}

async function loadTraces(req) {
  const p = paging(req);
  const filter = traceFilter(req);
  const [rows, total] = await Promise.all([
    Trace.find(filter).sort({ startedAt: -1 }).skip(p.skip).limit(p.perPage).lean(),
    req.csv ? 0 : Trace.countDocuments(filter, { limit: 10000 }),
  ]);
  const names = await namesFor(rows.map((r) => r.user));
  return list(rows.map((r) => traceView(r, names)), total, p);
}

router.get('/traces', requireAdmin, async (req, res) => res.json(await loadTraces(req)));
const stepsText = (t) => t.steps.map((x) => `${x.s} ${(x.ms / 1000).toFixed(1)}`).join(', ');
csvRoute(router, '/traces', requireAdmin, 'traces', loadTraces, [
  ['Когда', (t) => t.at],
  ['Направление', (t) => t.kind],
  ['К чему', (t) => t.target],
  ['Кто', (t) => nameOf(t.user)],
  ['Исход', (t) => t.outcome],
  ['Причина', (t) => t.reason],
  ['Путь', (t) => t.route],
  ['Этапы, с', stepsText],
  ['Числа', (t) => t.stats],
  ['Страна', (t) => t.net.country || ''],
  ['Провайдер', (t) => t.net.org || ''],
  ['VPN?', (t) => (t.net.vpn ? 'похоже' : '')],
  ['Часовой пояс', (t) => t.net.tz || ''],
  ['Устройство', (t) => t.device],
  ['С иконки', (t) => (t.standalone ? 'да' : '')],
  ['Адрес', (t) => t.ip],
]);

// Сводка за сутки по направлениям: доля успешных и медиана до результата.
// Результат у эфира зрителя — первый кадр, у ведущего — выход в эфир.
const DONE_STEP = { 'live.view': 'frame', 'live.host': 'live', 'venue.view': 'frame', 'venue.host': 'live', call: 'connected', upload: 'done', 'chat.media': 'done' };
router.get('/traces/summary', requireAdmin, async (req, res) => {
  const from = new Date(Date.now() - 86400000);
  const rows = await Trace.find({ startedAt: { $gte: from } }).select('kind outcome route steps').lean();
  const by = {};
  for (const t of rows) {
    const k = by[t.kind] || (by[t.kind] = { total: 0, ok: 0, bad: 0, fallback: 0, times: [] });
    k.total++;
    if (t.outcome === 'ok') k.ok++;
    if (['fail', 'gave_up', 'partial'].includes(t.outcome)) k.bad++;
    if (t.route === 'fallback') k.fallback++;
    const done = (t.steps || []).find((x) => x.s === DONE_STEP[t.kind]);
    if (done) k.times.push(done.ms);
  }
  for (const k of Object.values(by)) {
    k.times.sort((a, b) => a - b);
    k.median = k.times.length ? k.times[Math.floor(k.times.length / 2)] : null;
    delete k.times;
  }
  res.json({ by });
});

// ── Карточка эфира ───────────────────────────────────────────────────────────
// Попытки берутся по ключу эфира в окне отрезка: ключ у ведущего один на
// все его эфиры, а отрезок — один выход в эфир.
router.get('/streams/:id/detail', requireAdmin, async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: 'Нет такого эфира' });
  const s = await StreamSession.findById(req.params.id).lean();
  if (!s) return res.status(404).json({ message: 'Нет такого эфира' });

  const from = new Date(s.startedAt.getTime() - 2 * 60000);
  const to = new Date((s.endedAt || new Date()).getTime() + 60000);
  const traces = await Trace.find({ target: s.streamKey, kind: { $in: ['live.view', 'live.host'] }, startedAt: { $gte: from, $lte: to } })
    .sort({ startedAt: 1 }).limit(1000).lean();
  const names = await namesFor([s.user, ...traces.map((t) => t.user)]);

  res.json({
    session: {
      id: String(s._id),
      title: s.title || '',
      source: s.source,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      duration: s.duration || 0,
      peakViewers: s.peakViewers || 0,
      endedBy: s.endedBy || '',
      room: s.room || '',
      owner: names.get(String(s.user)) || null,
      events: s.events || [],
    },
    host: traces.filter((t) => t.kind === 'live.host').map((t) => traceView(t, names)),
    viewers: traces.filter((t) => t.kind === 'live.view').map((t) => traceView(t, names)),
  });
});

// Журнал ведущего у Daily — выжимка тех же признаков, по которым разбирались
// тесты 01.10: устройство и пояс, сколько грузился скрипт Daily и пришлось ли
// ему уходить на запасной домен, камера, доступная отдача и кадр, качество
// сети, переподключения и «wss is stale».
function digest(logs, metrics) {
  const r = { os: '', browser: '', tz: '', bundleMs: null, failedOver: false, ttfmMs: null, cameraDenied: false,
    availKbps: null, availMinKbps: null, frames: [], net: [], reconnects: 0, stale: 0, errors: 0, sentKbps: null, firstLog: null };
  const avail = [];
  const frames = new Set();
  const net = new Set();
  for (const x of logs) {
    const m = String(x.message || '');
    if (!r.firstLog || x.clientTime < r.firstLog) r.firstLog = x.clientTime;
    if (x.level === 0) r.errors++;
    if (m.startsWith('OS = ')) r.os = m.slice(5).trim();
    else if (m.startsWith('Browser = ')) r.browser = m.slice(10).trim();
    else if (m.startsWith('TimeZone = ')) r.tz = m.slice(11).trim();
    else if (m === 'reconnect to sfu') r.reconnects++;
    else if (m.includes('wss is stale')) r.stale++;
    else if (/Permissions denied/i.test(m)) r.cameraDenied = true;
    else if (m.includes('HighestVideoSendFrameSize=')) frames.add(m.split('=')[1]);
    else if (m.includes('Network Quality State')) { try { net.add(JSON.parse(m.slice(m.indexOf('{'))).state); } catch (e) { /* не JSON */ } }
    else if (m.includes('availableOutgoingBitrate')) { const v = m.match(/"availableOutgoingBitrate":(\d+)/); if (v) avail.push(Number(v[1])); }
    else if (m.includes('timing stats')) {
      try {
        const j = JSON.parse(m.slice(m.indexOf('{')));
        if (j.event === 'bundle load') { r.bundleMs = j.time; r.failedOver = !!j.failedOver; }
        if (j.event === 'ttfm-send') r.ttfmMs = j.time;
      } catch (e) { /* не JSON */ }
    }
  }
  const med = (a) => { if (!a.length) return null; const b = a.slice().sort((p, q) => p - q); return b[Math.floor(b.length / 2)]; };
  if (avail.length) { r.availKbps = Math.round(med(avail) / 1000); r.availMinKbps = Math.round(Math.min(...avail) / 1000); }
  const sent = metrics.map((x) => x.userSentBitsPerSecAvg || 0);
  if (sent.length) r.sentKbps = Math.round(med(sent) / 1000);
  r.frames = [...frames].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  r.net = [...net];
  return r;
}

router.get('/streams/:id/daily', requireAdmin, async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: 'Нет такого эфира' });
  const s = await StreamSession.findById(req.params.id).select('room').lean();
  if (!s || !s.room) return res.status(404).json({ message: 'У эфира нет комнаты Daily — OBS или эфир до 2 октября' });
  try {
    const m = await daily.meetings(s.room);
    const out = [];
    for (const mt of (m.data || []).slice(0, 5)) {
      const d = await daily.logs(mt.id);
      out.push({ id: mt.id, start: mt.start_time * 1000, duration: mt.duration, ...digest(d.logs || [], d.metrics || []) });
    }
    res.json({ meetings: out });
  } catch (e) {
    // Подробность — в журнал ошибок: там её видно целиком.
    errorLog.external(e, 'daily.logs', { session: req.params.id });
    res.status(502).json({ message: 'Daily не ответил' });
  }
});

module.exports = router;
