// Служебные фрагменты страниц (04.10.2026, docs/seo, задача 27): лента
// главной /feed, карточки заведений /venues/cards, сетка эфиров раздела
// /streaming/:раздел/grid. Это куски разметки без шапки и стилей — их берут
// наши скрипты через tkFetch с заголовком X-TK-Fragment.
//
// Открытый напрямую (по ссылке, из истории, роботом) фрагмент уводим на
// полную страницу с теми же параметрами: человек видит нормальную страницу,
// а поисковику нечего индексировать. 302, а не 301: постоянную переадресацию
// браузер запомнил бы и отдал потом и скрипту, который просит тот же адрес.
// Для робота адреса ещё и закрыты в robots.txt (routes/seo.js).
function fragmentOnly(fullPage) {
  return (req, res, next) => {
    res.vary('X-TK-Fragment');
    if (req.get('X-TK-Fragment') === '1') {
      res.set('X-Robots-Tag', 'noindex');
      return next();
    }
    const qs = req.originalUrl.indexOf('?');
    res.redirect(302, fullPage(req) + (qs === -1 ? '' : req.originalUrl.slice(qs)));
  };
}

module.exports = { fragmentOnly };
