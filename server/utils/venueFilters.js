// Фильтры карты заведений из адресной строки: страница /main (первая
// отрисовка) и /establishmentsLocation (точки на карте).
//
// Адрес приходит откуда угодно, а qs превращает `?city[$ne]=x` в объект.
// Каждое значение сверяется с закрытыми списками config/catalog.js: чужое
// молча отбрасывается, а не уходит в запрос оператором Mongo.
const { CITY_NAME, VENUE_TYPE_NAME } = require('../config/catalog');

function readVenueFilters(query) {
  const types = [].concat(query.type || []).filter((t) => typeof t === 'string' && VENUE_TYPE_NAME[t]);
  return {
    city: typeof query.city === 'string' && CITY_NAME[query.city] ? query.city : '',
    types: [...new Set(types)],
    live: query.live === '1',
  };
}

module.exports = { readVenueFilters };
