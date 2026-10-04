// Авторы — те, кого имеет смысл советовать: кто хоть раз выходил в эфир,
// оставил запись или выложил фото или видео (с 04.10 — одно правило «есть
// что смотреть» с индексом профиля, docs/seo, задача 3). Пустые аккаунты
// и забаненные сюда не попадают.
//
// До 15 сентября 2026 «Рекомендации» на витрине показывали четырёх случайных
// пользователей из всей базы ($sample) — включая забаненных и тех, кто ни разу
// не включал камеру. Теперь и витрина, и страница /authors берут людей отсюда.

const mongoose = require('mongoose');
const User = require('../models/User');
const Stream = require('../models/Stream');
const Recording = require('../models/Recording');
const GalleryPhoto = require('../models/GalleryPhoto');
const GalleryVideo = require('../models/GalleryVideo');
const Subscription = require('../models/Subscription');
const userView = require('../utils/userView');
const privacy = require('./privacy');
const { profileUrl } = require('./profileUrl');

// Сколько человек в группе на странице авторов. Постраничной подгрузки нет:
// авторов пока десятки. Витрина просит своё число (три строки в колонке).
const GROUP_SIZE = 12;

// «Новым» автор считается месяц: столько же живёт неактивный эфир до уборки.
const NEW_AUTHOR_DAYS = 30;

const id = (v) => String(v);

function view(user, extra = {}) {
  const displayName = userView.displayName(user);
  return {
    _id: user._id,
    url: profileUrl(user),
    displayName,
    avatarStyle: userView.avatarStyle(user, displayName),
    isOnline: !!user.isOnline,
    official: privacy.isOfficial(user),
    ...extra,
  };
}

// Идущие эфиры вместе с авторами: из них собирается группа «Сейчас в эфире»,
// и по ним же помечаются авторы в остальных группах.
async function liveStreams() {
  const streams = await Stream.find({ isActive: true })
    .sort({ viewers: -1, startedAt: -1 })
    .populate('userId', 'nickname login email avatar isOnline banned role')
    .select('title viewers userId')
    .lean();
  return streams.filter((s) => s.userId && !s.userId.banned);
}

// Кто вообще автор: выходил в эфир (firstLiveAt проставляется навсегда),
// есть готовая запись, фото или готовое видео галереи. До 04.10 фото и видео
// не считались, и человек с одной галереей был в индексе, но ни в одной
// подборке — сиротой, до которого по ссылкам не дойти. Забаненных отсеиваем
// здесь же, и тех, кто попросил не показывать его в подборках (utils/privacy.js).
// «Сейчас в эфире» он всё равно виден: эфир он открыл сам.
async function authorIds() {
  const [everLive, withRecordings, withPhotos, withVideos] = await Promise.all([
    Stream.distinct('userId', { firstLiveAt: { $ne: null } }),
    Recording.distinct('userId', { status: 'ready' }),
    GalleryPhoto.distinct('userId'),
    GalleryVideo.distinct('userId', { status: 'ready' }),
  ]);
  const all = [...new Set([...everLive, ...withRecordings, ...withPhotos, ...withVideos].map(id))].map((x) => new mongoose.Types.ObjectId(x));
  if (!all.length) return [];
  // Только живые аккаунты: фото удалённого человека может пережить его
  // запись в базе, и «Все авторы» насчитывали людей, которых не показать.
  return User.distinct('_id', { _id: { $in: all }, banned: { $ne: true }, 'privacy.searchable': { $ne: false } });
}

