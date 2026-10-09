// Лента главной (28.09.2026): записи эфиров и видео галереи одной сеткой,
// новые сверху, — как лента YouTube или Instagram. До неё на главной были
// восемь самых просматриваемых записей, и при пустом эфире страница
// выглядела пустой.
//
// Несколько видов — несколько коллекций, поэтому страницы листаются курсором
// по дате, а не номером: из каждой берём limit + 1 строго раньше курсора,
// сливаем и режем. Номер страницы с несколькими источниками дал бы дубли
// и пропуски.
//
// Не показываем: 18+ (подтверждение возраста — на странице записи, в ленте
// его спросить негде), авторов под ограничением модерации и тех, кто закрыл
// свой канал от смотрящего (utils/restrict.js).
//
// С 04.10 та же лента — и раздел «Лента» (/feed): фото и видео, которые
// выкладывают люди, без записей эфиров (они — в «Популярном»). Какие виды
// брать — kinds. С 09.10 в «Ленте» — посты (models/Post.js) и прежние фото
// и видео, что не из постов (фото и видео поста показывает сам пост);
// фильтр по теме (topic, utils/topics.js) — только посты: у фото и видео
// темы нет. author — лента одного человека, на его странице.

const Recording = require('../models/Recording');
const GalleryVideo = require('../models/GalleryVideo');
const GalleryPhoto = require('../models/GalleryPhoto');
const Post = require('../models/Post');
const topics = require('./topics');
const RecordingComment = require('../models/RecordingComment');
const RecordingReaction = require('../models/RecordingReaction');
const User = require('../models/User');
const userView = require('./userView');
const { VENUE_AUTHOR, venueAuthor } = require('./venueAuthor');
const { profileUrl } = require('./profileUrl');
const { canModerate } = require('../middleware/auth');

const PAGE = 24;
const AUTHOR = 'nickname login email avatar';

// where — что из коллекции показывать вообще: у фото нет статуса обработки.
// venue — у вида есть «от имени заведения».
const SOURCES = [
  { kind: 'recording', Model: Recording, href: '/recording/', venue: true, where: { status: 'ready', isAdult: { $ne: true } }, fields: 'title description duration thumb views likes comments createdAt recordedAt userId venue' },
  { kind: 'video', Model: GalleryVideo, href: '/video/', venue: true, where: { status: 'ready' }, fields: 'title description duration thumb views likes comments createdAt userId venue' },
  { kind: 'photo', Model: GalleryPhoto, href: '/photo/', where: {}, fields: 'url caption likes comments createdAt userId' },
  { kind: 'post', Model: Post, href: '/post/', where: { status: 'ready' }, fields: 'text topic media status likes comments createdAt userId' },
];
const HOME = ['recording', 'video'];
const POSTS = ['post', 'photo', 'video'];

// before — дата последней показанной карточки (курсор из прошлой страницы).
// topic — код темы или раздела, author — id автора; свои посты в работе
// (ролики пережимаются) автор видит в своей ленте.
// Ответ: карточки и курсор следующей страницы (null — дальше пусто).
async function page({ before = null, viewer = null, limit = PAGE, kinds = HOME, topic = '', author = null } = {}) {
  const [banned, hiders] = await Promise.all([
    User.distinct('_id', { banned: true }),
    viewer ? User.distinct('_id', { restricted: viewer }) : [],
  ]);
  const skip = banned.concat(hiders);
  const at = before ? { createdAt: { $lt: before } } : {};
  const who = author ? { userId: author } : skip.length ? { userId: { $nin: skip } } : {};
  const codes = topic ? topics.matching(topic) : null;
  // Посты в ленте — значит их фото и видео отдельными карточками не идут.
  const withPosts = kinds.includes('post');
  const own = !!author && !!viewer && String(author) === String(viewer);
  const sources = SOURCES.filter((src) => kinds.includes(src.kind) && (!codes || src.kind === 'post'));

  const lists = await Promise.all(sources.map(({ kind, Model, href, venue, where, fields }) =>
    Model.find({
      ...where,
      ...(withPosts && kind !== 'post' && kind !== 'recording' ? { post: null } : {}),
      ...(kind === 'post' && own ? { status: { $in: ['ready', 'processing'] } } : {}),
      ...(kind === 'post' && codes ? { topic: { $in: codes } } : {}),
      ...at, ...who,
    })
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .select(fields)
      .populate('userId', AUTHOR)
      .populate(venue ? { path: 'venue', select: VENUE_AUTHOR } : [])
      .lean()
      .then((rows) => rows.map((r) => ({ ...r, kind, href: href + r._id })))));

  const merged = lists.flat().sort((a, b) => b.createdAt - a.createdAt);
  const items = merged.slice(0, limit).filter((r) => r.userId);
  const next = merged.length > limit ? merged[limit - 1].createdAt : null;
  const media = await mediaOf(items.filter((r) => r.kind === 'post'));

  // Автора удалили, а ролик ещё не убран — карточка без автора не нужна.
  return {
    items: items.map((r) => card(r, media)),
    next: next ? next.toISOString() : null,
  };
}

