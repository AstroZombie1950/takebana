// Витрина: список эфиров по категориям и страница пользователя. «Популярное» —
// главная сайта (/). Гость смотрит всё это без входа.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const User = require('../../models/User');
const Recording = require('../../models/Recording');
const Stream = require('../../models/Stream');
const Subscription = require('../../models/Subscription');
const Contact = require('../../models/Contact');
const { SUB_CATEGORY, CITY_NAME } = require('../../config/catalog');
const { commonDataMiddleware, getActiveStreamsCount } = require('./shared');
const { notFound } = require('../../middleware/errors');
const authors = require('../../utils/authors');
const userView = require('../../utils/userView');
const restriction = require('../../utils/restrict');
const gallery = require('../../utils/gallery');
const search = require('../../utils/search');
const nickname = require('../../utils/nickname');
const { profileUrl } = require('../../utils/profileUrl');
const profileLinks = require('../../utils/profileLinks');
const ogImage = require('../../utils/ogImage');

// Вкладки каталога. popular — все категории разом, остальные совпадают
// с кодами категорий в config/catalog.js.
const PAGES = {
  popular:       { i18n: 'cat.popularTitle' },
  business:      { i18n: 'cat.businessTitle' },
  entertainment: { i18n: 'cat.entertainmentTitle' },
  fashion:       { i18n: 'cat.fashionTitle' },
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
    .select('title category city viewers thumbnail userId isActive')
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
      thumbnail: stream.thumbnail || null,
      user: {
        displayName,
        avatarStyle: userView.avatarStyle(user, displayName),
      },
    };
  });
}

// Записи под эфирами — то, что есть на странице, даже когда никто не в эфире
// (docs/seo/DECISIONS.md). Самые просматриваемые готовые, без 18+ и без
// забаненных авторов; на главной — из всех разделов.
const RECORDINGS = 8;
async function findRecordings(category) {
  const recordings = await Recording.find({ status: 'ready', isAdult: { $ne: true }, ...(category === 'popular' ? {} : { category }) })
    .sort({ views: -1, createdAt: -1 })
    .limit(RECORDINGS * 2) // запас на забаненных
    .populate('userId', 'nickname login email avatar banned')
    .select(search.RECORDING_CARD)
    .lean();
  return search.recordingCards(recordings.filter((r) => r.userId && !r.userId.banned).slice(0, RECORDINGS));
}

async function renderCatalog(req, res, category) {
  const page = PAGES[category];
  const filters = readFilters(category, req.query);

  // Запросы параллельно (ускоряет F5)
  const [users, totalStreamsCount, streams, recordings] = await Promise.all([
    // Трое в колонку «Авторы»; кто это — utils/authors.js, остальные на /authors.
    authors.featured(3),
    getActiveStreamsCount(),
    findStreams(category, filters),
    findRecordings(category),
  ]);

  res.render('streamingMain', {
    category,
    page,
    filters,
    filtered: filters.subs.length > 0 || !!filters.city,
    base: baseUrl(category),
    users,
    streams,
    recordings,
    totalStreamsCount,
    showIntro: !req.session.userId && !introClosed(req),
  });
}

router.get('/', commonDataMiddleware, (req, res) => renderCatalog(req, res, 'popular'));

