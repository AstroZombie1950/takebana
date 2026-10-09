// Витрина: главная сайта (/) — эфиры и лента видео (с 28.09.2026), разделы
// с эфирами по категориям и страница пользователя. Гость смотрит всё это
// без входа.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const User = require('../../models/User');
const Recording = require('../../models/Recording');
const Stream = require('../../models/Stream');
const Subscription = require('../../models/Subscription');
const Contact = require('../../models/Contact');
const Conversation = require('../../models/Conversation');
const { CATEGORIES, SUB_CATEGORY, CITY_NAME } = require('../../config/catalog');
const Post = require('../../models/Post');
const topics = require('../../utils/topics');
const { commonDataMiddleware, byNick } = require('./shared');
const { notFound } = require('../../middleware/errors');
const { fragmentOnly } = require('../../middleware/fragment');
const authors = require('../../utils/authors');
const userView = require('../../utils/userView');
const { VENUE_AUTHOR, venueAuthor } = require('../../utils/venueAuthor');
const restriction = require('../../utils/restrict');
const privacy = require('../../utils/privacy');
const gallery = require('../../utils/gallery');
const search = require('../../utils/search');
const { profileUrl } = require('../../utils/profileUrl');
const profileLinks = require('../../utils/profileLinks');
const ogImage = require('../../utils/ogImage');
const feed = require('../../utils/feed');

// Вкладки каталога. popular — все разделы разом, остальные — разделы
// config/catalog.js (с 09.10 их девять, список строится из справочника).
const PAGES = {
  popular: { i18n: 'cat.popularTitle' },
  ...Object.fromEntries(Object.keys(CATEGORIES).map((code) => [code, { i18n: `cat.${code}Title` }])),
};

// Прежде роут отдавал не больше четырёх эфиров — с фильтрами это значило бы
// «первые четыре из подходящих». Постраничной подгрузки нет: одновременно
// идущих эфиров десятки, а не тысячи.
const PAGE_SIZE = 48;

const baseUrl = (category) => (category === 'popular' ? '/' : `/streaming/${category}`);

// Плашка «Что такое Takebana?» над витриной у гостя. Закрыл — cookie
// ставит catalog.js, сервер её читает, чтобы плашка не мигала при загрузке.
const introClosed = (req) => /(?:^|;\s*)tk_intro=0(?:;|$)/.test(req.headers.cookie || '');

// Фильтры приходят из адресной строки, то есть откуда угодно, а qs превращает
// `?city[$ne]=x` в объект. Каждое значение сверяется со списком допустимых:
// чужое молча отбрасывается, а не уходит в запрос оператором Mongo.
function readFilters(category, query) {
  const subs = [].concat(query.sub || []).filter((s) =>
    typeof s === 'string' && SUB_CATEGORY[s] && (category === 'popular' || SUB_CATEGORY[s] === category));
  return {
    subs: [...new Set(subs)],
    city: typeof query.city === 'string' && CITY_NAME[query.city] ? query.city : '',
    sort: query.sort === 'new' ? 'new' : '',
  };
}

async function findStreams(category, filters) {
  const where = { isActive: true };
  if (category !== 'popular') where.category = category;
  if (filters.subs.length) where.subcategory = { $in: filters.subs };
  if (filters.city) where.city = filters.city;

  const streams = await Stream.find(where)
    .sort(filters.sort === 'new' ? { startedAt: -1 } : { viewers: -1, startedAt: -1 })
    .limit(PAGE_SIZE)
    .populate('userId', 'nickname login email avatar')
    .populate('venue', VENUE_AUTHOR)
    .select('title category city viewers thumbnail userId venue isActive subscribersOnly')
    .lean();

  // Эфир удалённого пользователя приходит с userId: null. Прежде на нём
  // падала вся страница каталога — 500 вместо списка.
  return streams.filter((stream) => stream.userId).map((stream) => {
    const user = stream.userId;
    const displayName = userView.displayName(user);
    return {
      streamId: stream._id,
      title: stream.title,
      category: stream.category,
      city: stream.city,
      viewers: stream.viewers,
      isActive: stream.isActive,
      subscribersOnly: !!stream.subscribersOnly,
      thumbnail: stream.thumbnail || null,
      // Эфир заведения — под заведением (utils/venueAuthor.js).
      user: venueAuthor(stream.venue) || {
        displayName,
        avatarStyle: userView.avatarStyle(user, displayName),
      },
    };
  });
}

