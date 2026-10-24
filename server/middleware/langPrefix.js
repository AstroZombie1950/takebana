// Язык в адресе (docs/seo/LANGUAGES.md, §5.1–5.3).
//
// /ru/@anna — та же страница, что /@anna, на русском: приставка снимается,
// дальше работают обычные маршруты, а язык страницы — req.urlLang (его берёт
// langOf). Приставка бывает только у публичных адресов (utils/langUrl.js):
// /ru/settings → 301 на /settings, язык там по cookie.
//
// Какую версию публичной страницы показать:
//   1. выбран язык в меню (cookie `lang_choice`) — 302 на версию на нём;
//   2. адрес с приставкой — как есть: сюда приводит поиск, он уже выбрал язык;
//   3. корень без выбора — первый язык браузера, если он есть у сайта
//      (302 на его версию), иначе основной. Роботов не переводим — у них
//      всегда основной (x-default), с SITE_LANG угадывания нет вовсе.
//
// Переадресации маршрутов (/userPage/<id> → /@ник, ?page=1 → без него)
// сохраняют язык: res.redirect получает приставку.

const { BASE_LANG, SITE_LANG } = require('../utils/langs');
const { splitLang, isPublicPath, langPath } = require('../utils/langUrl');
const { langChoice, browserLang } = require('../utils/i18n');
const { audit } = require('../utils/audit');

const BOT = /bot|crawl|spider|slurp|yandex|google|bing|baidu|duckduck|facebookexternal|lighthouse|preview|headless/i;

function langPrefix(req, res, next) {
  const { lang, prefix, path } = splitLang(req.path);
  // /ru//evil.com: без приставки осталось бы «//evil.com», и 301 увёл бы
  // на чужой сайт. Такой адрес — мимо, в обычный 404.
  if (lang && /^\/[/\\]/.test(path)) return next();
  const get = req.method === 'GET' || req.method === 'HEAD';
  const q = req.url.indexOf('?');
  const qs = q === -1 ? '' : req.url.slice(q);

  if (lang) {
    // /RU/@anna → /ru/@anna, /ru/ → /ru: у страницы один адрес.
    if (get && (prefix !== '/' + lang || req.path === prefix + '/')) {
      return res.redirect(301, '/' + lang + (path === '/' ? '' : path) + qs);
    }
    const rest = req.url.slice(prefix.length);
    req.url = rest[0] === '/' ? rest : '/' + rest;
    if (!isPublicPath(path)) return get ? res.redirect(301, path + qs) : next();
  } else if (!isPublicPath(path)) {
    return next();
  }

  // Язык адреса — у просмотра страницы. Правка по тому же адресу (PATCH
  // /video/:id, POST /venue/:id/menu) отвечает на языке человека (langOf).
  if (!get) {
    if (lang) req.urlLang = lang;
    return next();
  }

  req.urlLang = lang || BASE_LANG;
  const redirect = res.redirect;
  if (req.urlLang !== BASE_LANG) {
    res.redirect = function redirectInLang(...args) {
      const i = args.length - 1;
      if (typeof args[i] === 'string' && args[i][0] === '/') args[i] = langPath(req.urlLang, args[i]);
      return redirect.apply(this, args);
    };
  }

  // Фрагменты страницы подгружают скрипты — им переадресация не нужна.
  if (req.headers['x-tk-fragment'] === '1') return next();

  const choice = langChoice(req);
  if (choice && choice !== req.urlLang) return redirect.call(res, 302, langPath(choice, path) + qs);

  if (!choice && !lang && !SITE_LANG) {
    res.vary('Accept-Language');
    if (!BOT.test(req.headers['user-agent'] || '')) {
      const auto = browserLang(req.headers['accept-language']);
      if (auto !== BASE_LANG) {
        audit(req, 'lang.auto', { meta: { lang: auto, path } });
        return redirect.call(res, 302, langPath(auto, path) + qs);
      }
    }
  }
  next();
}

module.exports = langPrefix;
