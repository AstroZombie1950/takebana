// Поиск по сайту — одно место для всех видов: люди, эфиры, записи, видео
// галерей, заведения. Отсюда берут и быстрая выпадашка в шапке (/api/search),
// и полная страница результатов (/search): иначе выдача в них разошлась бы.
//
// С 28.09.2026 (просьба заказчика) ищем не только по именам: людей — и по
// описанию профиля («производство мебели» находит мебельщика, у которого
// это написано в «О себе»), видео галерей — по названию и описанию,
// заведения — ещё по типу и городу словами («кафе», «Белград»).
//
// Ищем подстрокой, регулярным выражением по полям. Индекса под это нет и пока
// не нужно: эфиров и записей десятки, заведений сотни. Когда станет тесно,
// менять — здесь, а не в двух маршрутах.

const User = require('../models/User');
const Stream = require('../models/Stream');
const Recording = require('../models/Recording');
const GalleryVideo = require('../models/GalleryVideo');
const Establishments = require('../models/Establishments');
const Subscription = require('../models/Subscription');
const userView = require('./userView');
const privacy = require('./privacy');
const { profileUrl } = require('./profileUrl');
const { VENUE_TYPES, CITIES } = require('../config/catalog');
const { text } = require('./i18n');

const TYPES = ['people', 'streams', 'recordings', 'videos', 'venues'];

// Строка от посетителя — текст, а не регулярное выражение: без экранирования
// «(a+)+$» вешает процесс откатом, а «.*» находит всё подряд.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Запрос короче двух символов ищет пол-базы и ничего не значит.
const MIN_QUERY = 2;

function normalize(raw) {
  const q = typeof raw === 'string' ? raw.trim().slice(0, 100) : '';
  return q.length >= MIN_QUERY ? q : '';
}

// Люди ищутся по нику (его видно везде, utils/userView.js), по имени и по
// описанию профиля, а у кого нет ни ника, ни имени — по началу почты до «@».
// По всей почте не ищем: запрос «gmail» выдавал бы список людей, а по выдаче
// проверялся бы чужой адрес.
// Кто скрылся из поиска (utils/privacy.js), не находится вовсе.
function peopleWhere(query) {
  const rx = new RegExp(escapeRegex(query), 'i');
  const where = [{ nickname: rx }, { login: rx }, { bio: rx }];
  if (!query.includes('@')) {
    where.push({ login: { $in: ['', null] }, email: new RegExp('^[^@]*' + escapeRegex(query), 'i') });
  }
  return { $or: where, ...privacy.SEARCHABLE };
}

// Эфиры — только идущие: черновик не открыть, а в выдаче он выглядел бы
// живым. Записи — только готовые: недосклеенную видит лишь автор.
const streamsWhere = (rx) => ({ isActive: true, $or: [{ title: rx }, { description: rx }] });
const recordingsWhere = (rx) => ({ status: 'ready', $or: [{ title: rx }, { description: rx }] });
const videosWhere = (rx) => ({ status: 'ready', $or: [{ title: rx }, { description: rx }] });

// Тип и город заведения лежат кодами (config/catalog.js), а ищут их словом
// на любом из двух языков: «кафе» и «cafe» находят code: 'cafe'.
const named = (list, rx, key) => list
  .filter((x) => rx.test(x.name) || rx.test(text('en', key(x.code))))
  .map((x) => x.code);

function venuesWhere(rx) {
  const or = [{ name: rx }, { address: rx }];
  const types = named(VENUE_TYPES, rx, (c) => 'venue.' + c);
  const cities = named(CITIES, rx, (c) => 'city.' + c);
  if (types.length) or.push({ type: { $in: types } });
  if (cities.length) or.push({ city: { $in: cities } });
  return { status: true, $or: or };
}

function authorOf(doc) {
  const user = doc.userId;
  if (!user) return null; // автора удалили — карточка без него бессмысленна
  const displayName = userView.displayName(user);
  return { _id: user._id, url: profileUrl(user), displayName, avatarStyle: userView.avatarStyle(user, displayName) };
}