// Записи под эфирами раздела — то, что есть на странице, даже когда никто
// не в эфире (docs/seo/DECISIONS.md). Самые просматриваемые готовые раздела,
// без 18+ и без забаненных авторов. На главной вместо них — лента.
const RECORDINGS = 8;
async function findRecordings(category) {
  const recordings = await Recording.find({ status: 'ready', isAdult: { $ne: true }, category })
    .sort({ views: -1, createdAt: -1 })
    .limit(RECORDINGS * 2) // запас на забаненных
    .populate('userId', 'nickname login email avatar banned')
    .populate('venue', VENUE_AUTHOR)
    .select(search.RECORDING_CARD)
    .lean();
  return search.recordingCards(recordings.filter((r) => r.userId && !r.userId.banned).slice(0, RECORDINGS));
}

async function renderCatalog(req, res, category) {
  const page = PAGES[category];
  const filters = readFilters(category, req.query);

  // Запросы параллельно (ускоряет F5). Колонки «Авторы» в разделе с 02.10
  // нет — они в левой панели (/authors); «N в эфире» — число в сетке.
  const [streams, recordings] = await Promise.all([
    findStreams(category, filters),
    findRecordings(category),
  ]);

  res.render('streamingMain', {
    category,
    page,
    filters,
    filtered: filters.subs.length > 0 || !!filters.city,
    base: baseUrl(category),
    streams,
    recordings,
    showIntro: !req.session.userId && !introClosed(req),
  });
}

// Главная: эфиры, авторы полосой и лента (views/home.ejs). ?before= — та же
// лента дальше: так листает кнопка «Показать ещё» без скрипта.
const HOME_AUTHORS = 12;
router.get('/', commonDataMiddleware, async (req, res) => {
  const filters = readFilters('popular', req.query);
  const viewer = req.session.userId;
  const [users, streams, items] = await Promise.all([
    authors.featured(HOME_AUTHORS, viewer),
    findStreams('popular', filters),
    feed.page({ before: feed.cursor(req.query.before), viewer }),
  ]);
  res.render('home', {
    filters,
    filtered: filters.subs.length > 0 || !!filters.city,
    base: '/',
    users,
    streams,
    feed: items,
    showIntro: !viewer && !introClosed(req),
  });
});

// Следующая страница ленты главной для catalog.js: карточки без обвязки,
// курсор дальше — в заголовке (пустой — лента кончилась). До 04.10 жила
// на /feed — адрес отдан разделу «Лента».
router.get('/home/next', fragmentOnly(() => '/'), async (req, res) => {
  const page = await feed.page({ before: feed.cursor(req.query.before), viewer: req.session.userId });
  res.set('X-Feed-Next', page.next || '');
  res.render('partials/feedPage', { items: page.items });
});

// Раздел «Лента» (04.10, решение Ивана): то, что выкладывают люди, одной
// колонкой, новые сверху — как в Инстаграме. С 09.10 — посты (текст, фото,
// видео) и прежние фото и видео; записи эфиров — в «Популярном».
// ?t=<раздел или тема> — только посты на эту тему (utils/topics.js),
// ?before= — дальше по ленте (так листает «Показать ещё» без скрипта).
// Прежний фильтр ?kind=photo|video (04.10) уступил темам — 301 на «Ленту».
// В индексе — первая страница без фильтра и страницы тем; ?before= —
// noindex, follow: сами посты в индексе своими страницами и в карте сайта.
const topicOf = (q) => (topics.valid(q.t) ? q.t : '');

