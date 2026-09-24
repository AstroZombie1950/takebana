// robots.txt и карта сайта (docs/seo/DECISIONS.md).
//
// В карте — ровно то, что открыто для индекса на самих страницах, по тем же
// правилам: профиль не забаненного, где есть запись, фото, видео или идущий
// эфир (routes/streaming/catalog.js, indexable); его галерея — если в ней
// больше gallery.PREVIEW; готовые видео и записи, записи без 18+; из
// разовых страниц — главная, разделы, «О нас», «Авторы», если там хоть
// кто-то есть (views/authors.ejs), и карта, если есть хоть одно одобренное
// заведение (views/map.ejs). Меняется правило у страницы — меняется и здесь.
//
// Карта собирается целиком раз в час и живёт в памяти: робот приходит
// за ней часто, а обходить ради него всю базу на каждый запрос незачем.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router);
const User = require('../models/User');
const Recording = require('../models/Recording');
const GalleryVideo = require('../models/GalleryVideo');
const Stream = require('../models/Stream');
const Establishments = require('../models/Establishments');
const gallery = require('../utils/gallery');
const authors = require('../utils/authors');
const { siteUrl } = require('../utils/site');
const { text, langOf } = require('../utils/i18n');
const { CATEGORIES } = require('../config/catalog');
const userView = require('../utils/userView');
const { profileUrl } = require('../utils/profileUrl');

// Закрываем обход служебного: кабинета, входа, API, медиапотоков. Стили,
// скрипты, шрифты и картинки (/min/, /css/, /fonts/, /img/, /uploads/,
// /vendor/) открыты: без них Google не отрисует страницу, без картинок
// не будет поиска по ним. Clean-param — в общей группе: отдельную группу
// для Яндекса он прочитал бы вместо общей и остался бы без Disallow.
//
// /search и подписчики закрыты noindex, но не здесь: Disallow не выкидывает
// из индекса то, что туда уже попало, — робот просто перестанет заходить
// и noindex не увидит. Закрыть, когда Вебмастер покажет, что их там нет.
const ROBOTS = `User-agent: *
Disallow: /panel
Disallow: /api/
Disallow: /login
Disallow: /register
Disallow: /forgot-password
Disallow: /reset-password/
Disallow: /confirm-email/
Disallow: /verify-email/
Disallow: /auth/
Disallow: /logout
Disallow: /settings
Disallow: /studio
Disallow: /upload
Disallow: /chatsPage
Disallow: /calls
Disallow: /company-register
Disallow: /check
Disallow: /calc
Disallow: /streaming/*/grid
Disallow: /stream-status/
Disallow: /getMessages
Disallow: /messages/
Disallow: /socket.io/
Disallow: /live/
Disallow: /mtx/
Disallow: /m/
Clean-param: utm_source&utm_medium&utm_campaign&utm_content&utm_term&yclid&gclid&fbclid

Sitemap: ${siteUrl('/sitemap.xml')}
`;

router.get('/robots.txt', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600').type('text/plain').send(ROBOTS);
});

const TTL = 60 * 60 * 1000;
const LIMIT = 50000; // адресов в одном файле — предел протокола

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const tag = (name, value) => `<${name}>${esc(value)}</${name}>`;
const newest = (dates) => dates.reduce((a, b) => (b && (!a || b > a) ? b : a), null);

