// Поиск по сайту — одно место для всех четырёх видов: люди, эфиры, записи,
// заведения. Отсюда берут и быстрая выпадашка в шапке (/api/search), и полная
// страница результатов (/search): иначе выдача в них разошлась бы.
//
// Ищем подстрокой, регулярным выражением по полям. Индекса под это нет и пока
// не нужно: эфиров и записей десятки, заведений сотни. Когда станет тесно,
// менять — здесь, а не в двух маршрутах.

const User = require('../models/User');
const Stream = require('../models/Stream');
const Recording = require('../models/Recording');
const Establishments = require('../models/Establishments');
const Subscription = require('../models/Subscription');
const userView = require('./userView');

const TYPES = ['people', 'streams', 'recordings', 'venues'];

// Строка от посетителя — текст, а не регулярное выражение: без экранирования
// «(a+)+$» вешает процесс откатом, а «.*» находит всё подряд.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Запрос короче двух символов ищет пол-базы и ничего не значит.
const MIN_QUERY = 2;

function normalize(raw) {
  const q = typeof raw === 'string' ? raw.trim().slice(0, 100) : '';
  return q.length >= MIN_QUERY ? q : '';
}

// Люди ищутся по нику (его видно везде, utils/userView.js) и по имени,
// а у кого нет ни того ни другого — по началу почты до «@». По всей почте
// не ищем: запрос «gmail» выдавал бы список людей, а по выдаче проверялся
// бы чужой адрес.
function peopleWhere(query) {
  const rx = new RegExp(escapeRegex(query), 'i');
  const where = [{ nickname: rx }, { login: rx }];
  if (!query.includes('@')) {
    where.push({ login: { $in: ['', null] }, email: new RegExp('^[^@]*' + escapeRegex(query), 'i') });
  }
  return { $or: where };
}

// Эфиры — только идущие: черновик не открыть, а в выдаче он выглядел бы
// живым. Записи — только готовые: недосклеенную видит лишь автор.
const streamsWhere = (rx) => ({ isActive: true, $or: [{ title: rx }, { description: rx }] });
const recordingsWhere = (rx) => ({ status: 'ready', $or: [{ title: rx }, { description: rx }] });
const venuesWhere = (rx) => ({ status: true, $or: [{ name: rx }, { address: rx }] });

function authorOf(doc) {
  const user = doc.userId;
  if (!user) return null; // автора удалили — карточка без него бессмысленна
  const displayName = userView.displayName(user);
  return { _id: user._id, displayName, avatarStyle: userView.avatarStyle(user, displayName) };
}

// Сколько подходящих смотрим, прежде чем выбрать лучшие. Раньше выборка
// обрывалась на limit сразу в базе, без сортировки, — то есть выпадашка
// показывала три случайных из всех совпавших. Набрал человек «ан» — в трёх
// строках «Анастасия», «Андрей» и «Иван», а нужный Антон, который нашёлся бы
// при полностью набранном нике, не попадал никуда. Это и есть «не находит,
// если не до конца набрать имя».
const POOL = 200;

// Чем ответ ближе к запросу, тем выше: точное совпадение, потом начало
// имени, потом середина. Внутри ступени — кто на связи и у кого имя короче
// (в коротком запрос занимает большую часть — значит, попал точнее).
function rankPeople(users, query) {
  const q = query.toLowerCase();
  const rank = (user) => {
    const names = [user.nickname, user.login, (user.email || '').split('@')[0]]
      .filter(Boolean).map((n) => n.toLowerCase());
    if (names.some((n) => n === q)) return 0;
    if (names.some((n) => n.startsWith(q))) return 1;
    return 2;
  };
  return users
    .map((user) => ({ user, r: rank(user), len: userView.displayName(user).length }))
    .sort((a, b) => a.r - b.r || (b.user.isOnline ? 1 : 0) - (a.user.isOnline ? 1 : 0) || a.len - b.len)
    .map((x) => x.user);
}

async function findPeople(query, limit) {
  const users = await User.find(peopleWhere(query))
    .select('nickname login email avatar isOnline')
    .limit(POOL)
    .lean();
  return peopleCards(rankPeople(users, query).slice(0, limit));
}

// Карточки людей (partials/personCard.ejs): имя, аватар, подписчики, в сети ли.
// Общие для поиска и списков подписчиков. users — с полями login, email,
// avatar, isOnline; порядок сохраняется.
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
      displayName,
      avatarStyle: userView.avatarStyle(user, displayName),
      followersCount: byId.get(String(user._id)) || 0,
      isOnline: !!user.isOnline,
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
    .select('title duration thumb isAdult createdAt recordedAt userId')
    .lean();
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
async function search(rawQuery, { limit = 5, types = TYPES } = {}) {
  const query = normalize(rawQuery);
  const empty = { query, people: [], streams: [], recordings: [], venues: [] };
  if (!query) return empty;

  const rx = new RegExp(escapeRegex(query), 'i');
  const want = (type) => types.includes(type);

  const [people, streams, recordings, venues] = await Promise.all([
    want('people') ? findPeople(query, limit) : [],
    want('streams') ? findStreams(rx, limit) : [],
    want('recordings') ? findRecordings(rx, limit) : [],
    want('venues') ? findVenues(rx, limit) : [],
  ]);

  return { query, people, streams, recordings, venues };
}

// Сколько всего нашлось по каждому виду — для вкладок страницы поиска.
async function counts(rawQuery) {
  const query = normalize(rawQuery);
  const zero = { people: 0, streams: 0, recordings: 0, venues: 0, total: 0 };
  if (!query) return zero;

  const rx = new RegExp(escapeRegex(query), 'i');
  const [people, streams, recordings, venues] = await Promise.all([
    User.countDocuments(peopleWhere(query)),
    Stream.countDocuments(streamsWhere(rx)),
    Recording.countDocuments(recordingsWhere(rx)),
    Establishments.countDocuments(venuesWhere(rx)),
  ]);

  return { people, streams, recordings, venues, total: people + streams + recordings + venues };
}

module.exports = { search, counts, normalize, peopleCards, TYPES, MIN_QUERY };
