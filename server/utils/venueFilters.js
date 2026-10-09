// Фильтры раздела заведений из адресной строки: страница /venues, её
// карточки /venues/cards и точки карты на «О нас» (/establishmentsLocation —
// там нужны только тип и «в эфире»).
//
// Адрес приходит откуда угодно, а qs превращает `?type[$ne]=x` в объект.
// Каждое значение сверяется со справочником (utils/places.js): чужое
// молча отбрасывается, а не уходит в запрос оператором Mongo.
const places = require('./places');

// Порядок выдачи: «сначала в эфире» — по умолчанию, в адрес не пишется.
const SORTS = ['live', 'rate', 'name'];

function readVenueFilters(query) {
  const types = [].concat(query.type || []).filter((t) => places.find('type', t));
  // Фильтра по городу с 09.10 нет: у заведений нет города (utils/places.js).
  return {
    q: typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '',
    country: places.find('country', query.country) ? query.country : '',
    types: [...new Set(types)],
    live: query.live === '1',
    open: query.open === '1',
    sort: SORTS.includes(query.sort) ? query.sort : 'live',
  };
}

module.exports = { readVenueFilters };
