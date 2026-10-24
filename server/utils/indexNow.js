// IndexNow (04.10, docs/seo, задача 9): сообщить Яндексу и Bing о новой
// странице сразу, не дожидаясь, пока робот дойдёт до неё по карте сайта.
// Один запрос на api.indexnow.org получают все участники протокола
// (Bing, Яндекс, Seznam, Naver). Google в нём не участвует — ему хватает карты.
//
// Ключ публичный по замыслу протокола: он лежит файлом /<ключ>.txt
// (routes/seo.js), и по нему поисковик убеждается, что адреса присылает
// хозяин сайта. Поэтому он в коде, а не в .env.
//
// Только на бою: стенд и зонды наружу не стучат. Адреса копятся минуту
// и уходят пачкой — склейка записей и пачка фото не дёргают API по одному.

const { PUBLIC_URL, siteUrl } = require('./site');
const errorLog = require('./errorLog');
const { langUrl } = require('./langUrl');
const { itemLang } = require('./contentLang');

const KEY = '50bdf9f338bb658d80a26cd2b26f8577';
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const DELAY_MS = 60 * 1000;
const ON = (process.env.START_SERVER === 'prod' || process.env.NODE_ENV === 'production') && /^https:\/\//.test(PUBLIC_URL);

const queue = new Set();
let timer = null;

async function flush() {
  timer = null;
  const urlList = [...queue];
  queue.clear();
  if (!urlList.length) return;
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: new URL(PUBLIC_URL).hostname, key: KEY, keyLocation: siteUrl('/' + KEY + '.txt'), urlList }),
      signal: AbortSignal.timeout(15000),
    });
    // 200 — принято, 202 — принято, ключ ещё проверяют.
    if (r.status !== 200 && r.status !== 202) throw new Error('IndexNow ответил ' + r.status);
  } catch (e) {
    errorLog.external(e, 'indexnow', { urls: urlList.length });
  }
}

function add(url) {
  queue.add(url);
  if (!timer) timer = setTimeout(flush, DELAY_MS);
}

// Страница видео, записи, фото или поста (/recording/…), которая только что
// появилась в индексе, — адресом той языковой версии, что в индексе
// (utils/contentLang.js, как у страницы и карты сайта). Язык автора нужен,
// когда своего текста нет.
function pingItem(path, item) {
  if (!ON || !item) return;
  require('../models/User').findById(item.userId).select('lang').lean()
    .then((author) => add(langUrl(itemLang(item, author), path)))
    .catch((e) => errorLog.server(e, 'indexnow.lang'));
}

module.exports = { KEY, pingItem };
