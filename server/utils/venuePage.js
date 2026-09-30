// Страница заведения и её вкладки (29.09, docs/VENUES.md п. 8–10) — общее
// у маршрутов заведения (routes/establishmentsRouter.js) и видео-меню
// (routes/venueMenu.js).

const Establishments = require('../models/Establishments');
const Stream = require('../models/Stream');
const Recording = require('../models/Recording');
const GalleryVideo = require('../models/GalleryVideo');
const MenuItem = require('../models/MenuItem');

const OBJECT_ID = /^[a-f\d]{24}$/i;

// Заведение по :venueId и кто смотрит. Заведение на проверке видно только
// владельцу (и администратору) — как на карте. null — показывать нечего:
// кривой адрес ведёт на страницу 404.
async function pageVenue(req, res) {
  if (!OBJECT_ID.test(req.params.venueId)) return null;
  const venue = await Establishments.findById(req.params.venueId).lean();
  if (!venue) return null;
  const me = res.locals.currentUser;
  const own = !!me && String(venue.owner) === String(me._id);
  const admin = !!me && me.isAdmin;
  if (venue.status !== true && !own && !admin) return null;
  return { venue, own, admin };
}

// Какие вкладки есть у заведения (partials/venueTabs.ejs). «Эфиры» — когда
// идёт эфир от его имени или есть готовые записи, «Видео» — когда есть
// готовые видео, «Меню» — когда владелец включил его и в нём есть позиции;
// владельцу одобренного — всегда: оттуда он их и заводит. Выключенного
// меню нет ни у кого — включается в настройках.
// live — идущий эфир заведения: его плашка на странице и во вкладке.
async function tabsFor(venue, manage) {
  const menuOn = !!(venue.features && venue.features.videoMenu);
  const [live, recs, videos, menu] = await Promise.all([
    Stream.findOne({ venue: venue._id, isActive: true }).select('title thumbnail viewers').lean(),
    Recording.exists({ venue: venue._id, status: 'ready' }),
    GalleryVideo.exists({ venue: venue._id, status: 'ready' }),
    menuOn ? MenuItem.exists({ venue: venue._id }) : null,
  ]);
  const mine = manage && venue.status === true;
  return { live, streams: mine || !!live || !!recs, videos: mine || !!videos, menu: menuOn && (mine || !!menu) };
}

// Вкладка идёт в индекс, как сама страница заведения: одобрено и есть описание.
const indexableVenue = (venue) => venue.status === true && !!String(venue.about || '').trim();

module.exports = { pageVenue, tabsFor, indexableVenue };
