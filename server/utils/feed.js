// Лента главной (28.09.2026): записи эфиров и видео галереи одной сеткой,
// новые сверху, — как лента YouTube или Instagram. До неё на главной были
// восемь самых просматриваемых записей, и при пустом эфире страница
// выглядела пустой.
//
// Два вида — две коллекции, поэтому страницы листаются курсором по дате,
// а не номером: из каждой берём limit + 1 строго раньше курсора, сливаем
// и режем. Номер страницы с двумя источниками дал бы дубли и пропуски.
//
// Не показываем: 18+ (подтверждение возраста — на странице записи, в ленте
// его спросить негде), авторов под ограничением модерации и тех, кто закрыл
// свой канал от смотрящего (utils/restrict.js).

const Recording = require('../models/Recording');
const GalleryVideo = require('../models/GalleryVideo');
const User = require('../models/User');
const userView = require('./userView');
const { VENUE_AUTHOR, venueAuthor } = require('./venueAuthor');
const { profileUrl } = require('./profileUrl');

const PAGE = 24;
const AUTHOR = 'nickname login email avatar';

const SOURCES = [
  { kind: 'recording', Model: Recording, href: '/recording/', extra: { isAdult: { $ne: true } }, fields: 'title duration thumb views createdAt recordedAt userId venue' },
  { kind: 'video', Model: GalleryVideo, href: '/video/', extra: {}, fields: 'title duration thumb views createdAt userId venue' },
];

// before — дата последней показанной карточки (курсор из прошлой страницы).
// Ответ: карточки и курсор следующей страницы (null — дальше пусто).
async function page({ before = null, viewer = null, limit = PAGE } = {}) {
  const [banned, hiders] = await Promise.all([
    User.distinct('_id', { banned: true }),
    viewer ? User.distinct('_id', { restricted: viewer }) : [],
  ]);
  const skip = banned.concat(hiders);
  const at = before ? { createdAt: { $lt: before } } : {};

  const lists = await Promise.all(SOURCES.map(({ kind, Model, href, extra, fields }) =>
    Model.find({ status: 'ready', ...extra, ...at, ...(skip.length ? { userId: { $nin: skip } } : {}) })
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .select(fields)
      .populate('userId', AUTHOR)
      .populate('venue', VENUE_AUTHOR)
      .lean()
      .then((rows) => rows.map((r) => ({ ...r, kind, href: href + r._id })))));

  const merged = lists.flat().sort((a, b) => b.createdAt - a.createdAt);
  const items = merged.slice(0, limit);
  const next = merged.length > limit ? items[items.length - 1].createdAt : null;

  // Автора удалили, а ролик ещё не убран — карточка без автора не нужна.
  return {
    items: items.filter((r) => r.userId).map(card),
    next: next ? next.toISOString() : null,
  };
}

function card(r) {
  const user = r.userId;
  const displayName = userView.displayName(user);
  return {
    _id: r._id,
    kind: r.kind,
    href: r.href,
    title: r.title || '',
    thumb: (r.thumb && r.thumb.url) || null,
    duration: r.duration || 0,
    views: r.views || 0,
    // У записи — когда шёл эфир; курсор при этом — createdAt.
    at: r.recordedAt || r.createdAt,
    author: venueAuthor(r.venue) || { displayName, url: profileUrl(user), avatarStyle: userView.avatarStyle(user, displayName) },
  };
}

// Курсор из адреса: ISO-дата, чужое — первая страница.
function cursor(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const d = new Date(raw);
  return isNaN(d) ? null : d;
}

module.exports = { page, cursor };
