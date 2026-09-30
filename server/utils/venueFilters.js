// Фильтры раздела заведений из адресной строки: страница /venues, её
// карточки /venues/cards и точки карты на «О нас» (/establishmentsLocation —
// там нужны только город, тип и «в эфире»).
//
// Адрес приходит откуда угодно, а qs превращает `?city[$ne]=x` в объект.
// Каждое значение сверяется с закрытыми списками config/catalog.js: чужое
// молча отбрасывается, а не уходит в запрос оператором Mongo.
const { CITY_NAME, VENUE_TYPE_NAME } = require('../config/catalog');

// Порядок выдачи: «сначала в эфире» — по умолчанию, в адрес не пишется.
const SORTS = ['live', 'rate', 'name'];

function readVenueFilters(query) {
  const types = [].concat(query.type || []).filter((t) => typeof t === 'string' && VENUE_TYPE_NAME[t]);
  return {
    q: typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '',
    city: typeof query.city === 'string' && CITY_NAME[query.city] ? query.city : '',
    types: [...new Set(types)],
    live: query.live === '1',
    open: query.open === '1',
    sort: SORTS.includes(query.sort) ? query.sort : 'live',
  };
}

module.exports = { readVenueFilters };
