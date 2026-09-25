// Авторы — те, кого имеет смысл советовать: кто хоть раз выходил в эфир или
// оставил запись. Пустые аккаунты и забаненные сюда не попадают.
//
// До 15 сентября 2026 «Рекомендации» на витрине показывали четырёх случайных
// пользователей из всей базы ($sample) — включая забаненных и тех, кто ни разу
// не включал камеру. Теперь и витрина, и страница /authors берут людей отсюда.

const mongoose = require('mongoose');
const User = require('../models/User');
const Stream = require('../models/Stream');
const Recording = require('../models/Recording');
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

// Кто вообще автор: выходил в эфир (firstLiveAt проставляется навсегда)
// или у него есть готовая запись. Забаненных отсеиваем здесь же, и тех,
// кто попросил не показывать его в подборках (utils/privacy.js).
// «Сейчас в эфире» он всё равно виден: эфир он открыл сам.
async function authorIds() {
  const [everLive, withRecordings] = await Promise.all([
    Stream.distinct('userId', { firstLiveAt: { $ne: null } }),
    Recording.distinct('userId', { status: 'ready' }),
  ]);
  const all = [...new Set([...everLive, ...withRecordings].map(id))].map((x) => new mongoose.Types.ObjectId(x));
  if (!all.length) return [];
  const banned = await User.find({ _id: { $in: all }, $or: [{ banned: true }, { 'privacy.searchable': false }] }).select('_id').lean();
  const stop = new Set(banned.map((u) => id(u._id)));
  return all.filter((x) => !stop.has(id(x)));
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

module.exports = { groups, featured };
