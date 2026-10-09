// Темы эфиров и постов (config/catalog.js, 09.10): проверка кода и перенос
// старых эфиров и записей в новые разделы.
//
// Тема поста — код темы, код раздела («Другое» в нём) или пусто («без
// темы»). Фильтр «Ленты» по разделу берёт и сам раздел, и все его темы.

const { CATEGORIES, SUB_CATEGORY } = require('../config/catalog');
const errorLog = require('./errorLog');

// Код годится в тему поста: тема или раздел.
const valid = (code) => typeof code === 'string' && (!!SUB_CATEGORY[code] || !!CATEGORIES[code]);

// Раздел темы (у раздела — он сам), '' — не тема.
const sectionOf = (code) => (CATEGORIES[code] ? code : SUB_CATEGORY[code] || '');

// Что искать в базе по фильтру: раздел — он и все его темы, тема — она.
function matching(code) {
  if (CATEGORIES[code]) return [code, ...CATEGORIES[code].subs.map((s) => s.code)];
  return SUB_CATEGORY[code] ? [code] : null;
}

// Ключ словаря подписи: раздел — cat.<код>, тема — sub.<код>.
const i18nOf = (code) => (CATEGORIES[code] ? CATEGORIES[code].i18n : SUB_CATEGORY[code] ? 'sub.' + code : '');

// Подтемы, переехавшие 09.10 в другие разделы с прежними кодами (auto —
// в «Авто и мото», tourism — в «Путешествия», sport — в «Здоровье и спорт»…):
// эфир, запись, отрезок и «настройки по умолчанию» студии — в раздел своей
// темы. Перенесённое второй раз не находится.
async function migrate() {
  const models = ['Stream', 'Recording', 'StreamSession'].map((m) => require('../models/' + m));
  const User = require('../models/User');
  for (const [sub, cat] of Object.entries(SUB_CATEGORY)) {
    for (const Model of models) await Model.updateMany({ subcategory: sub, category: { $ne: cat } }, { $set: { category: cat } });
    await User.updateMany({ 'streamDefaults.subcategory': sub, 'streamDefaults.category': { $ne: cat } }, { $set: { 'streamDefaults.category': cat } });
  }
}

function start() {
  migrate().catch((e) => errorLog.server(e, 'topics.migrate'));
}

module.exports = { valid, sectionOf, matching, i18nOf, start };
