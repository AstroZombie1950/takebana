// Лимиты (15.10.2026) — из панели, вкладка «Лимиты», а не из кода.
//
// Что и сколько люди загружают и записывают: кружки, голосовые, вложения
// переписки, фото и видео галереи, записи эфиров, частота вложений — и два
// порога сервера: свободное место под загрузки и баланс Bunny. Общие
// значения лежат в Setting 'limits'; личные (поле limits у человека,
// задаются в его профиле в панели) — поверх общих: заготовка под платную
// подписку. Сервера (диск, Bunny) личными не бывают.
//
// Общие читаются синхронно — get(): в памяти, из базы при запуске и раз
// в минуту (на случай второго процесса), правка из панели — сразу.
// Действующие для человека — forUser(): личные поверх общих, с кэшем на
// минуту (лимит вложений спрашивает на каждый файл).

const Setting = require('../models/Setting');
const User = require('../models/User');
const errorLog = require('./errorLog');

const KEY = 'limits';
const REFRESH_MS = 60 * 1000;
const USER_TTL_MS = 60 * 1000;

// def — как было в коде до 15.10 (порог диска и частота вложений — как в
// .env, если там заданы). Пределы — что выдержат сервер и плеер: кружок
// пишется 1,2 Мбит/с (5 минут — ~45 МБ), голосовое — 32 кбит/с, видео
// пережимается примерно за свою длину, фото галереи держатся в памяти
// пачкой по 20, незаконченные видео лежат на нашем диске (2 × вес, S8),
// запись эфира — ~1,2 ГБ в час на диске, пока идёт эфир.
// own: false — порог сервера, личным не бывает.
const FIELDS = {
  roundSeconds: { def: 60, min: 15, max: 300 },
  voiceSeconds: { def: 300, min: 30, max: 1800 },
  chatVideoMinutes: { def: 10, min: 1, max: 60 },
  chatVideoMb: { def: 200, min: 10, max: 2048 },
  chatPhotoMb: { def: 10, min: 1, max: 50 },
  chatDocMb: { def: 25, min: 1, max: 500 },
  chatArchiveMb: { def: 50, min: 1, max: 1024 },
  attachPer10Min: { def: Number(process.env.RATE_LIMIT_ATTACH) || 60, min: 1, max: 1000 },
  videoMinutes: { def: 60, min: 1, max: 180 },
  videoMb: { def: 8192, min: 512, max: 16384 },
  galleryVideos: { def: 30, min: 1, max: 1000 },
  galleryPhotos: { def: 100, min: 1, max: 10000 },
  galleryPhotoMb: { def: 10, min: 1, max: 20 },
  recordingHours: { def: 6, min: 1, max: 24 },
  diskMinFreeGb: { def: Number(process.env.UPLOAD_MIN_FREE_GB) || 20, min: 5, max: 1000, own: false },
  bunnyMinUsd: { def: 10, min: 0, max: 10000, own: false },
};
const OWN = Object.keys(FIELDS).filter((k) => FIELDS[k].own !== false);
const DEFAULTS = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.def]));

let current = { ...DEFAULTS };
let updatedAt = null;
const users = new Map(); // id → { at, value }

// Только известные поля, целые и в пределах; остальное — мимо.
// nullable — у человека пустое значение значит «как у всех».
function pick(raw, { keys = Object.keys(FIELDS), nullable = false } = {}) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of keys) {
    const f = FIELDS[k];
    const v = raw[k];
    if (nullable && v === null) { out[k] = null; continue; }
    const n = Number(v);
    if (v !== undefined && v !== '' && v !== null && Number.isInteger(n) && n >= f.min && n <= f.max) out[k] = n;
  }
  return out;
}

const get = () => current;

async function load() {
  try {
    const doc = await Setting.findById(KEY).lean();
    current = { ...DEFAULTS, ...pick(doc && doc.value) };
    updatedAt = doc ? doc.updatedAt : null;
  } catch (e) {
    errorLog.server(e, 'limits.load');
  }
  return current;
}

