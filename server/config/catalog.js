// Темы: разделы и темы внутри них, одни на эфиры и посты (09.10, решение
// заказчика: шире прежних трёх разделов по шесть подтем, чтобы человек
// нашёл свою тему, а не нашёл — выбрал «Другое»). Плюс города эфиров
// и типы заведений.
//
// Один источник для сервера и шаблонов. Раньше подкатегории были выписаны
// трижды — в форме эфира, тегами каталога и подписями карточек, — а сервер
// принимал в category любую строку: демо-эфиры с категорией «Бары» не
// попадали ни в одну вкладку каталога.
//
// i18n — ключ словаря public/tk-i18n-ru.js и tk-i18n-en.js; у раздела ещё
// cat.<код>Title, блок «о разделе» cat.<код>About* и page.<код>.title и
// .description — у каждого раздела своя страница /streaming/<код>.
// Коды разделов entertainment, business, fashion — с 2025 года: их адреса
// в индексе. Коды тем уникальны на весь справочник: тема сама говорит, чей
// она раздел, и фильтр идёт по одному полю. Прежние подтемы переехали
// с кодами (auto — в «Авто и мото», tourism — в «Путешествия»…), эфиры
// и записи переводит в новый раздел utils/topics.js при запуске.
//
// Эфир: раздел обязателен, тема — нет (пусто — «Другое» в разделе).
// Пост: тема по желанию — код темы, код раздела («Другое» в нём) или пусто.

const CATEGORIES = {
  entertainment: {
    name: 'Развлечения', i18n: 'cat.entertainment',
    subs: [
      { code: 'games', name: 'Игры', i18n: 'sub.games' },
      { code: 'music', name: 'Музыка', i18n: 'sub.music' },
      { code: 'movies', name: 'Кино и сериалы', i18n: 'sub.movies' },
      { code: 'podcasts', name: 'Подкасты', i18n: 'sub.podcasts' },
      { code: 'humor', name: 'Юмор', i18n: 'sub.humor' },
      { code: 'books', name: 'Книги', i18n: 'sub.books' },
      { code: 'art', name: 'Искусство', i18n: 'sub.art' },
      { code: 'photo', name: 'Фотография', i18n: 'sub.photo' },
      { code: 'events', name: 'События и вечеринки', i18n: 'sub.events' },
    ],
  },
  family: {
    name: 'Дом и семья', i18n: 'cat.family',
    subs: [
      { code: 'kids', name: 'Дети', i18n: 'sub.kids' },
      { code: 'relationships', name: 'Семья и отношения', i18n: 'sub.relationships' },
      { code: 'pets', name: 'Животные', i18n: 'sub.pets' },
      { code: 'garden', name: 'Сад и огород', i18n: 'sub.garden' },
      { code: 'home', name: 'Дом и интерьер', i18n: 'sub.home' },
      { code: 'diy', name: 'Ремонт и своими руками', i18n: 'sub.diy' },
      { code: 'food', name: 'Еда и кулинария', i18n: 'sub.food' },
    ],
  },
  health: {
    name: 'Здоровье и спорт', i18n: 'cat.health',
    subs: [
      { code: 'sport', name: 'Спорт', i18n: 'sub.sport' },
      { code: 'fitness', name: 'Фитнес', i18n: 'sub.fitness' },
      { code: 'wellness', name: 'Здоровье', i18n: 'sub.wellness' },
      { code: 'psychology', name: 'Психология', i18n: 'sub.psychology' },
      { code: 'yoga', name: 'Йога и медитация', i18n: 'sub.yoga' },
    ],
  },
  fashion: {
    name: 'Мода и красота', i18n: 'cat.fashion',
    subs: [
      { code: 'style', name: 'Стиль и образы', i18n: 'sub.style' },
      { code: 'beauty', name: 'Красота', i18n: 'sub.beauty' },
      { code: 'designers', name: 'Дизайнеры', i18n: 'sub.designers' },
      { code: 'handmade', name: 'Украшения и хендмейд', i18n: 'sub.handmade' },
      { code: 'shows', name: 'Показы', i18n: 'sub.shows' },
      { code: 'vintage', name: 'Винтаж и ресейл', i18n: 'sub.vintage' },
    ],
  },
  travel: {
    name: 'Путешествия', i18n: 'cat.travel',
    subs: [
      { code: 'tourism', name: 'Туризм', i18n: 'sub.tourism' },
      { code: 'outdoors', name: 'Природа и активный отдых', i18n: 'sub.outdoors' },
      { code: 'places', name: 'Города и места', i18n: 'sub.places' },
      { code: 'nightlife', name: 'Рестораны и бары', i18n: 'sub.nightlife' },
    ],
  },
  vehicles: {
    name: 'Авто и мото', i18n: 'cat.vehicles',
    subs: [
      { code: 'auto', name: 'Автомобили', i18n: 'sub.auto' },
      { code: 'moto', name: 'Мотоциклы', i18n: 'sub.moto' },
      { code: 'tuning', name: 'Ремонт и тюнинг', i18n: 'sub.tuning' },
      { code: 'electric', name: 'Электротранспорт', i18n: 'sub.electric' },
    ],
  },
  tech: {
    name: 'Технологии', i18n: 'cat.tech',
    subs: [
      { code: 'gadgets', name: 'Гаджеты', i18n: 'sub.gadgets' },
      { code: 'it', name: 'Программирование и IT', i18n: 'sub.it' },
      { code: 'ai', name: 'Нейросети', i18n: 'sub.ai' },
      { code: 'science', name: 'Наука', i18n: 'sub.science' },
    ],
  },
  business: {
    name: 'Бизнес и работа', i18n: 'cat.business',
    subs: [
      { code: 'real_estate', name: 'Недвижимость', i18n: 'sub.real_estate' },
      { code: 'services', name: 'Услуги', i18n: 'sub.services' },
      { code: 'horeca', name: 'Рестораны и отели', i18n: 'sub.horeca' },
      { code: 'manufacturing', name: 'Производство', i18n: 'sub.manufacturing' },
      { code: 'finance', name: 'Финансы', i18n: 'sub.finance' },
      { code: 'marketing', name: 'Маркетинг', i18n: 'sub.marketing' },
      { code: 'career', name: 'Работа и карьера', i18n: 'sub.career' },
    ],
  },
  learning: {
    name: 'Образование', i18n: 'cat.learning',
    subs: [
      { code: 'education', name: 'Учёба и курсы', i18n: 'sub.education' },
      { code: 'languages', name: 'Языки', i18n: 'sub.languages' },
      { code: 'history', name: 'История', i18n: 'sub.history' },
    ],
  },
};