// Фото и видео постов страницы — двумя запросами на всю страницу.
// → Map id → { kind, href, url (снимок или обложка), w, h, duration, ready }.
async function mediaOf(posts) {
  const ids = (kind) => posts.flatMap((p) => p.media.filter((m) => m.kind === kind).map((m) => m.ref));
  const [photos, videos] = await Promise.all([
    GalleryPhoto.find({ _id: { $in: ids('photo') } }).select('url width height').lean(),
    GalleryVideo.find({ _id: { $in: ids('video') } }).select('thumb duration status').lean(),
  ]);
  return new Map([
    ...photos.map((p) => [String(p._id), { kind: 'photo', href: '/photo/' + p._id, url: p.url, w: p.width || 0, h: p.height || 0 }]),
    ...videos.map((v) => [String(v._id), { kind: 'video', href: '/video/' + v._id, url: (v.thumb && v.thumb.url) || '', duration: v.duration || 0, ready: v.status === 'ready' }]),
  ]);
}

function card(r, media) {
  const user = r.userId;
  const displayName = userView.displayName(user);
  return {
    _id: r._id,
    kind: r.kind,
    href: r.href,
    title: r.title || '',
    // Фото — сам снимок, у роликов — обложка, у поста — первое его медиа.
    thumb: r.kind === 'photo' ? r.url : r.kind === 'post' ? null : (r.thumb && r.thumb.url) || null,
    text: (r.kind === 'photo' ? r.caption : r.kind === 'post' ? r.text : r.description) || '',
    // Пост: тема и медиа по порядку; в работе — ролики ещё пережимаются.
    topic: r.topic || '',
    media: r.kind === 'post' ? r.media.map((m) => media.get(String(m.ref))).filter(Boolean) : [],
    processing: r.status === 'processing',
    duration: r.duration || 0,
    views: r.views || 0,
    likes: r.likes || 0,
    comments: r.comments || 0,
    // У записи — когда шёл эфир; курсор при этом — createdAt.
    at: r.recordedAt || r.createdAt,
    // Чей пост на самом деле — даже от имени заведения: свой не жалуются.
    ownerId: String(user._id),
    author: venueAuthor(r.venue) || { displayName, url: profileUrl(user), avatarStyle: userView.avatarStyle(user, displayName) },
  };
}

// «Лента» (05.10): под постом — лайкнул ли я и последние комментарии,
// чтобы ответить и оценить, не открывая страницу публикации. По запросу
// на страницу ленты, а не на пост: оценки — по индексу (recordingId, userId),
// комментарии — по (recordingId, createdAt), последние TALK на пост ($topN).
// С 06.10 у каждого — id, ник для ответа и можно ли удалить: удаляют
// автор комментария, автор поста и модератор (как routes/watch.js).
// Телефон показывает из них два последних (css/feed.css), широкий экран —
// все TALK с прокруткой в колонке.
const TALK = 10;

async function withTalk(items, viewer) {
  if (!items.length) return items;
  const ids = items.map((i) => i._id);
  const [mine, recent, me] = await Promise.all([
    viewer ? RecordingReaction.find({ recordingId: { $in: ids }, userId: viewer, value: 1 }).select('recordingId').lean() : [],
    RecordingComment.aggregate([
      { $match: { recordingId: { $in: ids } } },
      { $group: { _id: '$recordingId', last: { $topN: { n: TALK, sortBy: { createdAt: -1 }, output: { _id: '$_id', text: '$text', userId: '$userId', createdAt: '$createdAt' } } } } },
    ]),
    viewer ? User.findById(viewer).select('role').lean() : null,
  ]);
  const moderator = canModerate(me);
  const authors = await User.find({ _id: { $in: recent.flatMap((r) => r.last.map((c) => c.userId)) } }).select(AUTHOR).lean();
  const byUser = new Map(authors.map((u) => [String(u._id), u]));
  const liked = new Set(mine.map((r) => String(r.recordingId)));
  const owner = new Map(items.map((i) => [String(i._id), i.ownerId]));
  const talk = new Map(recent.map((r) => [String(r._id), r.last
    .filter((c) => byUser.has(String(c.userId)))
    .reverse() // старые сверху, как на странице разговора
    .map((c) => {
      const u = byUser.get(String(c.userId));
      const own = !!viewer && String(c.userId) === String(viewer);
      return {
        _id: String(c._id), text: c.text, name: userView.displayName(u), nick: u.nickname || '', url: profileUrl(u),
        mine: own, canDelete: own || (!!viewer && owner.get(String(r._id)) === String(viewer)) || moderator,
      };
    })]));
  return items.map((i) => ({ ...i, liked: liked.has(String(i._id)), talk: talk.get(String(i._id)) || [] }));
}

// Курсор из адреса: ISO-дата, чужое — первая страница.
function cursor(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const d = new Date(raw);
  return isNaN(d) ? null : d;
}

module.exports = { page, withTalk, cursor, PAGE, POSTS };
