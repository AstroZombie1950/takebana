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
const { audit, flush, ACTIONS } = require('../../utils/audit');
const { requireAdmin, paging, list, needle, period, namesFor, csvRoute, nameOf } = require('./shared');

const OBJECT_ID = /^[a-f\d]{24}$/i;

// Фильтр журнала один на список, выгрузку и очистку: разойдись они,
// выгрузка отдавала бы, а очистка стирала бы не то, что человек видит
// на экране.
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

async function loadAudit(req) {
  const p = paging(req);
  const filter = auditFilter(req);

  const [rows, total] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1 }).skip(p.skip).limit(p.perPage).lean(),
    // Точный счёт по большому журналу стоит дорого, поэтому он ограничен:
    // панели хватает «больше 10 000», а не точного числа за полгода.
    req.csv ? 0 : AuditLog.countDocuments(filter, { limit: 10000 }),
  ]);

  const names = await namesFor(rows.map((r) => r.actor));

  return list(rows.map((r) => ({
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
  })), total, p);
}

router.get('/audit', requireAdmin, async (req, res) => res.json(await loadAudit(req)));
csvRoute(router, '/audit', requireAdmin, 'audit', loadAudit, [
  ['Время', (r) => r.at],
  ['Действие', (r) => r.label],
  ['Код', (r) => r.action],
  ['Результат', (r) => r.result],
  ['Кто', (r) => r.actorLogin || nameOf(r.actorNow)],
  ['Роль', (r) => r.actorRole],
  ['Объект', (r) => r.targetType],
  ['Название', (r) => r.targetLabel],
  ['Адрес', (r) => r.ip],
  ['Браузер', (r) => r.ua],
  ['Подробности', (r) => r.meta],
]);

// Очистка — тем же фильтром, что на экране: без отбора уходит весь журнал.
// Буфер сбрасывается до удаления, иначе записи последней секунды легли бы
// в базу уже после очистки. Сама очистка пишется следом и остаётся в журнале
// первой строкой: след того, кто и сколько стёр, стирать нельзя.
router.delete('/audit', requireAdmin, async (req, res) => {
  const filter = auditFilter(req);
  await flush();
  const { deletedCount } = await AuditLog.deleteMany(filter);

  audit(req, 'admin.audit.clear', { meta: { rows: deletedCount, filter: Object.keys(filter) } });
  res.json({ ok: true, rows: deletedCount });
});

// ── Ошибки ───────────────────────────────────────────────────────────────────
async function loadErrors(req) {
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

  return {
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
  };
}

router.get('/errors', requireAdmin, async (req, res) => res.json(await loadErrors(req)));
csvRoute(router, '/errors', requireAdmin, 'errors', loadErrors, [
  ['Где', (e) => e.scope],
  ['Ошибка', (e) => e.name],
  ['Код', (e) => e.status],
  ['Сообщение', (e) => e.message],
  ['Маршрут', (e) => e.route],
  ['Случаев', (e) => e.count],
  ['Впервые', (e) => e.firstAt],
  ['Последний раз', (e) => e.lastAt],
  ['Разобрана', (e) => (e.resolved ? 'да' : '')],
  ['Последний у', (e) => nameOf(e.lastUser)],
  ['Адрес', (e) => e.lastIp],
  ['Браузер', (e) => e.lastUa],
  ['Отпечаток', (e) => e.fingerprint],
  ['Стек', (e) => e.stack],
  // Хронология несоединившегося звонка и прочие подробности из браузера.
  ['Подробности', (e) => (e.lastMeta ? JSON.stringify(e.lastMeta, null, 2) : '')],
]);

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