// Разделы и темы, в которых есть посты, — для полосы фильтра: пустой пункт
// вёл бы в пустую ленту. Отсчёт по темам — distinct по индексу topic.
async function usedTopics() {
  const used = new Set(await Post.distinct('topic', { status: 'ready', topic: { $gt: '' } }));
  return Object.entries(CATEGORIES)
    .map(([code, c]) => ({ code, i18n: c.i18n, subs: c.subs.filter((x) => used.has(x.code)).map((x) => ({ code: x.code, i18n: x.i18n })), has: used.has(code) }))
    .filter((c) => c.has || c.subs.length);
}

router.get('/feed', commonDataMiddleware, async (req, res) => {
  if (req.query.kind !== undefined) return res.redirect(301, '/feed');
  const topic = topicOf(req.query);
  const before = feed.cursor(req.query.before);
  const viewer = req.session.userId;
  const [page, sections] = await Promise.all([
    feed.page({ before, viewer, kinds: feed.POSTS, topic }),
    usedTopics(),
  ]);
  res.render('feed', { topic, section: topics.sectionOf(topic), sections, before: !!before, items: await feed.withTalk(page.items, viewer), next: page.next });
});

// Следующая страница «Ленты» для catalog.js — как /home/next.
router.get('/feed/next', fragmentOnly(() => '/feed'), async (req, res) => {
  const page = await feed.page({ before: feed.cursor(req.query.before), viewer: req.session.userId, kinds: feed.POSTS, topic: topicOf(req.query) });
  res.set('X-Feed-Next', page.next || '');
  res.render('partials/postPage', { items: await feed.withTalk(page.items, req.session.userId), me: req.session.userId ? String(req.session.userId) : '' });
});

// Прежние адреса «Популярного» — на главную, с фильтрами: ими делились ссылками.
// 301: переезд насовсем, поисковик переносит адрес на главную (до 04.10 — 302).
router.get(['/streaming', '/streaming/popular'], (req, res) => {
  const qs = req.originalUrl.indexOf('?');
  res.redirect(301, qs === -1 ? '/' : '/' + req.originalUrl.slice(qs));
});

router.get('/streaming/:category', commonDataMiddleware, (req, res) => {
  // Раздела нет — «не найдено»: переход на главную поисковик счёл бы
  // мягкой 404, а человек не понял бы, куда делся его адрес.
  if (!PAGES[req.params.category]) return notFound(req, res);
  return renderCatalog(req, res, req.params.category);
});

// Одна сетка, без страницы: её подгружает catalog.js при смене фильтра.
// Без commonDataMiddleware — шапка, подписки и уведомления здесь не рисуются,
// а это пять запросов к базе на каждое нажатие тега.
router.get('/streaming/:category/grid', fragmentOnly((req) => baseUrl(req.params.category)), async (req, res) => {
  const category = req.params.category;
  if (!PAGES[category]) {
    return res.sendStatus(404);
  }

  const filters = readFilters(category, req.query);
  const streams = await findStreams(category, filters);
  // «N в эфире» над сеткой (partials/liveCount.ejs) catalog.js берёт отсюда.
  res.set('X-Live-Count', String(streams.length));
  res.render('partials/catalogGrid', {
    streams,
    filtered: filters.subs.length > 0 || !!filters.city,
    base: baseUrl(category),
    compact: category === 'popular', // сетка главной (views/home.ejs)
  });
});


