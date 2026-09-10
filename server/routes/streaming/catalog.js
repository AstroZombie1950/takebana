// Витрина: список эфиров по категориям и страница пользователя.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const User = require('../../models/User');
const Stream = require('../../models/Stream');
const Subscription = require('../../models/Subscription');
const { requireAuthApi } = require('../../middleware/auth');
const { SUB_CATEGORY, CITY_NAME } = require('../../config/catalog');
const { commonDataMiddleware, getStreamUsers, getActiveStreamsCount, getRandomGradient } = require('./shared');

// Вкладки каталога. popular — все категории разом, остальные совпадают
// с кодами категорий в config/catalog.js.
const PAGES = {
  popular:       { title: 'ПОПУЛЯРНОЕ', lng: '90' },
  business:      { title: 'БИЗНЕС', lng: '105' },
  entertainment: { title: 'РАЗВЛЕЧЕНИЯ', lng: '104' },
};

// Прежде роут отдавал не больше четырёх эфиров — с фильтрами это значило бы
// «первые четыре из подходящих». Постраничной подгрузки нет: одновременно
// идущих эфиров десятки, а не тысячи.
const PAGE_SIZE = 48;

const baseUrl = (category) => (category === 'popular' ? '/streaming' : `/streaming/${category}`);

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
    .populate('userId', 'login email avatar')
    .select('title category city viewers thumbnail userId isActive')
    .lean();

  // Эфир удалённого пользователя приходит с userId: null. Прежде на нём
  // падала вся страница каталога — 500 вместо списка.
  return streams.filter((stream) => stream.userId).map((stream) => {
    const user = stream.userId;
    const displayName = user.login || (user.email ? user.email.split('@')[0] : 'Неизвестный пользователь');
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
        avatarStyle: user.avatar
          ? { url: user.avatar }
          : { gradient: getRandomGradient(), initial: displayName.charAt(0).toUpperCase() },
      },
    };
  });
}

router.get('/streaming/:category?', commonDataMiddleware, async (req, res) => {
  const _t0 = Date.now();

  if (!req.session.userId) {
    return res.redirect('/');
  }

  const category = req.params.category || 'popular';
  const page = PAGES[category];
  if (!page) {
    return res.redirect('/streaming');
  }

  const filters = readFilters(category, req.query);

  // Запросы параллельно (ускоряет F5)
  const [users, totalStreamsCount, streams] = await Promise.all([
    getStreamUsers(),
    getActiveStreamsCount(),
    findStreams(category, filters),
  ]);

  res.render('streamingMain', {
    title: `${page.title} Стримы`,
    category,
    page,
    filters,
    filtered: filters.subs.length > 0 || !!filters.city,
    base: baseUrl(category),
    users,
    streams,
    totalStreamsCount,
  });
  console.log(`[perf] GET /streaming/${category} render in ${Date.now() - _t0}ms`);
});

// Одна сетка, без страницы: её подгружает catalog.js при смене фильтра.
// Без commonDataMiddleware — шапка, подписки и уведомления здесь не рисуются,
// а это пять запросов к базе на каждое нажатие тега.
router.get('/streaming/:category/grid', requireAuthApi, async (req, res) => {
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


router.get('/userPage/:id', commonDataMiddleware, async (req, res) => {
  if (!req.session.userId) { // Проверка авторизации
    return res.redirect('/');
  }

  try {
    const userId = req.params.id; // ID пользователя, чей профиль просматривается
    const currentUserId = req.session.userId; // ID текущего пользователя из сессии

    // Получаем данные пользователя, чей профиль просматривается
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).send('Пользователь не найден');
    }

    const displayName = user.login || (user.email ? user.email.split('@')[0] : 'Неизвестный пользователь');
    const avatarStyle = user.avatar
      ? { url: user.avatar }
      : { gradient: getRandomGradient(), initial: displayName.charAt(0).toUpperCase() };

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

    // Передача данных в шаблон
    res.render('userPage', {
      title: `Профиль пользователя ${displayName}`,
      user: {
        displayName,
        avatarStyle,
        _id: user._id,
        followersCount,
        followingCount,
        isSubscribed, // Передаем статус подписки
        isStreaming: !!activeStream,
        activeStreamId: activeStream ? activeStream._id : null,
        gallery: Array.isArray(user.gallery) ? user.gallery : [],
        isOnline: !!user.isOnline,
        lastSeen: user.lastSeen || null
      }
    });
  } catch (error) {
    console.error('Ошибка получения данных пользователя:', error);
    res.status(500).send('Ошибка сервера');
  }
});
// Добавьте другие маршруты, связанные с функционалом стриминга


// Функция для преобразования времени в "назад"

module.exports = router;
