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

const HOURS = { type: 'object', json: true, schema: {
    open: { type: 'string', max: 5 },
    close: { type: 'string', max: 5 },
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

module.exports = { HOURS, LOCATION, CITY, TYPE };
