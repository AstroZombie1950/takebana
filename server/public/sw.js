// Service worker: нужен ровно затем, чтобы сайт ставился на домашний экран
// как приложение (Android предлагает установку только сайту с обработчиком
// fetch) и чтобы вкладка без сети показывала не ошибку браузера, а страницу.
//
// Кэша страниц здесь НЕТ, и это главное решение файла. Заказчик как раз
// подозревал, что «с иконки что-то кэшируется и не обновляется», и самый
// верный способ сделать эту догадку правдой — начать кэшировать разметку.
// Поэтому:
//   — любой переход и любой запрос за данными идёт в сеть, всегда;
//   — из кэша отдаются только файлы с хешем в имени (/min/) и то, что
//     не меняется никогда: шрифты, значки приложения, вендорные скрипты;
//   — сеть недоступна и это переход — показываем /offline.html.
//
// Новая версия вступает в силу сразу (skipWaiting + claim): застрявший
// старый worker — второй способ получить «не обновляется».

const VERSION = 'tk-1';
const SHELL = 'tk-shell-' + VERSION;

// Что можно держать в кэше: адрес либо несёт хеш содержимого, либо указывает
// на файл, который под своим именем не меняется. Всё остальное — мимо.
const CACHEABLE = /^\/(min|fonts|vendor)\/|^\/img\/app\/|^\/favicon\.svg$/;

const OFFLINE = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.add(OFFLINE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== SHELL).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Переход по страницам: только сеть. Не ответила — страница «нет сети»,
  // но никогда не вчерашняя копия настоящей.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
    return;
  }

  // Сокет, загрузки, медиа с CDN и всё чужое — не наше дело.
  if (!sameOrigin || !CACHEABLE.test(url.pathname)) return;

  // Неизменяемое: из кэша, а нет — из сети и в кэш.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
