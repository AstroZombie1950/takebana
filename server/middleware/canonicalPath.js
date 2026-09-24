// Один адрес у страницы. Express сравнивает пути без учёта регистра и хвостовой
// косой, поэтому /About, /about/ и /USERPAGE/<id> отдают то же, что /about
// и /userPage/<id>, — для поиска это страницы-дубли. Здесь такие адреса
// уводятся 301 на правильный вид, метки в ?… сохраняются.
//
// Только для страниц из списка и профилей /@ник: у остальных адресов в пути
// бывают значения, где регистр важен (токены сброса пароля и подтверждения
// почты, файлы). Хвост после первого сегмента — id, категория, «gallery» —
// всегда в нижнем регистре, ник — тоже (utils/nickname.js).

const PAGES = ['about', 'authors', 'map', 'terms', 'privacy', 'cookies', 'search',
  'userPage', 'video', 'recording', 'stream', 'streaming'];
const BY_LOWER = new Map(PAGES.map((p) => [p.toLowerCase(), p]));

function canonicalPath(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const m = /^\/([^/]+)((?:\/[^/]+)*)\/?$/.exec(req.path);
  const first = m && (m[1][0] === '@' ? m[1].toLowerCase() : BY_LOWER.get(m[1].toLowerCase()));
  if (!first) return next();
  const path = '/' + first + m[2].toLowerCase();
  if (path === req.path) return next();
  const qs = req.originalUrl.indexOf('?');
  res.redirect(301, path + (qs === -1 ? '' : req.originalUrl.slice(qs)));
}

module.exports = canonicalPath;
