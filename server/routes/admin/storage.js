// Вкладка «Хранилище»: сколько места занято в Bunny и на диске сервера,
// какими файлами, сколько это стоит в месяц и сколько будет стоить при
// нынешнем росте. Обход хранилищ и сверка с базой — utils/storageReport.js,
// трафик и деньги по данным самого Bunny — utils/usage.js.
//
// Цены — калькулятора проекта (views/calc.html), переопределяются в .env
// (BUNNY_USD_PER_GB, BUNNY_USD_PER_GB_TRAFFIC, HOSTING_USD_PER_MONTH).
// Число копий — из настроек зоны Bunny: хранение оплачивается за каждую.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const { requireAdmin, sendCsv } = require('./shared');
const storageReport = require('../../utils/storageReport');
const usage = require('../../utils/usage');

const DAY = 86400000;
const GB = 1073741824;
const TARIFF = {
  storeGb: Number(process.env.BUNNY_USD_PER_GB) || 0.01,
  trafficGb: Number(process.env.BUNNY_USD_PER_GB_TRAFFIC) || 0.01,
  hostingMonth: Number(process.env.HOSTING_USD_PER_MONTH) || null,
};
const FORECAST_MONTHS = [1, 3, 6, 12];

const usd = (n) => Math.round(n * 100) / 100;

// Деньги и прогноз к отчёту. Рост — то, что добавилось за 30 дней: удалённое
// за то же время обход не видит, поэтому прогноз — потолок, а не точка.
function costs(report, zone) {
  const copies = (zone.storage && zone.storage.copies) || 1;
  const month = (bytes) => usd((bytes / GB) * TARIFF.storeGb * copies);
  const out = { tariff: { ...TARIFF, copies } };

  const b = report.bunny;
  if (b) {
    const orphan = Object.values(b.groups).reduce((n, g) => n + ((g.kinds.orphan && g.kinds.orphan.bytes) || 0), 0);
    out.bunny = {
      monthUsd: month(b.bytes),
      groups: Object.fromEntries(Object.entries(b.groups).map(([k, g]) => [k, month(g.bytes)])),
      orphanBytes: orphan,
      orphanUsd: month(orphan),
      forecast: FORECAST_MONTHS.map((m) => ({ months: m, bytes: b.bytes + b.added30 * m, usd: month(b.bytes + b.added30 * m) })),
    };
  }
  if (zone.configured && !zone.error) {
    out.traffic = {
      bytes: zone.bandwidthBytes,
      usd: usd((zone.bandwidthBytes / GB) * TARIFF.trafficGb),
      spentUsd: zone.spentUsd,
      balanceUsd: zone.balanceUsd,
    };
  }

  // Сервер оплачен вперёд: место на диске денег сверху не стоит, пока оно
  // есть. Поэтому здесь — сколько занято нами и на сколько хватит.
  const s = report.server;
  const db = s.db.storage + s.db.index;
  const perDay = s.added30 / 30;
  out.server = {
    usedBytes: s.bytes + db,
    dbBytes: db,
    daysLeft: s.disk && perDay > 0 ? Math.floor(s.disk.free / perDay) : null,
    hostingMonth: TARIFF.hostingMonth,
  };
  return out;
}

async function load(req) {
  const [report, zone] = await Promise.all([
    storageReport.get({ fresh: req.query.fresh === '1' }),
    usage.bunny(new Date(Date.now() - 30 * DAY), new Date()),
  ]);
  if (report.pending || report.error) return { ...report, zone };
  return { report, zone, costs: costs(report, zone) };
}

router.get('/storage', requireAdmin, async (req, res) => res.json(await load(req)));

// Выгрузка: место — группа — вид — файлов — байт — долларов в месяц.
// Пока отчёт считается, выгружать нечего — 409, панель подскажет подождать.
router.get('/storage.csv', requireAdmin, async (req, res) => {
  const d = await load(req);
  if (!d.report) return res.status(409).json({ message: d.error || 'Сводка ещё считается, попробуйте через минуту' });
  const { report, costs: c } = d;
  const rows = [];
  const place = (title, t, price) => {
    for (const [group, g] of Object.entries(t.groups)) {
      for (const [kind, k] of Object.entries(g.kinds)) {
        rows.push([title, group, kind, k.files, k.bytes, price ? usd((k.bytes / GB) * c.tariff.storeGb * c.tariff.copies) : '']);
      }
    }
  };
  if (report.bunny) place('Bunny', report.bunny, true);
  place('Сервер', report.server, false);
  rows.push(['Сервер', 'db', 'mongo', '', c.server.dbBytes, '']);
  sendCsv(req, res, 'storage', ['Где', 'Группа', 'Вид', 'Файлов', 'Байт', 'USD в месяц'], rows);
});

module.exports = router;
