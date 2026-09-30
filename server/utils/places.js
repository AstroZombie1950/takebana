// Справочник заведений: страны, города по странам, типы (30.09).
//
// Основа — config/catalog.js, с ключами словаря. Всего не предугадать,
// поэтому в заявке у каждого списка первым пунктом «Другое — ввести самому»:
// своё ложится в заведение текстом (typeOther, countryOther, cityOther),
// а в список не попадает, пока панель не решит его добавить
// (routes/admin/venues.js). Иначе список разрастался бы сам — «Бар»,
// «бар», «Bar» и «бар-кафе» строчками рядом. Добавленное лежит в базе
// (models/Place.js) и держится здесь в памяти: процесс один (ops/ecosystem.config.js),
// а спрашивают справочник на каждую карточку.
//
// Эфиры по-прежнему берут город из catalog.CITIES: их фильтр — другой разговор.

const { escapeXML } = require('ejs');
const { COUNTRIES, CITIES, VENUE_TYPES } = require('../config/catalog');
const Place = require('../models/Place');
const { text } = require('./i18n');
const errorLog = require('./errorLog');

const KINDS = ['country', 'city', 'type'];
const BASE = { country: COUNTRIES, city: CITIES, type: VENUE_TYPES };
let added = { country: [], city: [], type: [] };

// Своё, вписанное владельцем: одной строкой, без лишних пробелов.
const OTHER_MAX = 60;
const clean = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, OTHER_MAX) : '');

const all = (kind) => BASE[kind].concat(added[kind]);
const find = (kind, code) => (typeof code === 'string' && code ? all(kind).find((x) => x.code === code) || null : null);

// Подпись на языке страницы. У основы — строка словаря, у добавленного —
// оба имени, их вписала панель.
function name(kind, code, lang) {
  const x = find(kind, code);
  if (!x) return '';
  return x.i18n ? text(lang, x.i18n, x.name) : x.names[lang === 'en' ? 'en' : 'ru'] || x.names.ru;
}

// Подпись разметкой для шаблонов (placeHtml в app.js): у основы — с ключом
// словаря, чтобы переключение языка без перезагрузки её перевело. Добавленное
// панелью и своё владельца — данные, а не строки словаря (data-user-content):
// первое уже на языке страницы, второе — текст владельца как есть.
function html(kind, code, other, lang) {
  const x = find(kind, code);
  if (x && x.i18n) return '<span data-i18n="' + x.i18n + '">' + escapeXML(name(kind, code, lang)) + '</span>';
  const s = x ? name(kind, code, lang) : other;
  return s ? '<span data-user-content>' + escapeXML(s) + '</span>' : '';
}

// Подпись текстом — для описаний страницы и атрибутов.
const label = (kind, code, other, lang) => name(kind, code, lang) || other || '';

// Пункты выпадашки: { code, i18n, text }. У города — только своей страны.
function options(kind, lang, country) {
  return all(kind)
    .filter((x) => kind !== 'city' || !country || x.country === country)
    .map((x) => ({ code: x.code, i18n: x.i18n || '', text: name(kind, x.code, lang), country: x.country || '' }));
}

const cityOf = (code) => find('city', code);

// Центры для выбора точки (public/tk-point.js): городов и стран.
function centers() {
  const pick = (list) => Object.fromEntries(list.filter((x) => x.center).map((x) => [x.code, x.center]));
  return { city: pick(all('city')), country: pick(all('country')) };
}

// Тип, страна и город из формы — заявки, правки владельца: код из списка
// или своё текстом, одно из двух. Город из списка — только своей страны.
// → { fields } с обеими половинами (ненужная — пустой строкой: правка
// должна стирать прежнее «своё») или { error }.
function pick(body) {
  const out = {};
  if (find('type', body.type)) Object.assign(out, { type: body.type, typeOther: '' });
  else if (clean(body.typeOther)) Object.assign(out, { type: '', typeOther: clean(body.typeOther) });
  else return { error: 'Укажите тип заведения' };

  if (find('country', body.country)) Object.assign(out, { country: body.country, countryOther: '' });
  else if (clean(body.countryOther)) Object.assign(out, { country: '', countryOther: clean(body.countryOther) });
  else return { error: 'Укажите страну' };

  const city = cityOf(body.city);
  if (city && out.country && city.country === out.country) Object.assign(out, { city: body.city, cityOther: '' });
  else if (clean(body.cityOther)) Object.assign(out, { city: '', cityOther: clean(body.cityOther) });
  else return { error: 'Укажите город' };
  return { fields: out };
}

// ── Добавленное панелью ──

