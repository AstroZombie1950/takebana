// Справочник заведений: страны и типы (30.09; с 09.10 — без городов).
//
// Страна — код ISO 3166-1 (`rs`), любая на свете: её не выбирают, она
// приходит из поиска адреса (utils/geocode.js) вместе с точкой. Имена —
// из Intl.DisplayNames на языке страницы; в разметке у имени
// data-i18n-region, и переключение языка без перезагрузки его переводит
// (public/tk-i18n.js). Город не спрашиваем и не показываем (решение
// заказчика 09.10): он и так в адресе, а закрытый список городов был только
// сербский. Прежние city и cityOther остаются в базе как есть.
//
// Тип — из config/catalog.js, с ключами словаря. Всего не предугадать,
// поэтому первым пунктом «Другое — ввести самому»: своё ложится в заведение
// текстом (typeOther) и в список не попадает, пока панель не решит его
// добавить (routes/admin/venues.js). Иначе список разрастался бы сам — «Бар»,
// «бар», «Bar» и «бар-кафе» строчками рядом. Добавленное лежит в базе
// (models/Place.js) и держится здесь в памяти: процесс один
// (ops/ecosystem.config.js), а спрашивают справочник на каждую карточку.
// Так же панель может взять в список страну, вписанную владельцем до 09.10
// (countryOther), — новых таких не бывает.

const { escapeXML } = require('ejs');
const { VENUE_TYPES } = require('../config/catalog');
const Place = require('../models/Place');
const { text } = require('./i18n');
const errorLog = require('./errorLog');

const KINDS = ['country', 'type'];
let added = { country: [], type: [] };

// Своё, вписанное владельцем: одной строкой, без лишних пробелов.
const OTHER_MAX = 60;
const clean = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, OTHER_MAX) : '');

// Страны — все двухбуквенные коды, у которых Intl знает имя, кроме
// объединений и служебных («Евросоюз», «ООН», «Неизвестный регион»).
const REGION = {
  ru: new Intl.DisplayNames(['ru'], { type: 'region', fallback: 'none' }),
  en: new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }),
};
const NOT_COUNTRY = new Set(['EU', 'EZ', 'QO', 'UN', 'XA', 'XB', 'ZZ']);
const COUNTRIES = [];
for (let a = 65; a < 91; a++) {
  for (let b = 65; b < 91; b++) {
    const c = String.fromCharCode(a, b);
    if (!NOT_COUNTRY.has(c) && REGION.en.of(c)) COUNTRIES.push({ code: c.toLowerCase(), region: c });
  }
}

const BASE = { country: COUNTRIES, type: VENUE_TYPES };
const all = (kind) => BASE[kind].concat(added[kind]);
const find = (kind, code) => (typeof code === 'string' && code && BASE[kind] ? all(kind).find((x) => x.code === code) || null : null);
const L = (lang) => (lang === 'en' ? 'en' : 'ru');

// Подпись на языке страницы. У страны — имя из Intl, у типа — строка
// словаря, у добавленного панелью — оба имени, их вписала она.
function name(kind, code, lang) {
  const x = find(kind, code);
  if (!x) return '';
  if (x.region) return REGION[L(lang)].of(x.region);
  return x.i18n ? text(lang, x.i18n, x.name) : x.names[L(lang)] || x.names.ru;
}

// Подпись разметкой для шаблонов (placeHtml в app.js): у основы — с ключом
// словаря или кодом страны, чтобы переключение языка без перезагрузки её
// перевело. Добавленное панелью и своё владельца — данные, а не строки
// словаря (data-user-content): первое уже на языке страницы, второе — текст
// владельца как есть.
function html(kind, code, other, lang) {
  const x = find(kind, code);
  if (x && x.region) return '<span data-i18n-region="' + x.region + '">' + escapeXML(name(kind, code, lang)) + '</span>';
  if (x && x.i18n) return '<span data-i18n="' + x.i18n + '">' + escapeXML(name(kind, code, lang)) + '</span>';
  const s = x ? name(kind, code, lang) : other;
  return s ? '<span data-user-content>' + escapeXML(s) + '</span>' : '';
}