// Профиль живёт по адресу /@ник (utils/profileUrl.js, byNick — в shared.js).
// Прежний адрес /userPage/<id> и прежний ник уводят сюда 301 — ссылки,
// разошедшиеся до смены, продолжают работать.
//
// Старые адреса профиля, галереи и подписчиков. /gallery — общая лента
// до 25.09.2026, теперь её место заняла вкладка «Фото». Подписчики
// и подписки — на /@ник с 04.10 (docs/seo, задача 26).
router.get(['/userPage/:id', '/userPage/:id/:tab(gallery|photos|videos|recordings|followers|following)'], commonDataMiddleware, async (req, res) => {
  const user = /^[a-f\d]{24}$/i.test(req.params.id) ? await User.findById(req.params.id).select('nickname').lean() : null;
  // Без ника — «не найдено», а не 301 на самого себя.
  if (!user || !user.nickname) return notFound(req, res);
  const qs = req.originalUrl.indexOf('?');
  const tab = !req.params.tab ? '' : req.params.tab === 'gallery' ? '/photos' : '/' + req.params.tab;
  res.redirect(301, profileUrl(user) + tab + (qs === -1 ? '' : req.originalUrl.slice(qs)));
});

router.get('/@:nick', commonDataMiddleware, async (req, res) => {
  const currentUserId = req.session.userId; // ID текущего пользователя из сессии
  const user = await byNick(req, res);
  if (!user) return;
  const userId = String(user._id);

  const displayName = userView.displayName(user);
  const avatarStyle = userView.avatarStyle(user, displayName);

  // Получаем количество подписчиков и подписок для отображаемого пользователя
  const followersCount = await Subscription.countDocuments({ subscribedToId: userId });
  const followingCount = await Subscription.countDocuments({ subscriberId: userId });

  // Проверяем активный стрим пользователя
  const activeStream = await Stream.findOne({ userId: userId, isActive: true });

  // Проверяем, подписан ли текущий пользователь на просматриваемого
  let isSubscribed = false;
  if (currentUserId) {
    const existingSubscription = await Subscription.findOne({
      subscriberId: currentUserId,
      subscribedToId: userId
    });
    if (existingSubscription) {
      isSubscribed = true;
    }
  }

  // Записи эфиров: чужому — только готовые, автору — и те, что ещё
  // сохраняются или не сохранились.
  const isSelf = String(userId) === String(currentUserId);
  // Ограничение доступа (utils/restrict.js) — в обе стороны: закрыл ли
  // хозяин страницы канал от меня и закрыл ли я свой от него.
  // inContacts — записан ли он у меня в книжке (models/Contact.js): от этого
  // зависит пункт меню «В контакты» или «Убрать из контактов».
  const [restricted, iRestricted, inContacts] = currentUserId && !isSelf
    ? await Promise.all([
      restriction.isRestricted(userId, currentUserId),
      restriction.isRestricted(currentUserId, userId),
      Contact.exists({ owner: currentUserId, peer: userId }).then(Boolean),
    ])
    : [false, false, false];
  // Приватность хозяина страницы (utils/privacy.js): видно ли его «в сети»,
  // можно ли ему написать и позвонить — кнопки, которые откажут, не рисуем.
  const conversation = currentUserId && !isSelf
    ? await Conversation.findOne({ $or: [{ userOne: currentUserId, userTwo: userId }, { userOne: userId, userTwo: currentUserId }] }).select('lastMessage requestFor').lean()
    : null;
  const [seen, canWrite, canCall] = isSelf
    ? [true, true, true]
    : await Promise.all([
      privacy.presenceVisible(currentUserId, [userId]).then((v) => v[0] || false),
      currentUserId ? privacy.messageGate(conversation, currentUserId, userId).then((g) => g.ok) : true,
      currentUserId ? privacy.decide('calls', userId, currentUserId).then((g) => g.ok) : true,
    ]);
  // С 09.10 (решение заказчика) в профиле нет блоков записей, фото и видео:
  // их числа — ссылками на свои страницы (/@ник/recordings, /photos,
  // /videos), а ниже «Стрима» — лента автора: посты, фото и видео, как
  // в «Ленте» (utils/feed.js). Владельцу видны и посты в работе.
  const [recordingsTotal, counts, posts] = restricted
    ? [0, { photos: 0, videos: 0, videosListed: 0 }, { items: [], next: null }]
    : await Promise.all([
      gallery.recordingsCount(userId, isSelf),
      gallery.counts(userId, isSelf),
      feed.page({ viewer: currentUserId, kinds: feed.POSTS, author: user._id }),
    ]);
  const items = await feed.withTalk(posts.items, currentUserId);

  res.locals.pageOwner = { id: String(userId), scope: 'profile', access: restricted ? 'them' : iRestricted ? 'me' : '' };

  // В поиск — только профиль, где есть что смотреть: запись, пост, фото,
  // видео или идущий эфир. Пустых («зарегистрировался и ушёл») тысячи одинаковых,
  // забаненный из выдачи выпадает (docs/seo/DECISIONS.md). «Показывать
  // меня в поиске» касается только поиска по сайту и подборок — не
  // поисковиков (решение Ивана 25.09.2026: убрать из Google можно руками).
  const indexable = !user.banned
    && (!!activeStream || counts.photos + counts.videos > 0 || recordingsTotal > 0 || items.some((i) => !i.processing));

  // Передача данных в шаблон
  res.render('userPage', {
    indexable,
    // Карточка для мессенджеров с CDN или null — общая обложка (utils/ogImage.js).
    ogImage: ogImage.forProfile(user),
    recordingsTotal,
    counts,
    items,
    next: posts.next,
    restricted,
    iRestricted,
    inContacts,
    canWrite,
    canCall,
    user: {
      official: privacy.isOfficial(user),
      displayName,
      avatarStyle,
      _id: user._id,
      url: profileUrl(user),
      nickname: user.nickname || '',
      // Когда заведён аккаунт — по id: отдельного поля даты у User нет.
      createdAt: user._id.getTimestamp(),
      bio: user.bio || '',
      // Значки ссылок (utils/profileLinks.js). Сайт без nofollow — только
      // у тех, кому это включил администратор (User.linksFollow).
      // Пока ссылки выключены (profileLinks.ENABLED) — пусто: ни значков, ни sameAs.
      links: profileLinks.ENABLED ? profileLinks.list(user.links) : [],
      linksFollow: !!user.linksFollow,
      followersCount,
      followingCount,
      isSubscribed, // Передаем статус подписки
      isStreaming: !!activeStream,
      activeStreamId: activeStream ? activeStream._id : null,
      // Свою страницу человек смотрит сам — значит, он в сети, что бы ни
      // успела записать база.
      // Скрытое «в сети» — ни точки, ни даты (utils/privacy.js).
      isOnline: isSelf || (seen && !!user.isOnline),
      // Время визита — отдельным правилом, не шире «в сети».
      lastSeen: seen && (isSelf || seen.time) ? user.lastSeen || null : null,
      lastSeenHidden: !!seen && !isSelf && !seen.time,
      presenceHidden: !seen,
    }
  });
});
// Следующая страница ленты автора для catalog.js — как /feed/next.
router.get('/@:nick/feed', fragmentOnly((req) => '/@' + req.params.nick), async (req, res) => {
  const user = await User.findOne({ nickname: String(req.params.nick) }).select('_id').lean();
  const me = req.session.userId;
  const closed = !user || (!!me && String(user._id) !== String(me) && await restriction.isRestricted(user._id, me));
  const page = closed ? { items: [], next: null } : await feed.page({ before: feed.cursor(req.query.before), viewer: me, kinds: feed.POSTS, author: user._id });
  res.set('X-Feed-Next', page.next || '');
  res.render('partials/postPage', { items: await feed.withTalk(page.items, me), me: me ? String(me) : '' });
});

