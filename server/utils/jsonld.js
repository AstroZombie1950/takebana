// Микроразметка schema.org (JSON-LD) для поиска: название сайта и логотип
// в выдаче, видео-сниппет, профиль автора, хлебные крошки вместо адреса.
// Шаблон кладёт результат в seo.jsonld, выводит его partials/tkHead.ejs.
// Только у страниц в индексе (docs/seo/DECISIONS.md).

const { siteUrl } = require('./site');
const contacts = require('../config/contacts');

const iso = (d) => new Date(d).toISOString();

// 3725 → PT1H2M5S
function duration(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return 'PT' + (h ? h + 'H' : '') + (m ? m + 'M' : '') + (r || (!h && !m) ? r + 'S' : '');
}

// Главная: как называется сайт и кто за ним стоит.
// sameAs — заведённые соцсети и телеграм (config/contacts.js): по ним
// поисковик связывает сайт с аккаунтами бренда.
function site() {
  const url = siteUrl('/');
  const sameAs = [...Object.values(contacts.social), contacts.telegram].filter(Boolean);
  return [
    { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Takebana', url },
    { '@context': 'https://schema.org', '@type': 'Organization', name: 'Takebana', url, logo: siteUrl('/img/app/icon-512.png'),
      email: contacts.email, ...(sameAs.length ? { sameAs } : {}) },
  ];
}

// Видео или запись эфира. Без превью Google видео не примет — тогда только
// крошки. src — то, что играет плеер: MP4 видео галереи или плейлист HLS
// записи (.m3u8 Google принимает как видеофайл).
function video({ path, title, description, thumb, src, seconds, date, views, author }) {
  if (!thumb) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: title,
    description: description || title,
    thumbnailUrl: siteUrl(thumb),
    ...(src ? { contentUrl: siteUrl(src) } : {}),
    uploadDate: iso(date),
    ...(seconds > 0 ? { duration: duration(seconds) } : {}),
    url: siteUrl(path),
    interactionStatistic: { '@type': 'InteractionCounter', interactionType: { '@type': 'WatchAction' }, userInteractionCount: views || 0 },
    // Видео заведения (29.09) — от организации, не от человека.
    author: { '@type': author.org ? 'Organization' : 'Person', name: author.name, url: siteUrl(author.url) },
  };
}

// description — описание профиля, sameAs — его ссылки: сайт и сети
// (utils/profileLinks.js), по ним поисковик связывает человека с ними.
// created — когда заведён аккаунт, modified — последнее фото, видео
// или запись; alternateName — «@ник» (04.10, docs/seo, задача 37).
function profile({ url, name, alternateName, image, followers, description, sameAs, created, modified }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    ...(created ? { dateCreated: iso(created) } : {}),
    ...(modified ? { dateModified: iso(modified) } : {}),
    mainEntity: {
      '@type': 'Person',
      name,
      ...(alternateName && alternateName !== name ? { alternateName } : {}),
      url: siteUrl(url),
      ...(image ? { image: siteUrl(image) } : {}),
      ...(description ? { description } : {}),
      ...(sameAs && sameAs.length ? { sameAs } : {}),
      interactionStatistic: { '@type': 'InteractionCounter', interactionType: { '@type': 'FollowAction' }, userInteractionCount: followers || 0 },
    },
  };
}

// Видео-меню заведения (29.09): разделы и позиции. Цена — текстом
// (models/MenuItem.js), в Offer её не разобрать, поэтому без неё.
function menu({ path, name, sections }) {
  const item = (x) => ({
    '@type': 'MenuItem',
    name: x.name,
    ...(x.description ? { description: x.description } : {}),
    ...(x.clip && x.clip.thumb && x.clip.thumb.url ? { image: siteUrl(x.clip.thumb.url) } : {}),
  });
  return {
    '@context': 'https://schema.org',
    '@type': 'Menu',
    name,
    url: siteUrl(path),
    hasMenuSection: sections.map((s) => ({ '@type': 'MenuSection', ...(s.name ? { name: s.name } : {}), hasMenuItem: s.items.map(item) })),
  };
}

// Заведение (04.10, docs/seo, задача 31): тип schema.org — по типу из
// справочника (config/catalog.js, VENUE_TYPES), своё владельца — просто
// LocalBusiness. Только то, что видно на странице: телефона и почты там нет —
// и здесь нет. Часы — будни и выходные (utils/venueHours.js: выходные —
// суббота и воскресенье); оценка — когда кто-то оценил.
const VENUE_SCHEMA = { bar: 'BarOrPub', pub: 'BarOrPub', hookah: 'BarOrPub', restaurant: 'Restaurant', cafe: 'CafeOrCoffeeShop', club: 'NightClub' };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const WEEKEND = ['Saturday', 'Sunday'];

function venue({ v, description, city, country }) {
  const hours = [[v.weekdayHours, WEEKDAYS], [v.weekendHours, WEEKEND]]
    .filter(([h]) => h && HHMM.test(h.open) && HHMM.test(h.close))
    .map(([h, days]) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: days, opens: h.open, closes: h.close }));
  const images = [v.cover, ...(v.photos || [])].filter(Boolean).map(siteUrl);
  const loc = v.location && Number.isFinite(v.location.lat) && Number.isFinite(v.location.lng) ? v.location : null;
  return {
    '@context': 'https://schema.org',
    '@type': VENUE_SCHEMA[v.type] || 'LocalBusiness',
    name: v.name,
    url: siteUrl('/venue/' + v._id),
    ...(description ? { description } : {}),
    ...(images.length ? { image: images } : {}),
    ...(v.avatar ? { logo: siteUrl(v.avatar) } : {}),
    address: {
      '@type': 'PostalAddress',
      ...(v.address ? { streetAddress: v.address } : {}),
      ...(city ? { addressLocality: city } : {}),
      // Страна из справочника — кодом ISO, своя — как вписал владелец.
      ...(v.country ? { addressCountry: v.country.toUpperCase() } : country ? { addressCountry: country } : {}),
    },
    ...(loc ? { geo: { '@type': 'GeoCoordinates', latitude: loc.lat, longitude: loc.lng } } : {}),
    ...(hours.length ? { openingHoursSpecification: hours } : {}),
    ...(v.ratingCount > 0 ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: Number(v.ratingAvg.toFixed(1)), ratingCount: v.ratingCount, bestRating: 5, worstRating: 1 } } : {}),
  };
}

// Страница-раздел (04.10, задача 13): что это за страница и чья она.
// type — CollectionPage (разделы, лента, авторы, заведения) или AboutPage.
function page({ type, path, name, description }) {
  return {
    '@context': 'https://schema.org',
    '@type': type,
    name,
    ...(description ? { description } : {}),
    url: siteUrl(path),
    isPartOf: { '@type': 'WebSite', name: 'Takebana', url: siteUrl('/') },
  };
}

// [[название, путь], …] — от главной до текущей страницы.
function crumbs(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: siteUrl(path) })),
  };
}

module.exports = { site, video, profile, menu, venue, page, crumbs };
