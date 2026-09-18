// Адрес стиля или скрипта для шаблона: сжатая копия с хешем в имени.
//
//   asset('/css/app.css')  → /min/css/app.3f9c2a71be.css
//   asset('/tk-app.js')    → /min/tk-app.8d04e1c2aa.js
//
// Исходники в public/ остаются как есть — с комментариями и отступами,
// читать и править их по-прежнему удобно. Сборки у проекта нет и не будет:
// сжатая копия делается здесь, при первом обращении шаблона к файлу, и живёт
// до перезапуска процесса. Выкладка перезапускает сервер — значит, после
// правки исходника копия пересоберётся сама, забыть про «сборку» нельзя.
//
// Хеш стоит в имени файла, а не в ?v=: адрес меняется вместе с содержимым,
// поэтому nginx отдаёт /min/ с кэшем на год и immutable (ops/nginx/takebana.conf),
// а браузер не ходит даже за 304.
//
// esbuild снимает комментарии и пробелы и сокращает локальные имена. Имена
// верхнего уровня не трогает: наши скрипты — обычные <script>, не модули,
// и общаются друг с другом через глобальные функции (t, toast, escapeHtml).
//
// Вендорные файлы (/vendor/) уже сжаты и несут версию в имени — их не трогаем,
// только добавляем ?v= по содержимому, как раньше.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIN = path.join(PUBLIC, 'min');
const urls = new Map();

// Старые копии от прошлых выкладок: страницы с их адресами давно закрыты,
// а браузеры, у которых они в кэше, на сервер за ними не придут.
// Неделя — с запасом на вкладку, открытую перед выкладкой.
const KEEP_MS = 7 * 24 * 3600 * 1000;

function sweep(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sweep(full);
    else if (Date.now() - fs.statSync(full).mtimeMs > KEEP_MS) fs.rmSync(full, { force: true });
  }
}
sweep(MIN);

// Настройки сжатия входят в хеш имени (см. build): поменяли их — у всех
// копий новые имена, и старые не останутся жить под прежними.
const OPTIONS = {
  minify: true,
  // Без target esbuild не переписывает синтаксис: что было в исходнике,
  // то и уйдёт браузеру, только короче.
  legalComments: 'none',
  // По умолчанию esbuild переводит всё не-ASCII в \uXXXX: кириллическая
  // буква из двух байт становится шестью, и словарь tk-i18n-ru.js после
  // «сжатия» вырастал вдвое, с 44 до 89 КБ. Страницы и так в UTF-8.
  charset: 'utf8',
};
const SALT = esbuild.version + JSON.stringify(OPTIONS);

function hashOf(buf, salt = '') {
  return crypto.createHash('md5').update(buf).update(salt).digest('hex').slice(0, 10);
}

function build(url) {
  const source = fs.readFileSync(path.join(PUBLIC, url));
  const ext = path.extname(url);

  // Вендор и всё, кроме css и js, — прежний способ: исходник с версией.
  if (url.startsWith('/vendor/') || (ext !== '.css' && ext !== '.js')) return url + '?v=' + hashOf(source);

  // Имя — от исходника и от настроек сжатия вместе (с версией esbuild).
  const hash = hashOf(source, SALT);
  const minUrl = '/min' + url.slice(0, -ext.length) + '.' + hash + ext;
  const target = path.join(PUBLIC, minUrl);

  if (!fs.existsSync(target)) {
    const { code } = esbuild.transformSync(source.toString('utf8'), { ...OPTIONS, loader: ext.slice(1) });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Через временный файл: nginx не должен отдать наполовину записанный.
    const tmp = target + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, code);
    fs.renameSync(tmp, target);
  }
  return minUrl;
}

function asset(url) {
  if (!urls.has(url)) {
    let out = url;
    try {
      out = build(url);
    } catch (e) {
      // Файла нет — адрес как есть: 404 в сети виднее, чем падение страницы.
      // Не разобрался сжиматель — отдаём исходник с версией: страница работает,
      // а причина в логе.
      if (e.code !== 'ENOENT') {
        console.warn('[assets] не удалось сжать', url, '—', e.message);
        try { out = url + '?v=' + hashOf(fs.readFileSync(path.join(PUBLIC, url))); } catch {}
      }
    }
    urls.set(url, out);
  }
  return urls.get(url);
}

module.exports = { asset };
