// Галерея человека одной лентой: фото (строками в User.gallery, utils/
// galleryPhotos.js) и видео (models/GalleryVideo.js) вперемешку, новые
// сверху. Нужна превью в профиле и странице /userPage/:id/gallery
// (routes/streaming/catalog.js).
//
// Даты у фото отдельно не хранятся, но имя файла начинается с метки времени
// загрузки (utils/image.js, newName) — по ней и сортируем. Фото и видео
// у человека не больше 130 (100 и 30), поэтому лента собирается в памяти
// целиком, а страница — срез.

const GalleryVideo = require('../models/GalleryVideo');

const PREVIEW = 12;
const PAGE = 24;

const photoTime = (url) => {
  const m = /\/(\d{13})-[0-9a-f]+\.webp$/.exec(url);
  return m ? Number(m[1]) : 0;
};

// Лента из готовых данных — фото из User.gallery и ролики: ею же карта
// сайта раскладывает фото по страницам галереи (routes/seo.js), не спрашивая
// базу на каждого человека.
function arrange(photos, videos) {
  return [
    ...videos.map((v) => ({ type: 'video', at: +v.createdAt, i: 0, video: v })),
    // i — порядок в массиве: старые фото без метки идут в конце, но тоже
    // от новых к старым.
    ...photos.map((url, i) => ({ type: 'photo', at: photoTime(url), i, url })),
  ].sort((a, b) => b.at - a.at || b.i - a.i);
}

// self — смотрит владелец: ему видны и ролики, которые ещё грузятся,
// ждут публикации, пережимаются или не вышли.
async function feed(user, self) {
  const videos = await GalleryVideo.find({ userId: user._id, ...(self ? {} : { status: 'ready' }) })
    .select('status error duration thumb upload title views createdAt')
    .lean();
  const photos = user.gallery || [];
  // Число в заголовке — то, что можно смотреть: без роликов в работе.
  const count = photos.length + videos.filter((v) => v.status === 'ready').length;
  return { list: arrange(photos, videos), count };
}

// Страница ленты: page с 1, за пределами — последняя.
function page(list, n) {
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const current = Math.min(Math.max(1, n || 1), pages);
  return { items: list.slice((current - 1) * PAGE, current * PAGE), page: current, pages };
}

module.exports = { PREVIEW, PAGE, arrange, feed, page };