// Подпись текстом — для описаний страницы и атрибутов.
const label = (kind, code, other, lang) => name(kind, code, lang) || other || '';

// Пункты выпадашки: { code, i18n, region, text }. Страны — по алфавиту языка.
function options(kind, lang) {
  const list = all(kind).map((x) => ({ code: x.code, i18n: x.i18n || '', region: x.region || '', text: name(kind, x.code, lang) }));
  return kind === 'country' ? list.sort((a, b) => a.text.localeCompare(b.text, L(lang))) : list;
}

// Тип и страна из формы — заявки, правки владельца, панели. Тип — код из
// списка или своё текстом, одно из двух. Страна — код из поиска адреса;
// не нашлась (поиск лежал, метку ставили рукой) — пусто: заведение живёт
// и без неё, только в фильтр по стране не попадает. Своё текстом —
// только у заведений до 09.10, его присылает одна панель.
// → { fields } с обеими половинами (ненужная — пустой строкой: правка
// должна стирать прежнее «своё») или { error }.
function pick(body) {
  const out = {};
  if (find('type', body.type)) Object.assign(out, { type: body.type, typeOther: '' });
  else if (clean(body.typeOther)) Object.assign(out, { type: '', typeOther: clean(body.typeOther) });
  else return { error: 'Укажите тип заведения' };

  if (find('country', body.country)) Object.assign(out, { country: body.country, countryOther: '' });
  else Object.assign(out, { country: '', countryOther: clean(body.countryOther) });
  return { fields: out };
}

// ── Добавленное панелью ──

async function load() {
  const rows = await Place.find({ kind: { $in: KINDS } }).sort({ 'name.ru': 1 }).lean();
  const next = { country: [], type: [] };
  for (const r of rows) next[r.kind].push({ code: r.code, names: r.name });
  added = next;
}

// Код — из английского имени: он виден в адресе фильтра (?type=wine-bar).
// Кириллица в английском имени — случайный код, но свой.
function codeFor(kind, en) {
  const base = String(en).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x' + Date.now().toString(36);
  let code = base;
  for (let i = 2; find(kind, code); i++) code = base + '-' + i;
  return code;
}

// Взять в общий список: { ru, en }. Такое имя уже есть (на любом языке,
// без учёта регистра) — отдаём его, второго не заводим. У страны так
// находится и код ISO: «Сербия» → rs.
async function add(kind, { ru, en }) {
  ru = clean(ru);
  en = clean(en) || ru;
  const same = (s) => !!s && (s.toLowerCase() === ru.toLowerCase() || s.toLowerCase() === en.toLowerCase());
  const had = all(kind).find((x) => same(name(kind, x.code, 'ru')) || same(name(kind, x.code, 'en')));
  if (had) return had.code;
  const code = codeFor(kind, en);
  await Place.create({ kind, code, name: { ru, en } });
  await load();
  return code;
}

// Своё владельцев с тем же текстом становится пунктом списка — у всех
// заведений разом и в их правках на проверке.
async function adopt(kind, code, other) {
  const Establishments = require('../models/Establishments');
  const rx = new RegExp('^' + other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  const at = (prefix) => ({
    filter: { [prefix + kind + 'Other']: rx },
    update: { $set: { [prefix + kind]: code, [prefix + kind + 'Other']: '' } },
  });
  const [live, draft] = [at(''), at('pending.')];
  const r = await Establishments.updateMany(live.filter, live.update);
  await Establishments.updateMany(draft.filter, draft.update);
  return r.modifiedCount;
}

// При запуске: добавленное панелью — в память.
function start() {
  load().catch((e) => errorLog.server(e, 'places.start'));
}

module.exports = { KINDS, OTHER_MAX, find, name, html, label, options, pick, add, adopt, start };
