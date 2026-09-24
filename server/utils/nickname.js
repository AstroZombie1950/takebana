// Никнейм — то, под чем человека видят на сайте: в переписке, профиле,
// чате эфира, поиске. Уникальный, латиницей. Имя (User.login) — свободная
// строка на любом языке, пока нигде не показывается (решение 18.09.2026).
//
// Правила: 3–20 символов, латинские буквы, цифры и «_», первая — буква.
// Хранится в нижнем регистре: «Anna» и «anna» — один ник. Служебные слова
// заняты навсегда. Менять — не чаще раза в 30 дней; первый выданный
// автоматически ник сменить можно сразу.

const RULE = /^[a-z][a-z0-9_]{2,19}$/;
const CHANGE_EVERY_MS = 30 * 24 * 3600 * 1000;
const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'moderator', 'mod',
  'takebana', 'official', 'staff', 'team', 'api', 'www', 'mail', 'settings', 'login',
  'logout', 'register', 'studio', 'stream', 'search', 'about', 'null', 'undefined',
]);

// Кириллица → латиница для ника, выданного автоматически из имени или почты.
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

// Почему ник не годится: 'format' | 'reserved' — или null. Список RESERVED —
// против самозванцев, поэтому официальному аккаунту (администратору,
// utils/privacy.js) он не мешает: @takebana и @support заводятся им.
function problem(nick, { official = false } = {}) {
  if (!RULE.test(nick)) return 'format';
  if (RESERVED.has(nick) && !official) return 'reserved';
  return null;
}

// Когда можно сменить в следующий раз; null — можно сейчас.
function nextChangeAt(user) {
  const at = user && user.nicknameChangedAt;
  if (!at) return null;
  const next = new Date(at.getTime() + CHANGE_EVERY_MS);
  return next > new Date() ? next : null;
}

// Заготовка ника из имени или почты: translit, только разрешённые знаки,
// первая — буква, длина до 16 (остаток — под цифры при совпадении).
function seed(source) {
  let s = normalize(source).split('@')[0]
    .replace(/[а-яё]/g, (c) => TRANSLIT[c] || '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 16);
  if (s.length < 3 || RESERVED.has(s)) s = ('user_' + s).replace(/_+$/, '').slice(0, 16);
  return s.length < 3 ? 'user' : s;
}

// Свободный ник из заготовки: как есть, иначе с цифрами на конце.
async function free(User, source, selfId) {
  const base = seed(source);
  for (let i = 0; i < 20; i++) {
    const nick = i === 0 ? base : base + String(Math.floor(Math.random() * 10 ** Math.min(2 + (i >> 2), 4))).padStart(2, '0');
    if (problem(nick)) continue;
    const taken = await User.exists({ nickname: nick, ...(selfId ? { _id: { $ne: selfId } } : {}) });
    if (!taken) return nick;
  }
  return 'user' + Date.now().toString(36);
}

// Аккаунтам, заведённым до ников, — ник из имени или почты. При каждом
// запуске: находит только тех, у кого его ещё нет.
async function ensureAll(User) {
  const rows = await User.find({ nickname: { $in: [null, ''] } }).select('login email').lean();
  for (const u of rows) {
    const nick = await free(User, u.login || u.email || 'user', u._id);
    await User.updateOne({ _id: u._id, nickname: { $in: [null, ''] } }, { $set: { nickname: nick } }).catch(() => {});
  }
  if (rows.length) console.log(`[nickname] выдано ников: ${rows.length}`);
}

module.exports = { RULE, TRANSLIT, normalize, problem, nextChangeAt, free, ensureAll };
