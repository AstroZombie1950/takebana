// Вкладки «Журнал» и «Ошибки» — только администратору.
//
// В журнале лежат адреса и почты, в ошибках — стеки и куски внутренностей
// сервера. Модератору для разбора жалоб не нужно ни то, ни другое.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const AuditLog = require('../../models/AuditLog');
const ErrorLog = require('../../models/ErrorLog');
const { audit, ACTIONS } = require('../../utils/audit');
const { requireAdmin, paging, list, needle, period, namesFor } = require('./shared');

const OBJECT_ID = /^[a-f\d]{24}$/i;

// Фильтр журнала собирается в двух местах — в списке и в выгрузке, — поэтому
// живёт отдельной функцией: разойдись они, выгрузка отдавала бы не то,
// что человек видит на экране.
function auditFilter(req) {
  const filter = { ...period(req, 'at') };

  if (req.query.action && ACTIONS[req.query.action]) filter.action = req.query.action;
  // Группа действий: «всё про эфиры», «всё про вход». Коды устроены как
  // `stream.live`, `auth.login.fail` — отбираем по началу.
  else if (req.query.group) filter.action = new RegExp('^' + String(req.query.group).replace(/[^\w.]/g, '') + '\\.');

  if (req.query.actor && OBJECT_ID.test(req.query.actor)) filter.actor = req.query.actor;
  if (req.query.targetType) filter.targetType = String(req.query.targetType).slice(0, 20);
  if (['ok', 'fail', 'denied'].includes(req.query.result)) filter.result = req.query.result;
  if (req.query.ip) filter.ip = String(req.query.ip).slice(0, 45);

  const q = needle(req.query.q);
  if (q) filter.$or = [{ actorLogin: q }, { targetLabel: q }];

  return filter;
}

router.get('/audit', requireAdmin, async (req, res) => {
  const p = paging(req);
  const filter = auditFilter(req);

  const [rows, total] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1 }).skip(p.skip).limit(p.perPage).lean(),
    // Точный счёт по большому журналу стоит дорого, поэтому он ограничен:
    // панели хватает «больше 10 000», а не точного числа за полгода.
    AuditLog.countDocuments(filter, { limit: 10000 }),
  ]);

  const names = await namesFor(rows.map((r) => r.actor));

  res.json(list(rows.map((r) => ({
    id: String(r._id),
    at: r.at,
    action: r.action,
    label: ACTIONS[r.action] || r.action,
    result: r.result,
    actor: r.actor ? String(r.actor) : null,
    actorLogin: r.actorLogin || '',
    actorRole: r.actorRole || '',
    // Аватар и нынешнее имя — из базы: в журнале лежит подпись на момент
    // действия, а в списке удобнее узнавать человека по текущему виду.
    actorNow: names.get(String(r.actor)) || null,
    targetType: r.targetType || '',
    targetId: r.targetId ? String(r.targetId) : null,
    targetLabel: r.targetLabel || '',
    ip: r.ip || '',
    ua: r.ua || '',
    meta: r.meta || null,
  })), total, p));
});

// ── Выгрузка ─────────────────────────────────────────────────────────────────
//
// Тем же фильтром, что на экране. Потолок обязателен: журнал за полгода
// в один ответ не помещается ни у нас, ни у того, кто его откроет.
const CSV_LIMIT = 5000;

const cell = (v) => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

router.get('/audit.csv', requireAdmin, async (req, res) => {
  const filter = auditFilter(req);
  const rows = await AuditLog.find(filter).sort({ at: -1 }).limit(CSV_LIMIT).lean();

  audit(req, 'admin.export', { meta: { rows: rows.length, filter: Object.keys(filter) } });

  const head = ['Время', 'Действие', 'Код', 'Результат', 'Кто', 'Роль', 'Объект', 'Название', 'Адрес', 'Браузер', 'Подробности'];
  const lines = rows.map((r) => [
    new Date(r.at).toISOString(), ACTIONS[r.action] || r.action, r.action, r.result,
    r.actorLogin, r.actorRole, r.targetType, r.targetLabel, r.ip, r.ua, r.meta,
  ].map(cell).join(';'));

  // Точка с запятой и BOM: иначе Excel открывает кириллицу кракозябрами
  // и сваливает все столбцы в один.
  res
    .type('text/csv; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="takebana-audit-${new Date().toISOString().slice(0, 10)}.csv"`)
    .send('﻿' + [head.join(';'), ...lines].join('\r\n'));
});

// ── Ошибки ───────────────────────────────────────────────────────────────────
router.get('/errors', requireAdmin, async (req, res) => {
  const p = paging(req);
  const filter = { ...period(req, 'lastAt') };

  if (['server', 'client', 'media', 'external'].includes(req.query.scope)) filter.scope = req.query.scope;
  // По умолчанию — неразобранные: разобранное уже читали.
  if (req.query.resolved === '1') filter.resolved = true;
  else if (req.query.resolved !== 'all') filter.resolved = false;

  const q = needle(req.query.q);
  if (q) filter.$or = [{ message: q }, { route: q }, { name: q }];

  const [rows, total, byScope] = await Promise.all([
    ErrorLog.find(filter).sort({ lastAt: -1 }).skip(p.skip).limit(p.perPage).lean(),
    ErrorLog.countDocuments(filter),
    // Разбивка по видам — она же подписи фильтров со счётчиками.
    ErrorLog.aggregate([
      { $match: { resolved: false } },
      { $group: { _id: '$scope', n: { $sum: 1 }, cases: { $sum: '$count' } } },
    ]),
  ]);

  const names = await namesFor(rows.map((r) => r.lastUser));

  res.json({
    ...list(rows.map((r) => ({
      id: String(r._id),
      fingerprint: r.fingerprint,
      scope: r.scope,
      name: r.name,
      message: r.message,
      stack: r.stack,
      route: r.route,
      status: r.status,
      count: r.count,
      firstAt: r.firstAt,
      lastAt: r.lastAt,
      resolved: !!r.resolved,
      lastIp: r.lastIp,
      lastUa: r.lastUa,
      lastMeta: r.lastMeta,
      lastUser: names.get(String(r.lastUser)) || null,
    })), total, p),
    byScope: byScope.reduce((acc, row) => ({ ...acc, [row._id]: { groups: row.n, cases: row.cases } }), {}),
  });
});

router.post('/errors/:id/resolve', requireAdmin, async (req, res) => {
  if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: 'Ошибка не найдена' });

  const resolved = req.body && req.body.resolved === false ? false : true;
  const row = await ErrorLog.findByIdAndUpdate(
    req.params.id,
    resolved
      ? { resolved: true, resolvedBy: req.session.userId, resolvedAt: new Date() }
      : { resolved: false, resolvedBy: null, resolvedAt: null },
    { new: true }
  ).lean();

  if (!row) return res.status(404).json({ message: 'Ошибка не найдена' });

  audit(req, 'admin.error.resolve', {
    targetType: 'error',
    targetId: row._id,
    targetLabel: row.message.slice(0, 120),
    meta: { resolved, fingerprint: row.fingerprint, count: row.count },
  });

  res.json({ ok: true, resolved });
});

module.exports = router;
