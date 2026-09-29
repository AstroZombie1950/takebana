// Сроки хранения файлов (28.09.2026) — заготовка под рост счёта за облако.
//
// Четыре вида того, что люди загружают и что копится в Bunny без предела:
// вложения переписки (фото, видео, голосовые, кружки, документы), фото
// и видео галереи, записи эфиров. Для каждого — срок в днях: всем сразу
// (настройка в панели, вкладка «Сроки хранения») и отдельно человеку —
// поднять лимит тому, кому нужно больше (потом — пакетом подписки).
// 0 — без срока.
//
// Сейчас сроки НЕ применяются: всё хранится бессрочно, по умолчанию все
// сроки — 0. Уборки по срокам нет. Панель по заданным срокам только
// считает, сколько файлов и места ушло бы сегодня, — чтобы решать
// с цифрами. Когда начнём удалять, уборка возьмёт срок отсюда же (limits).
//
// Чей файл — того и срок: у вложения — отправителя, у остального — автора.
// Аватары, обложки и фото заведений не в счёт: они мелкие, лежат на своём
// сервере и заменяются, а не копятся.

const Setting = require('../models/Setting');
const User = require('../models/User');
const Message = require('../models/Message');
const GalleryPhoto = require('../models/GalleryPhoto');
const GalleryVideo = require('../models/GalleryVideo');
const Recording = require('../models/Recording');

const KEY = 'retention';
const DAY = 86400000;
const MAX_DAYS = 3650;
const TTL_MS = 60 * 1000;

// Порядок — от того, что хранить дольше всего, к тому, что короче
// (решение 28.09: переписка — максимально долго, эфиры — меньше всего).
// owner — чьё это, для личного срока.
const KINDS = {
  chat: { Model: Message, owner: 'sender', where: { 'attachments.0': { $exists: true } } },
  photos: { Model: GalleryPhoto, owner: 'userId', where: {} },
  videos: { Model: GalleryVideo, owner: 'userId', where: { status: { $in: ['ready', 'failed'] } } },
  recordings: { Model: Recording, owner: 'userId', where: { status: { $in: ['ready', 'failed'] } } },
};
const NAMES = Object.keys(KINDS);
const DEFAULTS = Object.fromEntries(NAMES.map((k) => [k, 0]));

let cache = null;

// Сроки для всех: { chat, photos, videos, recordings } в днях.
async function policy() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const doc = await Setting.findById(KEY).lean();
  const value = { ...DEFAULTS, ...pick(doc && doc.value) };
  cache = { at: Date.now(), value, updatedAt: doc ? doc.updatedAt : null };
  return value;
}

const updatedAt = () => (cache ? cache.updatedAt : null);

// Только известные виды и только целые дни в пределах; остальное — мимо.
// nullable — у человека пустое значение значит «как у всех».
function pick(raw, { nullable = false } = {}) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of NAMES) {
    const v = raw[k];
    if (nullable && (v === null || v === '')) { out[k] = null; continue; }
    const n = Number(v);
    if (v !== undefined && Number.isInteger(n) && n >= 0 && n <= MAX_DAYS) out[k] = n;
  }
  return out;
}

async function save(raw, by) {
  const value = { ...(await policy()), ...pick(raw) };
  await Setting.updateOne({ _id: KEY }, { $set: { value, updatedAt: new Date(), updatedBy: by || null } }, { upsert: true });
  cache = null;
  return value;
}

// Личные сроки человека: null — как у всех. Ответ — что у него осталось
// своего, null — человека нет.
async function saveFor(userId, raw) {
  const own = pick(raw, { nullable: true });
  const set = {}, unset = {};
  for (const [k, v] of Object.entries(own)) {
    if (v === null) unset['retention.' + k] = 1; else set['retention.' + k] = v;
  }
  const change = {};
  if (Object.keys(set).length) change.$set = set;
  if (Object.keys(unset).length) change.$unset = unset;
  const user = await User.findOneAndUpdate({ _id: userId }, change, { returnDocument: 'after', projection: { retention: 1 } }).lean();
  return user ? ownLimits(user) : null;
}

const ownLimits = (user) => pick(user && user.retention);

// Действующие сроки человека: личные поверх общих.
function limits(all, user) {
  return { ...all, ...ownLimits(user) };
}

// ── Что ушло бы сегодня ──
// Для каждого вида: сколько файлов старше срока и сколько места они
// занимают (у фото галереи размера в базе нет — только число). Люди
// с личным сроком считаются по своему; одинаковые сроки — одним запросом.
async function preview(all) {
  const people = await User.find({ retention: { $exists: true } }).select('retention').lean();
  const out = {};
  await Promise.all(NAMES.map(async (kind) => {
    const custom = people.filter((u) => ownLimits(u)[kind] !== undefined);
    const byDays = new Map();
    for (const u of custom) {
      const d = ownLimits(u)[kind];
      if (!byDays.has(d)) byDays.set(d, []);
      byDays.get(d).push(u._id);
    }
    const parts = [];
    if (all[kind] > 0) parts.push(older(kind, all[kind], { $nin: custom.map((u) => u._id) }));
    for (const [d, ids] of byDays) if (d > 0) parts.push(older(kind, d, { $in: ids }));
    const sums = await Promise.all(parts);
    out[kind] = sums.reduce((a, s) => ({ files: a.files + s.files, bytes: a.bytes + s.bytes }), { files: 0, bytes: 0 });
  }));
  return out;
}

async function older(kind, days, owners) {
  const { Model, owner, where } = KINDS[kind];
  const match = { ...where, [owner]: owners, createdAt: { $lt: new Date(Date.now() - days * DAY) } };
  // У сообщения файлов несколько: считаем их и складываем размеры до
  // группировки — в $group сумма по массиву не считается.
  const each = kind === 'chat'
    ? { n: { $size: '$attachments' }, b: { $sum: '$attachments.size' } }
    : { n: { $literal: 1 }, b: kind === 'photos' ? { $literal: 0 } : { $ifNull: ['$size', 0] } };
  const [r] = await Model.aggregate([
    { $match: match },
    { $project: each },
    { $group: { _id: null, files: { $sum: '$n' }, bytes: { $sum: '$b' } } },
  ]);
  return { files: r ? r.files : 0, bytes: r ? r.bytes : 0 };
}

// У кого личные сроки — для списка в панели.
function customized() {
  return User.find({ retention: { $exists: true, $ne: {} } })
    .select('nickname login email avatar role banned retention').lean();
}

module.exports = { NAMES, MAX_DAYS, policy, updatedAt, save, saveFor, limits, preview, customized, own: ownLimits };
