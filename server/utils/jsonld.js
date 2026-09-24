// Микроразметка schema.org (JSON-LD) для поиска: название сайта и логотип
// в выдаче, видео-сниппет, профиль автора, хлебные крошки вместо адреса.
// Шаблон кладёт результат в seo.jsonld, выводит его partials/tkHead.ejs.
// Только у страниц в индексе (docs/seo/DECISIONS.md).

const { siteUrl } = require('./site');

const iso = (d) => new Date(d).toISOString();

// 3725 → PT1H2M5S
function duration(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return 'PT' + (h ? h + 'H' : '') + (m ? m + 'M' : '') + (r || (!h && !m) ? r + 'S' : '');
}

// Главная: как называется сайт и кто за ним стоит.
function site() {
  const url = siteUrl('/');
  return [
    { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Takebana', url },
    { '@context': 'https://schema.org', '@type': 'Organization', name: 'Takebana', url, logo: siteUrl('/img/app/icon-512.png') },
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
    author: { '@type': 'Person', name: author.name, url: siteUrl(author.url) },
  };
}

// description — описание профиля, sameAs — его ссылки: сайт и сети
// (utils/profileLinks.js), по ним поисковик связывает человека с ними.
function profile({ url, name, image, followers, description, sameAs }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    mainEntity: {
      '@type': 'Person',
      name,
      url: siteUrl(url),
      ...(image ? { image: siteUrl(image) } : {}),
      ...(description ? { description } : {}),
      ...(sameAs && sameAs.length ? { sameAs } : {}),
      interactionStatistic: { '@type': 'InteractionCounter', interactionType: { '@type': 'FollowAction' }, userInteractionCount: followers || 0 },
    },
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

module.exports = { site, video, profile, crumbs };