// Прежняя общая лента — на вкладку «Фото», с тем же номером страницы.
router.get('/@:nick/gallery', (req, res) => {
  const qs = req.originalUrl.indexOf('?');
  res.redirect(301, `/@${req.params.nick}/photos` + (qs === -1 ? '' : req.originalUrl.slice(qs)));
});

// Записи эфиров целиком: карточками, новые сверху, по gallery.PAGE на
// страницу (?page=N). Адресация листалки и ограничение доступа — как
// у вкладок галереи ниже.
router.get('/@:nick/recordings', commonDataMiddleware, async (req, res) => {
  const user = await byNick(req, res, 'nickname login email avatar banned');
  if (!user) return;
  const userId = String(user._id);

  const me = req.session.userId;
  const isSelf = userId === String(me);
  const restricted = !!me && !isSelf && await restriction.isRestricted(userId, me);
  res.locals.pageOwner = { id: userId, scope: 'profile', access: restricted ? 'them' : '' };

  const total = restricted ? 0 : await gallery.recordingsCount(userId, isSelf);
  const asked = req.query.page;
  const pg = gallery.page(total, parseInt(asked, 10));
  const base = `${profileUrl(user)}/recordings`;
  if (asked !== undefined) {
    if (asked === '1') return res.redirect(301, base);
    if (asked !== String(pg.page) || pg.page === 1) return notFound(req, res);
  }
  const items = restricted ? [] : await gallery.recordings(userId, isSelf, { skip: pg.skip, limit: gallery.PAGE });

  res.render('recordings', {
    owner: { _id: user._id, displayName: userView.displayName(user), url: profileUrl(user) },
    isSelf,
    restricted,
    // С 09.10 профиль записей не показывает — страница в индексе, когда они есть.
    indexable: !user.banned && total > 0,
    items,
    total,
    page: pg.page,
    pages: pg.pages,
  });
});

