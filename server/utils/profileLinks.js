// Ссылки профиля: свой сайт и пять сетей (решение 24.09.2026).
//
// Главное правило: у сетей мы не храним адрес, который прислал человек.
// Храним только логин (у WhatsApp и Telegram по номеру — номер), а ссылку
// каждый раз собираем сами по своему шаблону. Подсунуть в «Instagram»
// ссылку на свой сайт или короткую ссылку на что угодно нельзя в принципе:
// из присланного берётся только логин, и лишь если домен — самой сети.
//
// Принимаем два вида: логин (@name или name) либо полный адрес этой сети.
// Короткие ссылки (vm.tiktok.com, youtu.be), приглашения в группы, ссылки
// на отдельные ролики и посты — нет: куда они ведут, не проверить.
// Свой сайт — одна ссылка целиком, http или https.

const KINDS = ['site', 'youtube', 'instagram', 'tiktok', 'telegram', 'whatsapp'];
// Названия сетей — собственные имена, не переводятся. У сайта подпись из словаря.
const NAMES = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', telegram: 'Telegram', whatsapp: 'WhatsApp' };

// Ошибка поля — русская строка-ключ словаря сервера (utils/i18n.js).
const ERRORS = {
  site: 'Сайт: нужна ссылка вида https://example.com',
  youtube: 'YouTube: нужен @канал или ссылка youtube.com/@канал',
  instagram: 'Instagram: нужен логин или ссылка instagram.com/логин',
  tiktok: 'TikTok: нужен @логин или ссылка tiktok.com/@логин',
  telegram: 'Telegram: нужен логин, номер телефона или ссылка t.me/логин',
  whatsapp: 'WhatsApp: нужен номер телефона или ссылка wa.me/номер',
};

const YT_TABS = new Set(['videos', 'shorts', 'streams', 'featured', 'playlists', 'community', 'about', 'podcasts', 'releases']);

// Разделы Instagram, которые выглядят как логин в адресе, но логином не являются.
const IG_RESERVED = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'tv', 'direct', 'about', 'developer', 'legal']);

// Номер: цифры с необязательным «+», пробелы, скобки и дефисы — оформление.
// Российская привычка 8XXXXXXXXXX — это +7. Длина по E.164: 10–15 цифр.
function phone(raw) {
  const s = raw.replace(/[\s()-]/g, '');
  if (!/^\+?\d{10,15}$/.test(s)) return null;
  const d = s.replace('+', '');
  return !s.startsWith('+') && d.length === 11 && d[0] === '8' ? '7' + d.slice(1) : d;
}

