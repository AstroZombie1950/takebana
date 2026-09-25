// Общее для всех вкладок панели: права, пагинация, как выглядит человек
// в списке.
//
// Права здесь двухуровневые и это не формальность. Модератор разбирает жалобы
// и людей — ему нужны имена и поведение. Журнал действий, ошибки, расходы
// и система — только администратору: там лежат адреса, почты и внутренности
// сервера, и раздавать их тому, кто пришёл закрыть три жалобы, незачем.

const { requireAdmin, requireModerator } = require('../../middleware/auth');
const userView = require('../../utils/userView');
const { audit } = require('../../utils/audit');

// Размер страницы приходит из запроса, поэтому у него есть потолок: без него
// perPage=100000 выгружает коллекцию целиком одним запросом.
const PER_PAGE_MAX = 100;
const PER_PAGE_DEFAULT = 25;
// Потолок выгрузки: полгода журнала в один ответ не помещается ни у нас,
// ни у того, кто его откроет.
const CSV_LIMIT = 5000;

function paging(req) {
  // Выгрузка идёт тем же загрузчиком, что и список, но одной «страницей»
  // с собственным потолком (csvRoute ниже).
  if (req.csv) return { page: 1, perPage: CSV_LIMIT, skip: 0 };
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(PER_PAGE_MAX, Math.max(1, Number(req.query.perPage) || PER_PAGE_DEFAULT));
  return { page, perPage, skip: (page - 1) * perPage };
}

// Ответ списка всегда одинаков: сама страница и сколько всего. Без total
// в панели нельзя нарисовать ни счётчик, ни последнюю страницу.
function list(items, total, { page, perPage }) {
  return { items, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
}

// Строка поиска уходит в регулярное выражение, поэтому спецсимволы
// экранируются: «(» без этого роняет запрос ошибкой разбора.
function needle(value) {
  const q = typeof value === 'string' ? value.trim() : '';
  return q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
}

// Отрезок времени из запроса: ?from=2026-09-01&to=2026-09-15. Негодная дата
// не должна превращаться в фильтр «за всё время до Invalid Date».
function period(req, field = 'at') {
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  const range = {};
  if (from && !isNaN(from)) range.$gte = from;
  // Дата без времени означает «включительно весь этот день».
  if (to && !isNaN(to)) range.$lte = /T/.test(req.query.to) ? to : new Date(to.getTime() + 86399999);
  return Object.keys(range).length ? { [field]: range } : {};
}

// Человек в списке: имя, а не персональные данные. Почта — только в досье
// и только администратору (people.js): в списках она не нужна никому,
// а панель открыта и модераторам.
function personBrief(user) {
  const displayName = userView.displayName(user);
  return {
    id: String(user._id),
    displayName,
    login: user.login || '',
    nickname: user.nickname || '',
    role: user.role || 'user',
    banned: !!user.banned,
    isOnline: !!user.isOnline,
    lastSeen: user.lastSeen || null,
    avatar: userView.avatarStyle(user, displayName),
    // Даты регистрации в схеме нет, но она есть в самом идентификаторе:
    // первые четыре байта ObjectId — это время создания записи.
    createdAt: user._id.getTimestamp ? user._id.getTimestamp() : null,
  };
}

// Имена сразу к пачке записей: список эфиров, записей или жалоб иначе
// делает по запросу к базе на строку.
async function namesFor(ids) {
  const User = require('../../models/User');
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();

  const users = await User.find({ _id: { $in: unique } })
    .select('nickname login email avatar role banned')
    .lean();

  return new Map(users.map((u) => [String(u._id), personBrief(u)]));
}

// ── Выгрузка CSV ─────────────────────────────────────────────────────────────
//
// Выгрузка вкладки — тот же загрузчик, что у списка, и тот же фильтр из
// адреса: разойдись они, в файле было бы не то, что человек видит на экране.
// Столбцы — пары [заголовок, значение из строки]; функцией, если набор
// зависит от прав.

// Строка, начинающаяся с = + - @ (или с табуляции и перевода строки перед
// ними), — формула для Excel. В выгрузки попадает то, что пишет кто угодно:
// почта неудачного входа, текст ошибки браузера, User-Agent, комментарий
// жалобы. Апостроф впереди делает её текстом. Числа не трогаем: −5 — число.
const cell = (v) => {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && /^\s*[=+\-@]/.test(s)) s = "'" + s;
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// Человек в выгрузке — имя, а не объект со ссылкой на аватар.
const nameOf = (p) => (p ? p.displayName : '');

function sendCsv(req, res, file, head, lines) {
  audit(req, 'admin.export', { meta: { file, rows: lines.length } });

  // Точка с запятой и BOM: иначе Excel открывает кириллицу кракозябрами
  // и сваливает все столбцы в один.
  res
    .type('text/csv; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="takebana-${file}-${new Date().toISOString().slice(0, 10)}.csv"`)
    .send('\uFEFF' + [head.map(cell).join(';'), ...lines.map((l) => l.map(cell).join(';'))].join('\r\n'));
}

function csvRoute(router, path, guard, file, load, columns) {
  router.get(path + '.csv', guard, async (req, res) => {
    req.csv = true;
    const data = await load(req);
    const cols = typeof columns === 'function' ? columns(req) : columns;
    sendCsv(req, res, file, cols.map((c) => c[0]), data.items.map((row) => cols.map((c) => c[1](row))));
  });
}

module.exports = {
  requireAdmin, requireModerator, paging, list, needle, period, personBrief, namesFor,
  csvRoute, sendCsv, nameOf,
};