// Сколько подходящих смотрим, прежде чем выбрать лучшие. Раньше выборка
// обрывалась на limit сразу в базе, без сортировки, — то есть выпадашка
// показывала три случайных из всех совпавших. Набрал человек «ан» — в трёх
// строках «Анастасия», «Андрей» и «Иван», а нужный Антон, который нашёлся бы
// при полностью набранном нике, не попадал никуда. Это и есть «не находит,
// если не до конца набрать имя».
const POOL = 200;

// Чем ответ ближе к запросу, тем выше: точное совпадение, потом начало
// имени, потом середина, последними — нашедшиеся только по описанию.
// Внутри ступени — кто на связи и у кого имя короче (в коротком запрос
// занимает большую часть — значит, попал точнее).
function rankPeople(users, query) {
  const q = query.toLowerCase();
  const rank = (user) => {
    const names = [user.nickname, user.login, (user.email || '').split('@')[0]]
      .filter(Boolean).map((n) => n.toLowerCase());
    if (names.some((n) => n === q)) return 0;
    if (names.some((n) => n.startsWith(q))) return 1;
    if (names.some((n) => n.includes(q))) return 2;
    return 3;
  };
  return users
    .map((user) => ({ user, r: rank(user), len: userView.displayName(user).length }))
    .sort((a, b) => a.r - b.r || (b.user.isOnline ? 1 : 0) - (a.user.isOnline ? 1 : 0) || a.len - b.len)
    .map((x) => x.user);
}

async function findPeople(query, limit, viewer) {
  const users = await User.find(peopleWhere(query))
    .select('nickname login email avatar isOnline role bio')
    .limit(POOL)
    .lean();
  // Скрытое «в сети» не должно и поднимать в выдаче — маска до сортировки.
  await privacy.maskPresence(viewer, users);
  const top = rankPeople(users, query).slice(0, limit);
  const cards = await peopleCards(top);
  // Нашёлся по описанию, а не по имени — показываем, где именно совпало:
  // иначе непонятно, почему в выдаче этот человек.
  top.forEach((user, i) => { const about = bioMatch(user, query); if (about) cards[i].about = about; });
  return cards;
}

// Кусок описания вокруг совпадения, если по имени человек не нашёлся:
// [до, совпадение, после] — совпадение выделяется (partials/personCard.ejs,
// выпадашка в tk-app.js). До него — немного, чтобы оно не уехало за край
// строки, после — сколько влезет в две строки.
const BEFORE = 24;
const AFTER = 90;
function bioMatch(user, query) {
  const q = query.toLowerCase();
  const names = [user.nickname, user.login].filter(Boolean).map((n) => n.toLowerCase());
  if (!user.bio || names.some((n) => n.includes(q))) return null;
  const bio = user.bio.replace(/\s+/g, ' ');
  const at = bio.toLowerCase().indexOf(q);
  if (at === -1) return null;
  // Края — по границе слова: «…терская» читается хуже, чем «…мастерская».
  let from = Math.max(0, at - BEFORE);
  if (from) from = Math.min(at, bio.indexOf(' ', from) + 1 || at);
  let to = Math.min(bio.length, at + q.length + AFTER);
  if (to < bio.length) to = Math.max(at + q.length, bio.lastIndexOf(' ', to));
  return [
    (from ? '…' : '') + bio.slice(from, at),
    bio.slice(at, at + q.length),
    bio.slice(at + q.length, to).trimEnd() + (to < bio.length ? '…' : ''),
  ];
}

// Карточки людей (partials/personCard.ejs): имя, аватар, подписчики, в сети ли.
// Общие для поиска и списков подписчиков. users — с полями login, email,
// avatar, isOnline, role; «в сети» уже сверено с приватностью
// (privacy.maskPresence); порядок сохраняется.
async function peopleCards(users) {
  if (!users.length) return [];

  // Подписчики — одним запросом на всех найденных, а не по запросу на каждого.
  const counts = await Subscription.aggregate([
    { $match: { subscribedToId: { $in: users.map((u) => u._id) } } },
    { $group: { _id: '$subscribedToId', count: { $sum: 1 } } },
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c.count]));

  return users.map((user) => {
    const displayName = userView.displayName(user);
    return {
      _id: user._id,
      url: profileUrl(user),
      displayName,
      avatarStyle: userView.avatarStyle(user, displayName),
      followersCount: byId.get(String(user._id)) || 0,
      isOnline: !!user.isOnline,
      official: privacy.isOfficial(user),
    };
  });
}