// Вкладка галереи целиком: фото сеткой или видео карточками, новые сверху,
// по gallery.PAGE на страницу (?page=N). Ограничение доступа — как у профиля.
router.get('/@:nick/:tab(photos|videos)', commonDataMiddleware, async (req, res) => {
  const tab = req.params.tab;
  const user = await byNick(req, res, 'nickname login email avatar banned');
  if (!user) return;
  const userId = String(user._id);

  const me = req.session.userId;
  const isSelf = userId === String(me);
  const restricted = !!me && !isSelf && await restriction.isRestricted(userId, me);
  res.locals.pageOwner = { id: userId, scope: 'profile', access: restricted ? 'them' : '' };

  const counts = restricted ? { photos: 0, videos: 0, videosListed: 0 } : await gallery.counts(userId, isSelf);
  const total = tab === 'photos' ? counts.photos : counts.videosListed;
  // У каждой страницы листалки один адрес: ?page=1 — это сама вкладка,
  // номер за пределами или не число — «не найдено», а не последняя
  // страница под чужим адресом.
  const asked = req.query.page;
  const pg = gallery.page(total, parseInt(asked, 10));
  const base = `${profileUrl(user)}/${tab}`;
  if (asked !== undefined) {
    if (asked === '1') return res.redirect(301, base);
    if (asked !== String(pg.page) || pg.page === 1) return notFound(req, res);
  }
  const range = { skip: pg.skip, limit: gallery.PAGE };
  const items = restricted ? [] : tab === 'photos' ? await gallery.photos(userId, range) : await gallery.videos(userId, isSelf, range);

  res.render('gallery', {
    tab,
    owner: { _id: user._id, displayName: userView.displayName(user), url: profileUrl(user) },
    isSelf,
    restricted,
    // С 09.10 профиль не показывает начало вкладок — в индексе, когда есть что.
    indexable: !user.banned && total > 0,
    items,
    counts,
    page: pg.page,
    pages: pg.pages,
    // Номер первой плитки страницы — для подписей «Фото N».
    offset: pg.skip,
  });
});

module.exports = router;