// Закрытый список, а не свободный ввод: «Белград», «Beograd» и «белград »
// иначе становятся тремя городами, и фильтр находит треть эфиров.
// Стартовый набор — согласовать с заказчиком.
//
// Только эфиры, и с 09.10 выбор скрыт (решение заказчика: список был
// только сербский). У заведений города нет вовсе — страна по адресу
// (utils/places.js).
const CITIES = [
  { code: 'belgrade', name: 'Белград', i18n: 'city.belgrade' },
  { code: 'novi-sad', name: 'Нови-Сад', i18n: 'city.novi-sad' },
  { code: 'nis', name: 'Ниш', i18n: 'city.nis' },
  { code: 'kragujevac', name: 'Крагуевац', i18n: 'city.kragujevac' },
  { code: 'subotica', name: 'Суботица', i18n: 'city.subotica' },
];

// Типы заведений: владелец выбирает тип при регистрации и в настройках,
// по нему фильтрует раздел /venues. Закрытый список — по той же причине,
// что и города выше; своё владелец вписывает в «Другое» (utils/places.js).
const VENUE_TYPES = [
  { code: 'bar', name: 'Бар', i18n: 'venue.bar' },
  { code: 'restaurant', name: 'Ресторан', i18n: 'venue.restaurant' },
  { code: 'cafe', name: 'Кафе', i18n: 'venue.cafe' },
  { code: 'club', name: 'Клуб', i18n: 'venue.club' },
  { code: 'pub', name: 'Паб', i18n: 'venue.pub' },
  { code: 'hookah', name: 'Кальянная', i18n: 'venue.hookah' },
];

// Код темы → код раздела. Коды тем не повторяются между разделами, поэтому
// на общей вкладке фильтр идёт по одному полю.
const SUB_CATEGORY = {};
for (const [cat, { subs }] of Object.entries(CATEGORIES)) {
  for (const s of subs) SUB_CATEGORY[s.code] = cat;
}

const CITY_NAME = Object.fromEntries(CITIES.map((c) => [c.code, c.name]));

// Темы для формы эфира: вторая выпадашка заполняется на клиенте
// при выборе категории. Строка собирается один раз, а не на каждую страницу.
const SUBS_JSON = JSON.stringify(Object.fromEntries(
  Object.entries(CATEGORIES).map(([cat, { subs }]) => [cat, subs.map((s) => [s.code, s.name])])
));

module.exports = { CATEGORIES, CITIES, SUB_CATEGORY, CITY_NAME, SUBS_JSON, VENUE_TYPES };
