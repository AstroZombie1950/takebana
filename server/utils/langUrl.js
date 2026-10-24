// Языковые адреса (docs/seo/LANGUAGES.md, §5.1). Основной язык — в корне
// (/@anna), остальные — папкой (/ru/@anna). Приставка — только у публичных
// страниц: тех, что бывают в индексе или открываются гостем по ссылке.
// Переписка, настройки, студия, панель, вход — без неё, язык там по cookie.
//
// Части адреса не переводим: /ru/streaming/music, а не /ru/streaming/muzyka.

const { LANG_CODES, BASE_LANG } = require('./langs');
const { siteUrl } = require('./site');

const PREFIXED = LANG_CODES.filter((l) => l !== BASE_LANG);
const PREFIX_RX = PREFIXED.length ? new RegExp('^/(' + PREFIXED.join('|') + ')(?=/|$)', 'i') : null;

// Публичные адреса — без приставки, без меток. Список повторяет страницы
// из docs/seo/DECISIONS.md; новая публичная страница — строка здесь.
// Служебные фрагменты (/feed/next, /streaming/x/grid) и JSON сюда не входят.
// Без учёта регистра: /About и /@Anna приводит к виду middleware/canonicalPath.js.
const ID = '[0-9a-fA-F]{24}';
const PUBLIC = new RegExp('^(?:' + [
    '/',
    '/streaming(?:/[a-z0-9-]+)?',
    '/@[^/?#]+(?:/(?:photos|videos|recordings|gallery))?',
    '/userPage/[^/?#]+(?:/(?:gallery|photos|videos|recordings))?',
    `/(?:video|recording|photo|post)/${ID}`,
    '/stream/[^/?#]+',
    '/venues',
    `/venue/${ID}(?:/(?:streams|videos|menu|live))?`,
    '/authors(?:/all)?',
    '/feed',
    '/about',
    '/map',
    '/main',
].join('|') + ')/?$', 'i');

const isPublicPath = (path) => PUBLIC.test(path);

// '/ru/@anna' → { lang: 'ru', path: '/@anna' }; без приставки — lang: null.
// prefix — как она написана в адресе ('/RU' — не так, как надо).
function splitLang(path) {
    const m = PREFIX_RX && PREFIX_RX.exec(path);
    if (!m) return { lang: null, path };
    return { lang: m[1].toLowerCase(), prefix: m[0], path: path.slice(m[0].length) || '/' };
}

// Адрес страницы на языке: langPath('ru', '/@anna?x=1') → '/ru/@anna?x=1',
// главная — '/ru'. Основной язык и не публичные адреса — как есть.
function langPath(lang, path) {
    if (!lang || lang === BASE_LANG || !PREFIXED.includes(lang)) return path;
    const cut = path.search(/[?#]/);
    const bare = cut === -1 ? path : path.slice(0, cut);
    if (!isPublicPath(bare)) return path;
    return '/' + lang + (bare === '/' ? '' : bare) + (cut === -1 ? '' : path.slice(cut));
}

const langUrl = (lang, path) => siteUrl(langPath(lang, path));

// Ссылки в готовой разметке — на язык страницы: href и action вида "/…"
// у публичных адресов получают приставку. Так шаблонам и подписям людей
// (@ник → /@ник, utils/mentions.js) не нужно знать про язык. Ссылки
// с hreflang (меню языка) ведут на свой язык — их не трогаем; hreflang
// в теге пишется раньше href. Полные адреса (canonical, og:url,
// альтернативы в <head>) собраны уже на нужном. data-back/prev/next —
// адреса, по которым уходят скрипты («назад», соседнее фото); курсоры
// и служебные адреса в них langPath не меняет.
const ATTR_RX = /(<[a-z][^>]*?\s)(href|action|data-back|data-prev|data-next)="(\/(?!\/)[^"]*)"/gi;
function localizeHtml(html, lang) {
    if (!lang || lang === BASE_LANG || typeof html !== 'string') return html;
    return html.replace(ATTR_RX, (whole, head, attr, url) =>
        /\shreflang=/i.test(head) ? whole : head + attr + '="' + langPath(lang, url) + '"');
}

// Полные адреса сайта в тексте (микроразметка) — на язык страницы.
const ORIGIN = siteUrl('');
const ABS_RX = new RegExp(ORIGIN.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '(/[^"\\s]*)', 'g');
function localizeUrls(text, lang) {
    if (!lang || lang === BASE_LANG) return text;
    return text.replace(ABS_RX, (whole, path) => ORIGIN + langPath(lang, path));
}

module.exports = { PREFIXED, PUBLIC, isPublicPath, splitLang, langPath, langUrl, localizeHtml, localizeUrls };
