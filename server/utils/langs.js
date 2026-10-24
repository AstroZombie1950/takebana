// Языки сайта — одним списком (docs/seo/LANGUAGES.md). Новый язык — строка
// здесь и словари public/tk-i18n-<код>.js; остальной код берёт список отсюда.
//
// Первый — основной: на нём корень сайта для робота поиска, на него падает
// всё неизвестное. Он же запасной: его строку берут, если у языка своей ещё нет.
// SITE_LANG=<код> в .env меняет основной на этом сервере (но не запасной)
// и выключает угадывание языка: так гоняются зонды (temp/run-probes.sh
// ставит ru) — корень у них русский, английский — под /en.
//   locale — для Intl (даты, числа, формы слов), как tkLocale() в браузере
//   plural — локаль форм слов, если правила locale не годятся
//   og     — og:locale
//   name   — своё название, для меню языка
//
// Модуль без зависимостей: его подключают модели (enum у User.lang).
const LANGS = {
    en: { locale: 'en-US', og: 'en_US', name: 'English' },
    ru: { locale: 'ru-RU', og: 'ru_RU', name: 'Русский' },
    // Латиноамериканский испанский и бразильский португальский (LANGUAGES.md, §7);
    // hreflang — просто es и pt.
    es: { locale: 'es-419', og: 'es_LA', name: 'Español' },
    // Формы слов — по pt-PT: CLDR для pt-BR считает 0 единственным
    // («0 visualização»), а в Бразилии пишут «0 visualizações».
    pt: { locale: 'pt-BR', plural: 'pt-PT', og: 'pt_BR', name: 'Português' },
};

const LANG_CODES = Object.keys(LANGS);
const isLang = (l) => typeof l === 'string' && Object.prototype.hasOwnProperty.call(LANGS, l);
const FALLBACK_LANG = LANG_CODES[0];
const SITE_LANG = isLang(process.env.SITE_LANG) ? process.env.SITE_LANG : '';
const BASE_LANG = SITE_LANG || FALLBACK_LANG;

const toLang = (l) => (isLang(l) ? l : BASE_LANG);
const localeOf = (l) => LANGS[toLang(l)].locale;

// Текст из вписанных по языкам ({ ru, en }: рассылки, приветствие,
// добавленные панелью места): свой язык, иначе запасной, иначе любой.
function pickText(map, lang) {
    if (!map) return '';
    return map[lang] || map[FALLBACK_LANG] || LANG_CODES.map((l) => map[l]).find(Boolean) || '';
}

module.exports = { LANGS, LANG_CODES, BASE_LANG, FALLBACK_LANG, SITE_LANG, isLang, toLang, localeOf, pickText };
