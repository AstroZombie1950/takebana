// «Система → Нагрузка» (02.10.2026, план п. 7): процессор, память, сеть, диск,
// эфиры, зрители (и на запасном пути), звонки, порты TURN, очереди пережатия —
// сейчас и графиком за час, сутки, неделю или месяц
// (замеры раз в минуту, utils/loadStats.js). Здесь же — где у эфиров знак,
// поверх плеера или в кадре (utils/streamWatermark.js): выбор этот ради
// процессора и делается, поэтому живёт рядом с его графиком. До 02.10 знак
// был отдельной вкладкой «Водяной знак» — Иван попросил её убрать.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const { requireAdmin } = require('./shared');
const LoadSample = require('../../models/LoadSample');
const loadStats = require('../../utils/loadStats');
const streamWatermark = require('../../utils/streamWatermark');
const hls = require('../../utils/hls');
const turn = require('../../utils/turn');
const { audit } = require('../../utils/audit');

const MIN = 60000;
// Отрезок → сколько назад и шаг точки графика.
const RANGES = {
  hour: { span: 60 * MIN, step: MIN },
  day: { span: 1440 * MIN, step: 15 * MIN },
  week: { span: 7 * 1440 * MIN, step: 60 * MIN },
  month: { span: 30 * 1440 * MIN, step: 1440 * MIN },
};
const GROUPS = ['ffmpeg', 'node', 'mongo', 'mediamtx', 'turn', 'other'];
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

router.get('/load', requireAdmin, async (req, res) => {
  const range = RANGES[req.query.range] ? req.query.range : 'day';
  const { span, step } = RANGES[range];
  const from = new Date(Date.now() - span);
  const streamsTotal = { $add: ['$streams.full', '$streams.lite', '$streams.copy'].map((f) => ({ $ifNull: [f, 0] })) };

  const [last, rows] = await Promise.all([
    LoadSample.findOne().sort({ at: -1 }).lean(),
    LoadSample.aggregate([
      { $match: { at: { $gte: from } } },
      { $group: {
        _id: { $subtract: [{ $toLong: '$at' }, { $mod: [{ $toLong: '$at' }, step] }] },
        cpu: { $avg: '$cpu' }, cpuMax: { $max: '$cpu' }, mem: { $max: '$mem' },
        streams: { $max: streamsTotal }, viewers: { $max: '$viewers' }, calls: { $max: '$calls' },
        rx: { $avg: '$net.rx' }, tx: { $avg: '$net.tx' }, txMax: { $max: '$net.tx' }, disk: { $max: '$disk' },
        lf: { $max: '$lf' }, ports: { $max: '$turn' }, // не turn: так зовётся группа процессов ниже
        encode: { $max: { $add: ['$encode.recording', '$encode.chat', '$encode.gallery'].map((f) => ({ $ifNull: [f, 0] })) } },
        ...Object.fromEntries(GROUPS.map((g) => [g, { $avg: '$procs.' + g }])),
      } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  res.json({
    range,
    step,
    warn: loadStats.CPU_WARN,
    diskWarn: loadStats.DISK_WARN,
    turnPorts: turn.PORTS,
    // Последний замер — не старше двух минут, иначе его нет (сервер только
    // запустился или замеры не пишутся).
    last: last && Date.now() - last.at < 2 * MIN ? last : null,
    usage: hls.usage(),
    mode: streamWatermark.mode(),
    modeAt: streamWatermark.updatedAt(),
    points: rows.map((p) => ({
      at: new Date(p._id),
      cpu: r1(p.cpu), cpuMax: r1(p.cpuMax), mem: r1(p.mem),
      streams: p.streams || 0, viewers: p.viewers || 0, calls: p.calls || 0,
      rx: r1(p.rx), tx: r1(p.tx), txMax: r1(p.txMax), disk: r1(p.disk),
      lf: p.lf || 0, turn: p.ports || 0, encode: p.encode || 0,
      procs: Object.fromEntries(GROUPS.map((g) => [g, r2(p[g])])),
    })),
  });
});

router.put('/watermark', requireAdmin, express.json({ limit: '1kb' }), async (req, res) => {
  const was = streamWatermark.mode();
  const now = await streamWatermark.save(req.body && req.body.mode, req.session.userId);
  if (!now) return res.status(400).json({ message: 'Нет такого режима' });
  if (now !== was) audit(req, 'admin.watermark', { meta: { was, now } });
  res.json({ mode: now });
});

module.exports = router;
