// Адрес сайта — для ссылок в письмах, canonical и OG-тегов страниц.
//
// Берётся из настройки PUBLIC_URL, а не из заголовка Host запроса: иначе
// подставной Host превращает письмо со ссылкой в ссылку на чужой сайт,
// а canonical — в заявку поисковику, что страница живёт на чужом домене.

const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// Путь с нашего сайта — в полный адрес; уже полный (картинка с CDN) — как есть.
function siteUrl(path) {
  if (/^https?:\/\//.test(path)) return path;
  return (PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 3000}`) + path;
}

module.exports = { PUBLIC_URL, siteUrl };