// Прежние адреса «Популярного» — на главную, с фильтрами: ими делились ссылками.
router.get(['/streaming', '/streaming/popular'], (req, res) => {
  const qs = req.originalUrl.indexOf('?');
  res.redirect(qs === -1 ? '/' : '/' + req.originalUrl.slice(qs));
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
router.get('/streaming/:category/grid', async (req, res) => {
  const category = req.params.category;
  if (!PAGES[category]) {
    return res.sendStatus(404);
  }

  const filters = readFilters(category, req.query);
  res.render('partials/catalogGrid', {
    streams: await findStreams(category, filters),
    filtered: filters.subs.length > 0 || !!filters.city,
    base: baseUrl(category),
  });
});


// Профиль живёт по адресу /@ник (utils/profileUrl.js). Прежний адрес
// /userPage/<id> и прежний ник уводят сюда 301 — ссылки, разошедшиеся
// до смены, продолжают работать.
//
// Человек по нику: нынешний — он; прежний — 301 на тот же вид страницы
// (профиль или галерея, с ?page=) по нынешнему нику; иначе «не найдено».
// canonicalPath уже привёл ник к нижнему регистру.
async function byNick(req, res, select) {
  const nick = req.params.nick;
  if (!nickname.RULE.test(nick)) { notFound(req, res); return null; }
  const user = await User.findOne({ nickname: nick }).select(select);
  if (user) return user;
  const now = await User.findOne({ formerNicknames: nick }).sort({ nicknameChangedAt: -1 }).select('nickname').lean();
  if (now && now.nickname) res.redirect(301, req.originalUrl.replace('/@' + nick, '/@' + now.nickname));
  else notFound(req, res);
  return null;
}

router.get(['/userPage/:id', '/userPage/:id/gallery'], commonDataMiddleware, async (req, res) => {
  const user = /^[a-f\d]{24}$/i.test(req.params.id) ? await User.findById(req.params.id).select('nickname').lean() : null;
  // Без ника — «не найдено», а не 301 на самого себя.
  if (!user || !user.nickname) return notFound(req, res);
  const qs = req.originalUrl.indexOf('?');
  res.redirect(301, profileUrl(user) + (req.path.endsWith('/gallery') ? '/gallery' : '') + (qs === -1 ? '' : req.originalUrl.slice(qs)));
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
  const recordings = restricted ? [] : await Recording.find({ userId, ...(isSelf ? {} : { status: 'ready' }) })
    .sort({ createdAt: -1 })
    .select('title status duration thumb isAdult createdAt views')
    .lean();
  // Фото и видео одной лентой (utils/gallery.js): в профиле — начало,
  // целиком — на /@ник/gallery. Владельцу видны и ролики в работе.
  const shots = restricted ? { list: [], count: 0 } : await gallery.feed(user, isSelf);

  res.locals.pageOwner = { id: String(userId), scope: 'profile', access: restricted ? 'them' : iRestricted ? 'me' : '' };

  // В поиск — только профиль, где есть что смотреть: запись, фото, видео
  // или идущий эфир. Пустых («зарегистрировался и ушёл») тысячи одинаковых,
  // забаненный из выдачи выпадает (docs/seo/DECISIONS.md).
  const indexable = !user.banned
    && (!!activeStream || shots.count > 0 || recordings.some((r) => r.status === 'ready'));

  // Передача данных в шаблон
  res.render('userPage', {
    indexable,
    // Карточка для мессенджеров с CDN или null — общая обложка (utils/ogImage.js).
    ogImage: ogImage.forProfile(user),
    recordings,
    shots: shots.list.slice(0, gallery.PREVIEW),
    shotsMore: shots.list.length > gallery.PREVIEW,
    shotsCount: shots.count,
    restricted,
    iRestricted,
    inContacts,
    user: {
      displayName,
      avatarStyle,
      _id: user._id,
      url: profileUrl(user),
      bio: user.bio || '',
      // Значки ссылок (utils/profileLinks.js). Сайт без nofollow — только
      // у тех, кому это включил администратор (User.linksFollow).
      links: profileLinks.list(user.links),
      linksFollow: !!user.linksFollow,
      followersCount,
      followingCount,
      isSubscribed, // Передаем статус подписки
      isStreaming: !!activeStream,
      activeStreamId: activeStream ? activeStream._id : null,
      // Свою страницу человек смотрит сам — значит, он в сети, что бы ни
      // успела записать база.
      isOnline: !!user.isOnline || String(currentUserId) === String(user._id),
      lastSeen: user.lastSeen || null
    }
  });
});
// Вся галерея человека: фото и видео одной лентой, новые сверху, по
// gallery.PAGE на страницу (?page=N). Ограничение доступа — как у профиля.
router.get('/@:nick/gallery', commonDataMiddleware, async (req, res) => {
  const user = await byNick(req, res, 'nickname login email avatar gallery banned');
  if (!user) return;
  const userId = String(user._id);

  const me = req.session.userId;
  const isSelf = String(userId) === String(me);
  const restricted = !!me && !isSelf && await restriction.isRestricted(userId, me);
  res.locals.pageOwner = { id: String(userId), scope: 'profile', access: restricted ? 'them' : '' };

  const shots = restricted ? { list: [], count: 0 } : await gallery.feed(user, isSelf);
  // У каждой страницы листалки один адрес: ?page=1 — это сама галерея,
  // номер за пределами или не число — «не найдено», а не последняя
  // страница под чужим адресом.
  const asked = req.query.page;
  const pg = gallery.page(shots.list, parseInt(asked, 10));
  if (asked !== undefined) {
    if (asked === '1') return res.redirect(301, `${profileUrl(user)}/gallery`);
    if (asked !== String(pg.page) || pg.page === 1) return notFound(req, res);
  }
  const displayName = userView.displayName(user);
  res.render('gallery', {
    owner: { _id: user._id, displayName, url: profileUrl(user) },
    isSelf,
    restricted,
    // Не больше gallery.PREVIEW — всё уже есть в профиле, страница-дубль.
    indexable: !user.banned && shots.count > gallery.PREVIEW,
    shots: pg.items,
    count: shots.count,
    page: pg.page,
    pages: pg.pages,
    // Номер первой плитки страницы — для подписей «Фото N».
    offset: (pg.page - 1) * gallery.PAGE,
  });
});

module.exports = router;
