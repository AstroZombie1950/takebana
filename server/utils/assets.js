// Адрес стиля с версией: /css/app.css?v=<хеш содержимого>.
//
// nginx отдаёт /css/ с кэшем на неделю (ops/nginx/takebana.conf). Без версии
// браузер вернувшегося посетителя после выкладки брал новую страницу, но
// старые стили — и вёрстка разъезжалась. Хеш от содержимого, а не от выкладки:
// заново скачиваются только изменившиеся файлы. Считается один раз на процесс —
// выкладка перезапускает сервер.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const versions = new Map();

function asset(url) {
  if (!versions.has(url)) {
    let v = '';
    try {
      v = crypto.createHash('md5').update(fs.readFileSync(path.join(PUBLIC, url))).digest('hex').slice(0, 10);
    } catch (_) {
      // Файла нет — адрес без версии: 404 в сети виднее, чем падение страницы.
    }
    versions.set(url, v);
  }
  const v = versions.get(url);
  return v ? url + '?v=' + v : url;
}

module.exports = { asset };
