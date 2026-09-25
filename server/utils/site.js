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

// Хост для адресов приёма RTMP (OBS, выход Daily). На бою — из PUBLIC_URL:
// req.hostname при trust proxy берётся из X-Forwarded-Host, а его пишет
// тот, кто дошёл до Node. У стенда свой PUBLIC_URL — и свой хост; локально
// PUBLIC_URL бывает боевым, поэтому там — хост запроса.
function publicHost(req) {
  if (process.env.START_SERVER === 'prod' && PUBLIC_URL) return new URL(PUBLIC_URL).hostname;
  return req.hostname;
}

module.exports = { PUBLIC_URL, siteUrl, publicHost };