// Заголовок безымянного видео — как в <title> его страницы (views/watch.ejs),
// без «— Takebana». Язык — тот, что видит робот: без cookie и Accept-Language
// сайт отвечает по-английски (utils/i18n.js, langOf).
const ROBOT = langOf({ headers: {} });
const untitled = (v, name) => text(ROBOT, 'video.untitledBy', {
  name,
  date: new Date(v.createdAt).toLocaleString(ROBOT === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' }),
});

function videoEntry(path, v, title, date) {
  const entry = { loc: path, lastmod: date };
  // Без превью и файла Google видео не примет; страница в карте остаётся.
  // Файл — то же, что играет плеер (routes/watch.js, KINDS.src): у записи
  // после нарезки — плейлист HLS, MP4 тогда уже удалён.
  const src = (v.hls && v.hls.url) || (v.video && v.video.url);
  if (v.thumb && v.thumb.url && src) {
    entry.video = {
      thumbnail_loc: siteUrl(v.thumb.url),
      title,
      description: (v.description || title).slice(0, 2048),
      content_loc: siteUrl(src),
      duration: v.duration > 0 ? Math.min(Math.round(v.duration), 28800) : null,
      publication_date: date.toISOString(),
    };
  }
  return entry;
}

async function collect() {
  const [recordings, videos, live, groups, venues] = await Promise.all([
    Recording.find({ status: 'ready' }).select('userId title description isAdult thumb video hls.url duration recordedAt createdAt').lean(),
    GalleryVideo.find({ status: 'ready' }).select('userId title description thumb video duration createdAt').lean(),
    Stream.distinct('userId', { isActive: true }),
    authors.groups(),
    Establishments.exists({ status: true }),
  ]);

  const withContent = new Set([...recordings, ...videos].map((x) => String(x.userId)).concat(live.map(String)));
  const users = await User.find({
    banned: { $ne: true },
    $or: [{ _id: { $in: [...withContent] } }, { 'gallery.0': { $exists: true } }],
  }).select('gallery nickname login email').lean();
  const names = new Map(users.map((u) => [String(u._id), userView.displayName(u)]));
  const open = new Set(names.keys());
  const byUser = (list) => list.reduce((m, x) => {
    const id = String(x.userId);
    if (open.has(id)) (m.get(id) || m.set(id, []).get(id)).push(x);
    return m;
  }, new Map());
  const recsOf = byUser(recordings);
  const videosOf = byUser(videos);

  const pages = [{ loc: '/' }, ...Object.keys(CATEGORIES).map((c) => ({ loc: '/streaming/' + c })), { loc: '/about' }];
  if (Object.values(groups).some((g) => g.length)) pages.push({ loc: '/authors' });
  if (venues) pages.push({ loc: '/map' });

  const people = [];
  for (const u of users) {
    const id = String(u._id);
    const photos = u.gallery || [];
    const vids = videosOf.get(id) || [];
    const list = gallery.arrange(photos, vids);
    const shotsOf = (items) => items.filter((x) => x.type === 'photo').map((x) => x.url);
    const lastmod = newest([
      list.length && list[0].at ? new Date(list[0].at) : null,
      ...(recsOf.get(id) || []).map((r) => r.createdAt),
    ]);
    const url = profileUrl(u);
    people.push({ loc: url, lastmod, images: shotsOf(list.slice(0, gallery.PREVIEW)) });
    if (list.length > gallery.PREVIEW) {
      const { pages: total } = gallery.page(list, 1);
      for (let n = 1; n <= total; n++) {
        people.push({
          loc: `${url}/gallery` + (n > 1 ? `?page=${n}` : ''),
          lastmod,
          images: shotsOf(gallery.page(list, n).items),
        });
      }
    }
  }

  const watch = [
    ...[...recsOf.values()].flat().filter((r) => !r.isAdult)
      .map((r) => videoEntry(`/recording/${r._id}`, r, r.title, r.recordedAt || r.createdAt)),
    ...[...videosOf.values()].flat()
      .map((v) => videoEntry(`/video/${v._id}`, v, v.title || untitled(v, names.get(String(v.userId))), v.createdAt)),
  ];

  return { pages, users: people, video: watch };
}

function urlset(entries) {
  const urls = entries.map((e) => {
    let x = '<url>' + tag('loc', siteUrl(e.loc));
    if (e.lastmod) x += tag('lastmod', e.lastmod.toISOString());
    for (const img of e.images || []) x += '<image:image>' + tag('image:loc', siteUrl(img)) + '</image:image>';
    if (e.video) {
      x += '<video:video>';
      for (const [k, v] of Object.entries(e.video)) if (v !== null) x += tag('video:' + k, v);
      x += '</video:video>';
    }
    return x + '</url>';
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'
    + ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"'
    + ' xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">\n'
    + urls.join('\n') + '\n</urlset>\n';
}

// Индекс /sitemap.xml и части: sitemap-pages.xml, sitemap-users.xml,
// sitemap-video.xml; больше LIMIT адресов — sitemap-users-2.xml и дальше.
// Пустая часть в индекс не попадает.
async function build() {
  const files = new Map();
  const index = [];
  for (const [name, entries] of Object.entries(await collect())) {
    for (let i = 0; i * LIMIT < entries.length; i++) {
      const chunk = entries.slice(i * LIMIT, (i + 1) * LIMIT);
      const file = `sitemap-${name}${i ? '-' + (i + 1) : ''}.xml`;
      files.set(file, urlset(chunk));
      const lastmod = newest(chunk.map((e) => e.lastmod));
      index.push('<sitemap>' + tag('loc', siteUrl('/' + file)) + (lastmod ? tag('lastmod', lastmod.toISOString()) : '') + '</sitemap>');
    }
  }
  files.set('sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + index.join('\n') + '\n</sitemapindex>\n');
  return files;
}

// Одна сборка на всех: запросы, пришедшие во время сборки, ждут её же.
// Не собралась — следующий запрос пробует заново, а не ждёт час.
let cached = null;
function sitemap() {
  if (!cached || Date.now() - cached.at > TTL) {
    const files = build();
    cached = { at: Date.now(), files };
    files.catch(() => { if (cached && cached.files === files) cached = null; });
  }
  return cached.files;
}

router.get(/^\/sitemap(?:-[a-z]+(?:-\d+)?)?\.xml$/, async (req, res, next) => {
  const xml = (await sitemap()).get(req.path.slice(1));
  if (!xml) return next();
  res.set('Cache-Control', 'public, max-age=3600').type('application/xml').send(xml);
});

module.exports = router;