async function load() {
  const rows = await Place.find().sort({ 'name.ru': 1 }).lean();
  const next = { country: [], city: [], type: [] };
  for (const r of rows) next[r.kind].push({ code: r.code, names: r.name, country: r.country || '', center: r.center && r.center.length === 2 ? r.center : null });
  added = next;
}

// Код — из английского имени: он виден в адресе фильтра (?city=podgorica).
// Кириллица в английском имени — случайный код, но свой.
function codeFor(kind, en) {
  const base = String(en).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x' + Date.now().toString(36);
  let code = base;
  for (let i = 2; find(kind, code); i++) code = base + '-' + i;
  return code;
}

// Взять в общий список: { ru, en, country, center }. Такое имя уже есть
// (на любом языке, без учёта регистра) — отдаём его, второго не заводим.
async function add(kind, { ru, en, country, center }) {
  ru = clean(ru);
  en = clean(en) || ru;
  const same = (s) => s.toLowerCase() === ru.toLowerCase() || s.toLowerCase() === en.toLowerCase();
  const had = all(kind).find((x) => (kind !== 'city' || x.country === country) &&
    (x.i18n ? same(text('ru', x.i18n, x.name)) || same(text('en', x.i18n, x.name)) : same(x.names.ru) || same(x.names.en)));
  if (had) return had.code;
  const code = codeFor(kind, en);
  await Place.create({ kind, code, name: { ru, en }, ...(kind === 'city' ? { country, center: center || undefined } : {}) });
  await load();
  return code;
}

// Своё владельцев с тем же текстом становится пунктом списка — у всех
// заведений разом и в их правках на проверке.
async function adopt(kind, code, other, country) {
  const Establishments = require('../models/Establishments');
  const rx = new RegExp('^' + other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  const at = (prefix) => ({
    filter: { [prefix + kind + 'Other']: rx, ...(kind === 'city' ? { [prefix + 'country']: country } : {}) },
    update: { $set: { [prefix + kind]: code, [prefix + kind + 'Other']: '' } },
  });
  const [live, draft] = [at(''), at('pending.')];
  const r = await Establishments.updateMany(live.filter, live.update);
  await Establishments.updateMany(draft.filter, draft.update);
  return r.modifiedCount;
}

// ── Заведения до 30.09 ──
// Страна была свободной строкой («Сербия»), город и тип — кодами основы.
// При запуске: страна — кодом по имени или по городу, чего не узнали —
// в «своё». То же у правок на проверке. Второй раз искать нечего — один запрос.
function known(s) {
  const v = clean(s).toLowerCase();
  if (!v) return '';
  const hit = COUNTRIES.find((c) => [c.name, text('en', c.i18n, c.name)].some((n) => n.toLowerCase() === v));
  return hit ? hit.code : ({ srbija: 'rs', 'србија': 'rs', 'crna gora': 'me', hrvatska: 'hr' })[v] || '';
}

function upgrade(doc) {
  const set = {};
  if (doc.country && !find('country', doc.country)) {
    const code = known(doc.country) || (cityOf(doc.city) && cityOf(doc.city).country) || '';
    Object.assign(set, code ? { country: code } : { country: '', countryOther: clean(doc.country) });
  }
  if (!doc.country && !doc.countryOther && cityOf(doc.city)) set.country = cityOf(doc.city).country;
  if (doc.type && !find('type', doc.type)) Object.assign(set, { type: '', typeOther: clean(doc.type) });
  if (doc.city && !cityOf(doc.city)) Object.assign(set, { city: '', cityOther: clean(doc.city) });
  return set;
}

async function migrate() {
  const Establishments = require('../models/Establishments');
  const codes = (kind) => all(kind).map((x) => x.code);
  const odd = (p) => ({ $or: [
    { [p + 'country']: { $nin: [...codes('country'), '', null] } },
    { [p + 'type']: { $nin: [...codes('type'), '', null] } },
    { [p + 'city']: { $nin: [...codes('city'), '', null] } },
  ] });
  const venues = await Establishments.find({ $or: [odd(''), { 'pending.at': { $exists: true }, ...odd('pending.') }] })
    .select('country countryOther type city pending').lean();
  for (const v of venues) {
    const set = upgrade(v);
    if (v.pending && v.pending.at) for (const [k, val] of Object.entries(upgrade(v.pending))) set['pending.' + k] = val;
    if (Object.keys(set).length) await Establishments.updateOne({ _id: v._id }, { $set: set });
  }
}

// При запуске: добавленное панелью — в память, старые заведения — к кодам.
function start() {
  load().then(migrate).catch((e) => errorLog.server(e, 'places.start'));
}

module.exports = { KINDS, OTHER_MAX, find, cityOf, name, html, label, options, centers, pick, add, adopt, start };
