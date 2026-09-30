// Таксономия каталога: категории, подкатегории, города.
//
// Один источник для сервера и шаблонов. Раньше подкатегории были выписаны
// трижды — в форме эфира (tk-app.js), тегами каталога и подписями карточек, —
// а сервер принимал в category любую строку: демо-эфиры с категорией «Бары»
// не попадали ни в одну вкладку каталога.
//
// i18n — ключ словаря public/tk-i18n-ru.js и tk-i18n-en.js. Прежде здесь
// стояли числовые ключи старого lang.js, и у HoReCa с «Презентацией» ключа
// не было вовсе: в словарь их не добавляли, потому что он уходил. Теперь
// словарь один, ключи у всех.
// По шесть подкатегорий в разделе (решение 21.09.2026): «Креатив» убран —
// размыт и пересекался с «Модой»; «Презентация» — это формат, а не тема;
// HoReCa названа по-человечески, код остался прежним.
// У городов ключи тоже есть: в фильтрах и формах их подписи переводятся,
// в данных заведений и эфиров остаётся код.

const CATEGORIES = {
  entertainment: {
    name: 'Развлечения', i18n: 'cat.entertainment',
    note: 'Игры, музыка, спорт', noteI18n: 'cat.entertainmentNote',
    subs: [
      { code: 'games', name: 'Игры', i18n: 'sub.games' },
      { code: 'music', name: 'Музыка', i18n: 'sub.music' },
      { code: 'podcasts', name: 'Подкасты', i18n: 'sub.podcasts' },
      { code: 'tourism', name: 'Туризм', i18n: 'sub.tourism' },
      { code: 'sport', name: 'Спорт', i18n: 'sub.sport' },
      { code: 'food', name: 'Еда и напитки', i18n: 'sub.food' },
    ],
  },
  business: {
    name: 'Бизнес', i18n: 'cat.business',
    note: 'Недвижимость, услуги, обучение', noteI18n: 'cat.businessNote',
    subs: [
      { code: 'real_estate', name: 'Недвижимость', i18n: 'sub.real_estate' },
      { code: 'services', name: 'Услуги', i18n: 'sub.services' },
      { code: 'education', name: 'Образование', i18n: 'sub.education' },
      { code: 'auto', name: 'Авто', i18n: 'sub.auto' },
      { code: 'horeca', name: 'Рестораны и отели', i18n: 'sub.horeca' },
      { code: 'manufacturing', name: 'Производство', i18n: 'sub.manufacturing' },
    ],
  },
  fashion: {
    name: 'Мода', i18n: 'cat.fashion',
    note: 'Дизайн, стиль, красота', noteI18n: 'cat.fashionNote',
    subs: [
      { code: 'designers', name: 'Дизайнеры', i18n: 'sub.designers' },
      { code: 'style', name: 'Стиль и образы', i18n: 'sub.style' },
      { code: 'beauty', name: 'Красота', i18n: 'sub.beauty' },
      { code: 'handmade', name: 'Украшения и хендмейд', i18n: 'sub.handmade' },
      { code: 'shows', name: 'Показы', i18n: 'sub.shows' },
      { code: 'vintage', name: 'Винтаж и ресейл', i18n: 'sub.vintage' },
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
//
// Эфиры берут город только отсюда. У заведений список длиннее: страна,
// города по странам и то, что панель добавила из заявок (utils/places.js).
const CITIES = [
  { code: 'belgrade', name: 'Белград', i18n: 'city.belgrade', country: 'rs', center: [20.4612, 44.8125] },
  { code: 'novi-sad', name: 'Нови-Сад', i18n: 'city.novi-sad', country: 'rs', center: [19.8335, 45.2671] },
  { code: 'nis', name: 'Ниш', i18n: 'city.nis', country: 'rs', center: [21.8958, 43.3209] },
  { code: 'kragujevac', name: 'Крагуевац', i18n: 'city.kragujevac', country: 'rs', center: [20.9114, 44.0142] },
  { code: 'subotica', name: 'Суботица', i18n: 'city.subotica', country: 'rs', center: [19.6650, 46.1001] },
];

// Страны заведений (30.09) — короткий стартовый список вокруг Сербии; чего
// нет, владелец вписывает сам, а панель добавляет (utils/places.js). Код —
// ISO 3166-1, center — столица: с неё открывается выбор точки, пока город
// не выбран.
const COUNTRIES = [
  { code: 'rs', name: 'Сербия', i18n: 'country.rs', center: [20.4612, 44.8125] },
  { code: 'me', name: 'Черногория', i18n: 'country.me', center: [19.2594, 42.4304] },
  { code: 'hr', name: 'Хорватия', i18n: 'country.hr', center: [15.9819, 45.8150] },
  { code: 'ba', name: 'Босния и Герцеговина', i18n: 'country.ba', center: [18.4131, 43.8563] },
  { code: 'mk', name: 'Северная Македония', i18n: 'country.mk', center: [21.4254, 41.9981] },
  { code: 'si', name: 'Словения', i18n: 'country.si', center: [14.5058, 46.0569] },
  { code: 'hu', name: 'Венгрия', i18n: 'country.hu', center: [19.0402, 47.4979] },
  { code: 'ro', name: 'Румыния', i18n: 'country.ro', center: [26.1025, 44.4268] },
  { code: 'bg', name: 'Болгария', i18n: 'country.bg', center: [23.3219, 42.6977] },
  { code: 'gr', name: 'Греция', i18n: 'country.gr', center: [23.7275, 37.9838] },
];

// Типы заведений: владелец выбирает тип при регистрации и в настройках,
// по нему фильтрует раздел /venues. Закрытый список — по той же причине,
// что и города; своё владелец вписывает в «Другое» (utils/places.js).
const VENUE_TYPES = [
  { code: 'bar', name: 'Бар', i18n: 'venue.bar' },
  { code: 'restaurant', name: 'Ресторан', i18n: 'venue.restaurant' },
  { code: 'cafe', name: 'Кафе', i18n: 'venue.cafe' },
  { code: 'club', name: 'Клуб', i18n: 'venue.club' },
  { code: 'pub', name: 'Паб', i18n: 'venue.pub' },
  { code: 'hookah', name: 'Кальянная', i18n: 'venue.hookah' },
];

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

module.exports = { CATEGORIES, CITIES, COUNTRIES, SUB_CATEGORY, CITY_NAME, SUBS_JSON, VENUE_TYPES };