async function findStreams(rx, limit) {
  const streams = await Stream.find(streamsWhere(rx))
    .sort({ viewers: -1, startedAt: -1 })
    .limit(limit)
    .populate('userId', 'nickname login email avatar')
    .select('title category city viewers thumbnail isAdult userId')
    .lean();
  return streams.filter((s) => s.userId).map((s) => ({
    _id: s._id,
    title: s.title,
    category: s.category,
    city: s.city,
    viewers: s.viewers,
    thumbnail: s.thumbnail || null,
    isAdult: !!s.isAdult,
    author: authorOf(s),
  }));
}

async function findRecordings(rx, limit) {
  const recordings = await Recording.find(recordingsWhere(rx))
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('userId', 'nickname login email avatar')
    .select(RECORDING_CARD)
    .lean();
  return recordingCards(recordings);
}

async function findVideos(rx, limit) {
  const videos = await GalleryVideo.find(videosWhere(rx))
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('userId', 'nickname login email avatar')
    .select('title duration thumb createdAt userId')
    .lean();
  // Та же карточка, что у записи (partials/recCard.ejs), ведёт на /video/:id.
  return recordingCards(videos).map((v) => ({ ...v, href: '/video/' + v._id }));
}

// Карточки записей (partials/recCard.ejs) — поиск и разделы каталога.
// recordings — с полями RECORDING_CARD и userId, раскрытым populate.
const RECORDING_CARD = 'title duration thumb isAdult createdAt recordedAt userId';
function recordingCards(recordings) {
  return recordings.filter((r) => r.userId).map((r) => ({
    _id: r._id,
    title: r.title,
    duration: r.duration,
    thumb: r.thumb && r.thumb.url ? r.thumb.url : null,
    isAdult: !!r.isAdult,
    createdAt: r.recordedAt || r.createdAt,
    author: authorOf(r),
  }));
}

async function findVenues(rx, limit) {
  const venues = await Establishments.find(venuesWhere(rx))
    .limit(limit)
    .select('name type city address online photos')
    .lean();
  return venues.map((v) => ({
    _id: v._id,
    name: v.name,
    type: v.type || '',
    city: v.city || '',
    address: v.address || '',
    online: !!v.online,
    photo: (v.photos || [])[0] || null,
  }));
}

// Одна выдача на все виды. types — какие искать (выпадашка берёт все,
// вкладка страницы — один), limit — сколько на вид.
// viewer — кто ищет: от него зависит, чьё «в сети» видно.
async function search(rawQuery, { limit = 5, types = TYPES, viewer = null } = {}) {
  const query = normalize(rawQuery);
  const empty = { query, people: [], streams: [], recordings: [], videos: [], venues: [] };
  if (!query) return empty;

  const rx = new RegExp(escapeRegex(query), 'i');
  const want = (type) => types.includes(type);

  const [people, streams, recordings, videos, venues] = await Promise.all([
    want('people') ? findPeople(query, limit, viewer) : [],
    want('streams') ? findStreams(rx, limit) : [],
    want('recordings') ? findRecordings(rx, limit) : [],
    want('videos') ? findVideos(rx, limit) : [],
    want('venues') ? findVenues(rx, limit) : [],
  ]);

  return { query, people, streams, recordings, videos, venues };
}

// Сколько всего нашлось по каждому виду — для вкладок страницы поиска.
async function counts(rawQuery) {
  const query = normalize(rawQuery);
  const zero = { people: 0, streams: 0, recordings: 0, videos: 0, venues: 0, total: 0 };
  if (!query) return zero;

  const rx = new RegExp(escapeRegex(query), 'i');
  const [people, streams, recordings, videos, venues] = await Promise.all([
    User.countDocuments(peopleWhere(query)),
    Stream.countDocuments(streamsWhere(rx)),
    Recording.countDocuments(recordingsWhere(rx)),
    GalleryVideo.countDocuments(videosWhere(rx)),
    Establishments.countDocuments(venuesWhere(rx)),
  ]);

  return { people, streams, recordings, videos, venues, total: people + streams + recordings + videos + venues };
}

module.exports = { search, counts, normalize, peopleCards, recordingCards, RECORDING_CARD, TYPES };