async function save(raw, by) {
  const value = { ...(await load()), ...pick(raw) };
  const at = new Date();
  await Setting.updateOne({ _id: KEY }, { $set: { value, updatedAt: at, updatedBy: by || null } }, { upsert: true });
  current = value;
  updatedAt = at;
  return value;
}

// ── Личные ──
const ownOf = (user) => pick(user && user.limits, { keys: OWN });

// Действующие для человека: личные поверх общих. user — документ с полем
// limits или id. Нет человека — общие.
async function forUser(user) {
  if (!user) return current;
  if (typeof user === 'object' && !user._bsontype && 'limits' in user) return { ...current, ...ownOf(user) };
  const id = String(user._id || user);
  const hit = users.get(id);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return { ...current, ...hit.value };
  let own = {};
  try {
    own = ownOf(await User.findById(id).select('limits').lean());
  } catch (e) {
    errorLog.server(e, 'limits.forUser', { user: id });
  }
  users.set(id, { at: Date.now(), value: own });
  if (users.size > 5000) users.delete(users.keys().next().value);
  return { ...current, ...own };
}

// Личные лимиты человека: null — как у всех. Ответ — что у него осталось
// своего, null — человека нет.
async function saveFor(userId, raw) {
  const own = pick(raw, { keys: OWN, nullable: true });
  const set = {}, unset = {};
  for (const [k, v] of Object.entries(own)) {
    if (v === null) unset['limits.' + k] = 1; else set['limits.' + k] = v;
  }
  const change = {};
  if (Object.keys(set).length) change.$set = set;
  if (Object.keys(unset).length) change.$unset = unset;
  const user = Object.keys(change).length
    ? await User.findOneAndUpdate({ _id: userId }, change, { returnDocument: 'after', projection: { limits: 1 } }).lean()
    : await User.findById(userId).select('limits').lean();
  users.delete(String(userId));
  return user ? ownOf(user) : null;
}

// У кого личные лимиты — для списка в панели.
function customized() {
  return User.find({ limits: { $exists: true, $ne: {} } }).select('nickname login email avatar role limits').limit(500).lean();
}

function start() {
  load();
  setInterval(load, REFRESH_MS).unref();
}

// Производные. l — действующие лимиты (get() или forUser()).
const MB = 1048576;
const videoSeconds = (l = current) => l.videoMinutes * 60;
const videoBytes = (l = current) => l.videoMb * MB;
// Незаконченное на нашем диске — два ролика по потолку (S8).
const pendingBytes = (l = current) => 2 * videoBytes(l);
// Кружок пишется 1,2 Мбит/с со звуком: ~0,16 МБ в секунду; с запасом
// на чужой кодек — 0,25 и 10 МБ сверху, но не меньше прежних 60.
const roundMb = (l = current) => Math.max(60, Math.ceil(l.roundSeconds * 0.25) + 10);
// Голосовое — 32 кбит/с, ~0,25 МБ в минуту; с запасом — 1 МБ в минуту, не меньше прежних 10.
const voiceMb = (l = current) => Math.max(10, Math.ceil(l.voiceSeconds / 60) + 5);
// Наибольший файл переписки — предел multer (routes/streaming/uploads.js).
const chatMaxMb = (l = current) => Math.max(l.chatVideoMb, l.chatPhotoMb, l.chatDocMb, l.chatArchiveMb, roundMb(l), voiceMb(l));
const recordingMs = (l = current) => l.recordingHours * 3600 * 1000;

module.exports = {
  FIELDS, OWN, DEFAULTS, get, load, save, start, pick, forUser, saveFor, ownOf, customized,
  updatedAt: () => updatedAt,
  videoSeconds, videoBytes, pendingBytes, roundMb, voiceMb, chatMaxMb, recordingMs,
};
