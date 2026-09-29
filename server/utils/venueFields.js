// Схемы полей заведения для middleware/validate.
//
// Одно место на три формы: заявка владельца, его настройки и правка из
// админки. Раньше часы и координаты были выписаны в двух роутерах, а город
// с типом — только в establishmentsRouter: админка принимала город свободной
// строкой и не знала про тип, поэтому любая правка оттуда выводила заведение
// из фильтров карты.
//
// `json: true` нужен из-за multipart в настройках владельца — там всё
// приходит строками. На телах JSON это ничего не меняет.

const { CITY_NAME, VENUE_TYPE_NAME } = require('../config/catalog');

// Часы — только «ЧЧ:ММ»: строка уходит в разметку страницы камеры
// подстановкой словаря, а там innerHTML. Прежде проходило любое в пять
// знаков, и «<!--» закомментировал бы остаток страницы.
const TIME = /^\d{2}:\d{2}$/;
const HOURS = { type: 'object', json: true, schema: {
    open: { type: 'string', max: 5, pattern: TIME },
    close: { type: 'string', max: 5, pattern: TIME },
} };

// lat и lng не обязательные: пустое поле формы админки уезжает в JSON как
// null, и это значит «координату не меняем», а не ошибку.
const LOCATION = { type: 'object', json: true, label: 'Координаты', schema: {
    lat: { type: 'number', min: -90, max: 90 },
    lng: { type: 'number', min: -180, max: 180 },
} };

// Город и тип — закрытые списки config/catalog.js: по ним фильтрует карта,
// свободный ввод дал бы «Белград», «Beograd» и «белград » тремя городами.
const CITY = { type: 'string', values: Object.keys(CITY_NAME), label: 'Город' };
const TYPE = { type: 'string', values: Object.keys(VENUE_TYPE_NAME), label: 'Тип заведения' };

// Описание на странице заведения (/venue/:id).
const ABOUT_MAX = 1000;

// ── Черновик правки одобренного заведения (Establishments.pending, 29.09) ──
// Поля черновика — те же, что правит владелец; фото — полный новый список.
const DRAFT_FIELDS = ['name', 'type', 'country', 'city', 'address', 'about', 'weekdayHours', 'weekendHours', 'location', 'photos'];

// Лениво: utils/userDelete тянет за собой камеры и эфиры, а эти схемы
// нужны и формам, которым всё это ни к чему.
const unlink = (url) => require('./userDelete').unlinkUpload(url, 'establishments');

// Отклонить или отозвать: новые фото черновика — с диска, одобренные остаются.
function dropDraft(venue) {
  const live = new Set(venue.photos || []);
  for (const url of (venue.pending && venue.pending.photos) || []) if (!live.has(url)) unlink(url);
}

// Принять: $set для документа; одобренные фото, которых в черновике нет, —
// с диска.
function applyDraft(venue) {
  const p = venue.pending || {};
  const set = {};
  for (const k of DRAFT_FIELDS) if (p[k] !== undefined && p[k] !== null) set[k] = p[k];
  if (set.photos) for (const url of venue.photos || []) if (!set.photos.includes(url)) unlink(url);
  return set;
}

module.exports = { HOURS, LOCATION, CITY, TYPE, ABOUT_MAX, DRAFT_FIELDS, dropDraft, applyDraft };
