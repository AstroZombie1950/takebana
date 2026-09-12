// Таксономия каталога: категории, подкатегории, города.
//
// Один источник для сервера и шаблонов. Раньше подкатегории были выписаны
// трижды — в форме эфира (tk-app.js), тегами каталога и подписями карточек, —
// а сервер принимал в category любую строку: демо-эфиры с категорией «Бары»
// не попадали ни в одну вкладку каталога.
//
// i18n — ключ словаря public/tk-i18n.js. Прежде здесь стояли числовые ключи
// старого lang.js, и у HoReCa с «Презентацией» ключа не было вовсе: в словарь
// их не добавляли, потому что он уходил. Теперь словарь один, ключи у всех.
// У городов ключи тоже есть: в фильтрах и формах их подписи переводятся,
// в данных заведений и эфиров остаётся код.

const CATEGORIES = {
  entertainment: {
    name: 'Развлечения', i18n: 'cat.entertainment',
    note: 'Игры, музыка, творчество', noteI18n: 'cat.entertainmentNote',
    subs: [
      { code: 'podcasts', name: 'Подкасты', i18n: 'sub.podcasts' },
      { code: 'tourism', name: 'Туризм', i18n: 'sub.tourism' },
      { code: 'creative', name: 'Креатив', i18n: 'sub.creative' },
      { code: 'music', name: 'Музыка', i18n: 'sub.music' },
    ],
  },
  business: {
    name: 'Бизнес', i18n: 'cat.business',
    note: 'Презентации, обучение', noteI18n: 'cat.businessNote',
    subs: [
      { code: 'real_estate', name: 'Недвижимость', i18n: 'sub.real_estate' },
      { code: 'services', name: 'Услуги', i18n: 'sub.services' },
      { code: 'education', name: 'Образование', i18n: 'sub.education' },
      { code: 'auto', name: 'Авто', i18n: 'sub.auto' },
      { code: 'horeca', name: 'HoReCa', i18n: 'sub.horeca' },
      { code: 'manufacturing', name: 'Производство', i18n: 'sub.manufacturing' },
      { code: 'presentation', name: 'Презентация', i18n: 'sub.presentation' },
    ],
  },
};

// Закрытый список, а не свободный ввод: «Белград», «Beograd» и «белград »
// иначе становятся тремя городами, и фильтр находит треть эфиров.
// Стартовый набор — согласовать с заказчиком.
//
// center — [долгота, широта] центра города: с него открывается карта, когда
// владелец ставит точку заведения (public/tk-point.js). Без этого выбор точки
// начинался бы с Белграда для всех или с пустого места.
const CITIES = [
  { code: 'belgrade', name: 'Белград', i18n: 'city.belgrade', center: [20.4612, 44.8125] },
  { code: 'novi-sad', name: 'Нови-Сад', i18n: 'city.novi-sad', center: [19.8335, 45.2671] },
  { code: 'nis', name: 'Ниш', i18n: 'city.nis', center: [21.8958, 43.3209] },
  { code: 'kragujevac', name: 'Крагуевац', i18n: 'city.kragujevac', center: [20.9114, 44.0142] },
  { code: 'subotica', name: 'Суботица', i18n: 'city.subotica', center: [19.6650, 46.1001] },
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
const CITY_CENTER = Object.fromEntries(CITIES.map((c) => [c.code, c.center]));

// Подкатегории для формы эфира: вторая выпадашка заполняется на клиенте
// при выборе категории. Строка собирается один раз, а не на каждую страницу.
const SUBS_JSON = JSON.stringify(Object.fromEntries(
  Object.entries(CATEGORIES).map(([cat, { subs }]) => [cat, subs.map((s) => [s.code, s.name])])
));

module.exports = { CATEGORIES, CITIES, SUB_CATEGORY, CITY_NAME, CITY_CENTER, SUBS_JSON, VENUE_TYPES, VENUE_TYPE_NAME };