// Адрес сети: хост без www. и m., путь без пустых частей. null — это не
// адрес, а логин или номер. Адрес — только с косой чертой: логины бывают
// с точкой (ivan.petrov), и по точке их не отличить от домена.
function address(raw) {
  if (!raw.includes('/') || /\s/.test(raw)) return null;
  let u;
  try { u = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : 'https://' + raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return { host: u.hostname.toLowerCase().replace(/^(www|m)\./, ''), parts: u.pathname.split('/').filter(Boolean), query: u.searchParams };
}

// Разбор по сетям: из адреса или логина — хранимое значение, либо null.
const PARSE = {
  youtube(raw) {
    const a = address(raw);
    if (!a) return /^@?[\w.-]{3,30}$/.test(raw) ? '@' + raw.replace(/^@/, '') : null;
    if (a.host !== 'youtube.com') return null;
    // Адрес канала часто копируют с вкладки — /videos, /shorts: её отбрасываем.
    if (YT_TABS.has(a.parts[a.parts.length - 1])) a.parts.pop();
    const [first, second] = a.parts;
    if (a.parts.length === 1 && /^@[\w.-]{3,30}$/.test(first)) return first;
    // Старые адреса каналов YouTube всё ещё открывает.
    if (first === 'channel' && /^UC[\w-]{22}$/.test(second || '')) return 'channel/' + second;
    if ((first === 'c' || first === 'user') && /^[\w.-]{1,100}$/.test(second || '')) return first + '/' + second;
    return null;
  },
  instagram(raw) {
    const a = address(raw);
    const name = a ? (a.host === 'instagram.com' && a.parts.length === 1 ? a.parts[0] : '') : raw.replace(/^@/, '');
    return /^[\w.]{1,30}$/.test(name) && !IG_RESERVED.has(name.toLowerCase()) ? name.toLowerCase() : null;
  },
  tiktok(raw) {
    const a = address(raw);
    const name = a ? (a.host === 'tiktok.com' && a.parts.length === 1 && a.parts[0][0] === '@' ? a.parts[0].slice(1) : '') : raw.replace(/^@/, '');
    return /^[\w.]{2,24}$/.test(name) ? name.toLowerCase() : null;
  },
  // Логин Telegram: 5–32 знака, первая — буква. Номер — t.me/+79991234567:
  // так Telegram открывает человека по номеру, если тот это разрешил.
  // t.me/+AbC… — приглашение в группу, не номер: его не берём.
  telegram(raw) {
    const a = address(raw);
    let value = raw.replace(/^@/, '');
    if (a) {
      if ((a.host !== 't.me' && a.host !== 'telegram.me') || a.parts.length !== 1) return null;
      value = a.parts[0];
    }
    const num = phone(value);
    if (num) return '+' + num;
    return /^[a-z]\w{4,31}$/i.test(value) ? value.toLowerCase() : null;
  },
  whatsapp(raw) {
    const a = address(raw);
    if (!a) return phone(raw);
    if (a.host === 'wa.me' && a.parts.length === 1) return phone(a.parts[0]);
    if (a.host === 'api.whatsapp.com' && a.parts[0] === 'send') return phone(a.query.get('phone') || '');
    return null;
  },
  // Сайт: только http(s), настоящий домен с точкой, без логина-пароля
  // в адресе и без голого IP. Хранится нормализованный адрес целиком.
  site(raw) {
    if (raw.length > 200 || /\s/.test(raw)) return null;
    let u;
    try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { return null; }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
    const host = u.hostname;
    if (!/^([a-z\d]([a-z\d-]*[a-z\d])?\.)+([a-z]{2,63}|xn--[a-z\d-]{2,59})$/.test(host)) return null;
    return u.href;
  },
};

// Ссылка по хранимому значению — всегда наш шаблон.
function url(kind, v) {
  switch (kind) {
    case 'site': return v;
    case 'youtube': return 'https://www.youtube.com/' + v;
    case 'instagram': return 'https://www.instagram.com/' + v + '/';
    case 'tiktok': return 'https://www.tiktok.com/@' + v;
    case 'telegram': return 'https://t.me/' + v;
    case 'whatsapp': return 'https://wa.me/' + v;
  }
  return '';
}

// Как значение показать в поле настроек: так, как его принял бы разбор.
function display(kind, v) {
  if (kind === 'site') return v;
  if (kind === 'youtube') return v[0] === '@' ? v : 'youtube.com/' + v;
  if (kind === 'whatsapp') return '+' + v;
  if (kind === 'telegram' && v[0] === '+') return v;
  return '@' + v;
}

// Из присланного { kind: строка } — хранимые значения. Пустое поле — ссылки
// нет. Первая ошибка — { error: kind, message }.
function parse(input) {
  const links = {};
  for (const kind of KINDS) {
    const raw = typeof input[kind] === 'string' ? input[kind].trim() : '';
    if (!raw) continue;
    const value = raw.length <= 300 && PARSE[kind](raw);
    if (!value) return { error: kind, message: ERRORS[kind] };
    links[kind] = value;
  }
  return { links };
}

// Для страниц: [{ kind, name, url, display }] в порядке KINDS.
function list(links) {
  return KINDS.filter((k) => links && links[k]).map((k) => ({ kind: k, name: NAMES[k] || '', url: url(k, links[k]), display: display(k, links[k]) }));
}

module.exports = { KINDS, NAMES, parse, list };