// Подписчики скопом: по запросу на человека это был бы десяток запросов
// на страницу.
async function followersOf(ids) {
  if (!ids.length) return new Map();
  const rows = await Subscription.aggregate([
    { $match: { subscribedToId: { $in: ids } } },
    { $group: { _id: '$subscribedToId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [id(r._id), r.count]));
}

/**
 * Группы страницы /authors. Пустые группы вызывающий не рисует: на старте
 * авторов мало, и пустой заголовок хуже его отсутствия.
 *
 * live     — сейчас в эфире, у каждого свой эфир для ссылки
 * popular  — по числу подписчиков; без единого подписчика группы нет
 * fresh    — появились недавно (порядок регистрации — по _id)
 * recorded — у кого есть записи, новее сверху
 */
// viewer — кто смотрит: от него зависит, чьё «в сети» видно.
async function groups({ limit = GROUP_SIZE, viewer = null } = {}) {
  const [streams, ids] = await Promise.all([liveStreams(), authorIds()]);
  await privacy.maskPresence(viewer, streams.map((s) => s.userId));

  const live = streams.slice(0, limit).map((s) => view(s.userId, {
    stream: { _id: s._id, title: s.title, viewers: s.viewers },
  }));
  const liveIds = new Set(live.map((a) => id(a._id)));

  // Остальные группы собираются из авторов, кроме тех, кто уже показан
  // в «Сейчас в эфире»: на десятке человек повтор бросается в глаза.
  const rest = ids.filter((x) => !liveIds.has(id(x)));
  if (!rest.length) return { live, popular: [], fresh: [], recorded: [] };

  const [users, followers, recent] = await Promise.all([
    User.find({ _id: { $in: rest } }).select('nickname login email avatar isOnline role').lean().then((u) => privacy.maskPresence(viewer, u)),
    followersOf(rest),
    // Последняя запись каждого — по ней сортируется группа «С записями».
    Recording.aggregate([
      { $match: { userId: { $in: rest }, status: 'ready' } },
      { $group: { _id: '$userId', last: { $max: '$createdAt' }, count: { $sum: 1 } } },
    ]),
  ]);

  const byId = new Map(users.map((u) => [id(u._id), u]));
  const lastRecording = new Map(recent.map((r) => [id(r._id), r]));
  const person = (x, extra) => {
    const user = byId.get(id(x));
    return user ? view(user, { followersCount: followers.get(id(x)) || 0, ...extra }) : null;
  };

  // Популярные: только те, на кого хоть кто-то подписан, — иначе это просто
  // список авторов под чужим заголовком.
  const popular = rest
    .filter((x) => (followers.get(id(x)) || 0) > 0)
    .sort((a, b) => (followers.get(id(b)) || 0) - (followers.get(id(a)) || 0))
    .slice(0, limit)
    .map((x) => person(x))
    .filter(Boolean);

  // Новые: время регистрации лежит в самом ObjectId, отдельного поля
  // у пользователя нет. Порядок — от новых к старым.
  const freshCutoff = Date.now() - NEW_AUTHOR_DAYS * 24 * 60 * 60 * 1000;
  const fresh = rest
    .filter((x) => x.getTimestamp().getTime() >= freshCutoff)
    .sort((a, b) => b.getTimestamp() - a.getTimestamp())
    .slice(0, limit)
    .map((x) => person(x))
    .filter(Boolean);

  // С записями: новее сверху, у каждого — сколько их.
  const recorded = rest
    .filter((x) => lastRecording.has(id(x)))
    .sort((a, b) => lastRecording.get(id(b)).last - lastRecording.get(id(a)).last)
    .slice(0, limit)
    .map((x) => person(x, { recordings: lastRecording.get(id(x)).count }))
    .filter(Boolean);

  return { live, popular, fresh, recorded };
}

// Для витрины: несколько авторов в боковую колонку. Сначала те, кто в эфире,
// потом популярные, потом новые — и только если есть кого показать.
//
// Подборка кэшируется: groups() — это distinct по всем эфирам и записям
// и выборка всех авторов, а витрину открывает каждый. «В сети» живое и
// у каждого зрителя своё — его берём свежим и маскируем уже после кэша.
const FEATURED_TTL_MS = 45 * 1000;
const featuredCache = new Map(); // limit → { at, list }

async function featured(limit = 3, viewer = null) {
  let hit = featuredCache.get(limit);
  if (!hit || Date.now() - hit.at > FEATURED_TTL_MS) {
    const { live, popular, fresh, recorded } = await groups({ limit });
    const list = [];
    const seen = new Set();
    for (const person of [...live, ...popular, ...fresh, ...recorded]) {
      if (seen.has(id(person._id))) continue;
      seen.add(id(person._id));
      list.push(person);
      if (list.length === limit) break;
    }
    hit = { at: Date.now(), list };
    featuredCache.set(limit, hit);
  }
  if (!hit.list.length) return [];
  const online = new Set((await User.find({ _id: { $in: hit.list.map((p) => p._id) }, isOnline: true }).select('_id').lean()).map((u) => id(u._id)));
  const picked = hit.list.map((p) => ({ ...p, isOnline: online.has(id(p._id)) }));
  return privacy.maskPresence(viewer, picked);
}

// Все авторы списком — /authors/all (04.10, docs/seo, задача 36): любой
// автор в трёх кликах от главной. show — кого показать: SHOWS или все;
// sort — порядок: SORTS или новые (по времени регистрации, оно в _id).
// Список считается целиком и режется в памяти: авторов сотни, не миллионы;
// станет тесно — переводить на агрегацию.
const ALL_PAGE = 24;
const SHOWS = ['live', 'recordings', 'media'];
const SORTS = ['popular', 'name'];

async function all({ show = '', sort = '', page = 1, viewer = null } = {}) {
  const [streams, ids] = await Promise.all([liveStreams(), authorIds()]);
  const liveBy = new Map(streams.map((s) => [id(s.userId._id), s]));
  const [followers, recs, photos, videos] = await Promise.all([
    followersOf(ids),
    Recording.aggregate([{ $match: { userId: { $in: ids }, status: 'ready' } }, { $group: { _id: '$userId', count: { $sum: 1 } } }]),
    show === 'media' ? GalleryPhoto.distinct('userId', { userId: { $in: ids } }) : [],
    show === 'media' ? GalleryVideo.distinct('userId', { userId: { $in: ids }, status: 'ready' }) : [],
  ]);
  const recCount = new Map(recs.map((r) => [id(r._id), r.count]));
  const media = new Set([...photos, ...videos].map(id));

  let pool = ids;
  if (show === 'live') pool = pool.filter((x) => liveBy.has(id(x)));
  else if (show === 'recordings') pool = pool.filter((x) => recCount.has(id(x)));
  else if (show === 'media') pool = pool.filter((x) => media.has(id(x)));

  const users = await User.find({ _id: { $in: pool } }).select('nickname login email avatar isOnline role').lean();
  let people = users.map((u) => view(u, {
    followersCount: followers.get(id(u._id)) || 0,
    recordings: recCount.get(id(u._id)) || 0,
    ...(liveBy.has(id(u._id)) ? { stream: (({ _id, title, viewers }) => ({ _id, title, viewers }))(liveBy.get(id(u._id))) } : {}),
  }));
  const born = (p) => p._id.getTimestamp();
  if (sort === 'popular') people.sort((a, b) => b.followersCount - a.followersCount || born(b) - born(a));
  else if (sort === 'name') people.sort((a, b) => a.displayName.localeCompare(b.displayName));
  else people.sort((a, b) => born(b) - born(a));

  const total = people.length;
  const pages = Math.max(1, Math.ceil(total / ALL_PAGE));
  const current = Math.min(Math.max(1, page), pages);
  people = people.slice((current - 1) * ALL_PAGE, current * ALL_PAGE);
  await privacy.maskPresence(viewer, people);
  return { people, total, page: current, pages };
}

// Сколько всего авторов — карте сайта, чтобы перечислить страницы /authors/all.
async function allCount() {
  return (await authorIds()).length;
}

module.exports = { groups, featured, all, allCount, ALL_PAGE, SHOWS, SORTS };
