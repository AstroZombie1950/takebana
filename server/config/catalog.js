// Таксономия каталога: категории, подкатегории, города.
//
// Один источник для сервера и шаблонов. Раньше подкатегории были выписаны
// трижды — в форме эфира (tk-app.js), тегами каталога и подписями карточек, —
// а сервер принимал в category любую строку: демо-эфиры с категорией «Бары»
// не попадали ни в одну вкладку каталога.
//
// lng — ключ словаря lang.js там, где он уже был. Новые подписи в словарь
// не добавляются (он уходит на tk-i18n.js), поэтому у HoReCa, «Презентации»
// и городов ключа нет.

const CATEGORIES = {
  entertainment: {
    name: 'Развлечения', lng: '84',
    note: 'Игры, музыка, творчество', noteLng: '157',
    subs: [
      { code: 'podcasts', name: 'Подкасты', lng: '92' },
      { code: 'tourism', name: 'Туризм', lng: '93' },
      { code: 'creative', name: 'Креатив', lng: '94' },
      { code: 'music', name: 'Музыка', lng: '95' },
    ],
  },
  business: {
    name: 'Бизнес', lng: '85',
    note: 'Презентации, обучение', noteLng: '158',
    subs: [
      { code: 'real_estate', name: 'Недвижимость', lng: '96' },
      { code: 'services', name: 'Услуги', lng: '97' },
      { code: 'education', name: 'Образование', lng: '98' },
      { code: 'auto', name: 'Авто', lng: '99' },
      { code: 'horeca', name: 'HoReCa' },
      { code: 'manufacturing', name: 'Производство', lng: '100' },
      { code: 'presentation', name: 'Презентация' },
    ],
  },
};

// Закрытый список, а не свободный ввод: «Белград», «Beograd» и «белград »
// иначе становятся тремя городами, и фильтр находит треть эфиров.
// Стартовый набор — согласовать с заказчиком.
const CITIES = [
  { code: 'belgrade', name: 'Белград' },
  { code: 'novi-sad', name: 'Нови-Сад' },
  { code: 'nis', name: 'Ниш' },
  { code: 'kragujevac', name: 'Крагуевац' },
  { code: 'subotica', name: 'Суботица' },
];

// Типы заведений для карты (/main): владелец выбирает тип при регистрации
// и в настройках, по нему фильтрует карта. Закрытый список — по той же
// причине, что и города.
const VENUE_TYPES = [
  { code: 'bar', name: 'Бар' },
  { code: 'restaurant', name: 'Ресторан' },
  { code: 'cafe', name: 'Кафе' },
  { code: 'club', name: 'Клуб' },
  { code: 'pub', name: 'Паб' },
  { code: 'hookah', name: 'Кальянная' },
];

const VENUE_TYPE_NAME = Object.fromEntries(VENUE_TYPES.map((t) => [t.code, t.name]));

// Код подкатегории → код категории. Коды подкатегорий не повторяются между
// категориями, поэтому на общей вкладке фильтр идёт по одному полю.
const SUB_CATEGORY = {};
for (const [cat, { subs }] of Object.entries(CATEGORIES)) {
  for (const s of subs) SUB_CATEGORY[s.code] = cat;
}

const CITY_NAME = Object.fromEntries(CITIES.map((c) => [c.code, c.name]));

// Подкатегории для формы эфира: вторая выпадашка заполняется на клиенте
// при выборе категории. Строка собирается один раз, а не на каждую страницу.
const SUBS_JSON = JSON.stringify(Object.fromEntries(
  Object.entries(CATEGORIES).map(([cat, { subs }]) => [cat, subs.map((s) => [s.code, s.name])])
));

module.exports = { CATEGORIES, CITIES, SUB_CATEGORY, CITY_NAME, SUBS_JSON, VENUE_TYPES, VENUE_TYPE_NAME };
