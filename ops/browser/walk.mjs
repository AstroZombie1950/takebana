// Обход страниц живым браузером.
//
//   node ops/browser/walk.mjs https://takebana.com
//   SMOKE_EMAIL=... SMOKE_PASSWORD=... node ops/browser/walk.mjs http://127.0.0.1:3000
//   SHOTS=./shots node ops/browser/walk.mjs http://127.0.0.1:3000
//   WIDTHS=1440 ... — только компьютер (по умолчанию 1440 и 390)
//
// Запускается через ops/browser-check.sh, который сам поднимает Chrome.
// Ловит то, чего не видит smoke.sh: исключения в консоли, запросы, вернувшие
// 4xx/5xx, несостоявшиеся загрузки, блокирующие alert(), битые картинки
// и прокрутку вбок на телефоне.
//
// Страницы с идентификатором в адресе — эфир, автор, запись, видео, галерея —
// находит сам, переходя по ссылкам сайта: у каждого стенда они свои.
// SMOKE_PAGES=/stream/<id>,… добавляет свои разово.
//
// Код возврата — число найденных проблем.

import { newPage } from './cdp.mjs';
import fs from 'node:fs';

const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const SHOTS = process.env.SHOTS || '';
const EMAIL = process.env.SMOKE_EMAIL || '';
const PASSWORD = process.env.SMOKE_PASSWORD || '';
const WIDTHS = (process.env.WIDTHS || '1440,390').split(',').map(Number).filter(Boolean);

const c = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', step: '\x1b[36m', dim: '\x1b[2m', off: '\x1b[0m' };
let problems = 0;
let checked = 0;

if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// Страницы, открытые без входа (с 15.09.2026 гостю открыты витрина, эфир,
// запись, профиль, карта и поиск).
const PUBLIC = [
  ['главная (витрина)', '/'],
  ['раздел «Бизнес»', '/streaming/business'],
  ['раздел «Развлечения»', '/streaming/entertainment'],
  ['карта заведений', '/main'],
  ['поиск', '/search?q=demo'],
  ['поиск: заведения', '/search?q=bar&tab=venues'],
  ['авторы', '/authors'],
  ['вход', '/login'],
  ['регистрация', '/register'],
  ['восстановление пароля', '/forgot-password'],
  ['о нас', '/about'],
  ['проверка связи', '/check'],
  ['условия', '/terms'],
  ['конфиденциальность', '/privacy'],
  ['cookie', '/cookies'],
];
const PRIVATE = [
  ['витрина вошедшему', '/'],
  ['карта вошедшему', '/main'],
  ['переписка', '/chatsPage'],
  ['звонки', '/chatsPage?tab=calls'],
  ['контакты', '/chatsPage?tab=contacts'],
  ['настройки', '/settings'],
  ['загрузка в галерею', '/upload'],
  ['студия', '/studio'],
  ['заявка заведения', '/company-register'],
];

// Панель — только если SMOKE_* — учётка администратора или модератора:
// остальным /panel отвечает редиректом на главную.
if (process.env.SMOKE_ADMIN === '1') PRIVATE.push(['панель', '/panel']);
for (const path of (process.env.SMOKE_PAGES || '').split(',').map(s => s.trim()).filter(Boolean)) {
  PRIVATE.push([path, path]);
}

async function viewport(p, width) {
  const phone = width < 768;
  await p.send('Emulation.setDeviceMetricsOverride', { width, height: phone ? 844 : 900, deviceScaleFactor: phone ? 2 : 1, mobile: phone });
}

// Первая ссылка на странице, путь которой подходит под шаблон.
async function firstLink(p, pattern) {
  return p.eval(`(() => {
    const re = new RegExp(${JSON.stringify(pattern)});
    const a = [...document.querySelectorAll('a[href]')].map(a => new URL(a.href, location.href))
      .find(u => u.origin === location.origin && re.test(u.pathname));
    return a ? a.pathname : '';
  })()`);
}

// status — какой код ответа у самой страницы ожидаем: 404 у страницы
// «такой нет» — не ошибка, а то, что проверяем.
async function check(p, name, url, { status = 200 } = {}) {
  for (const width of WIDTHS) {
    await viewport(p, width);
    await p.goto(BASE + url);
    checked++;

    const info = JSON.parse(await p.eval(`JSON.stringify({
      path: location.pathname,
      text: document.body.innerText.trim().length,
      // Битая — «загрузка кончилась, а пикселей нет». У loading="lazy» ниже
      // сгиба загрузка на момент проверки и не начиналась — такие не в счёт.
      broken: [...document.images].filter(i => i.hasAttribute('src') && i.complete && i.naturalWidth === 0)
                                  .map(i => i.getAttribute('src')),
      // Прокрутка вбок — на телефоне это поломка вёрстки, даже если всё видно.
      wide: document.documentElement.scrollWidth - innerWidth,
      status404: !!document.querySelector('.tk-status [data-i18n="missing.title"]'),
    })`));

    const r = p.report();
    const found = [];
    const own = (h) => status !== 200 && h.includes(' ' + status + ' ') && h.endsWith(url.split('?')[0]);
    for (const e of new Set(r.exceptions)) found.push(['исключение в JS', e]);
    for (const d of new Set(p.dialogs()))  found.push(['блокирующий диалог', d]);
    for (const h of new Set(r.http))       if (!own(h)) found.push(['ответ с ошибкой', h]);
    for (const f of new Set(r.failed))     found.push(['запрос не состоялся', f]);
    for (const i of new Set(info.broken))  found.push(['битая картинка', i]);
    if (info.text < 40) found.push(['пустая страница', `текста ${info.text} символов`]);
    if (info.wide > 1) found.push(['прокрутка вбок', `шире экрана на ${info.wide} px`]);
    if (status === 404 && !info.status404) found.push(['404 без страницы сайта', 'нет .tk-status с missing.title']);

    const mark = found.length ? `${c.bad}✗${c.off}` : `${c.ok}✓${c.off}`;
    console.log(`  ${mark} ${name.padEnd(22)} ${c.dim}${width} ${url} → ${info.path}${c.off}`);
    for (const [kind, detail] of found) {
      problems++;
      console.log(`      ${c.bad}${kind}:${c.off} ${String(detail).slice(0, 160)}`);
    }

    if (SHOTS) {
      const file = `${SHOTS}/${width}${url.replace(/[^a-z0-9]+/gi, '_') || '_root'}.png`;
      await p.shot(file, width >= 768);
    }
  }
}

// Эфир, автор, запись, видео — переходами по сайту: так проверяется и то,
// что ссылки на них ведут куда надо.
async function discover(p) {
  const found = [];
  await p.goto(BASE + '/');
  const stream = await firstLink(p, '^/stream/[a-f0-9]{24}$');
  if (stream) found.push(['эфир', stream]);
  await p.goto(BASE + '/authors');
  const author = await firstLink(p, '^/userPage/[a-f0-9]{24}$');
  if (author) {
    found.push(['профиль автора', author]);
    await p.goto(BASE + author);
    const rec = await firstLink(p, '^/recording/[a-f0-9]{24}$');
    if (rec) found.push(['запись', rec]);
    found.push(['галерея автора', author + '/gallery']);
    found.push(['подписчики автора', author + '/followers']);
    await p.goto(BASE + author + '/gallery');
    const video = await firstLink(p, '^/video/[a-f0-9]{24}$');
    if (video) found.push(['видео', video]);
  }
  return found;
}

const p = await newPage();

console.log(`\n${c.step}── Публичные страницы ${c.off}`);
for (const [name, url] of PUBLIC) await check(p, name, url);
const guestFound = await discover(p);
for (const [name, url] of guestFound) await check(p, name, url);
if (!guestFound.some(([n]) => n === 'эфир')) console.log(`  ${c.warn}·${c.off} эфир                   ${c.dim}на витрине нет ни одного${c.off}`);
await check(p, 'такой страницы нет', '/takoy-stranicy-net-' + Date.now(), { status: 404 });

if (EMAIL && PASSWORD) {
  const code = await p.eval(`fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email:${JSON.stringify(EMAIL)},password:${JSON.stringify(PASSWORD)}})}).then(r=>r.status)`);
  if (code !== 200) {
    console.log(`\n  ${c.bad}✗${c.off} вход не удался (HTTP ${code}) — страницы за входом не проверены`);
    problems++;
  } else {
    console.log(`\n${c.step}── Страницы за входом ${c.off}`);
    for (const [name, url] of PRIVATE) await check(p, name, url);
    const me = await p.eval('(window.TK && TK.userId) || ""');
    if (me) {
      await check(p, 'моя страница', '/userPage/' + me);
      await check(p, 'моя галерея', '/userPage/' + me + '/gallery');
      await check(p, 'мои подписки', '/userPage/' + me + '/following');
    }
    for (const [name, url] of await discover(p)) await check(p, name + ' (вошедшему)', url);

    // Выход — POST из формы в левой панели (с 24.09.2026): GET /logout нет.
    await viewport(p, 1440);
    await p.goto(BASE + '/');
    const hasForm = await p.eval(`!!document.querySelector('form[action="/logout"]')`);
    if (hasForm) {
      await p.eval(`document.querySelector('form[action="/logout"]').submit(); true`);
      await new Promise((r) => setTimeout(r, 1500));
    }
    const after = await p.eval(`fetch('/api/badge',{headers:{Accept:'application/json'}}).then(r=>r.status)`);
    const out = hasForm && after === 401;
    console.log(`  ${out ? c.ok + '✓' : c.bad + '✗'}${c.off} выход формой закрывает сеанс ${c.dim}→ /api/badge ${after}${c.off}`);
    if (!out) problems++;
  }
} else {
  console.log(`\n  ${c.warn}·${c.off} SMOKE_EMAIL / SMOKE_PASSWORD не заданы — страницы за входом пропущены`);
}

await p.close();

console.log(`\n${c.step}────────────────────────────────────────${c.off}`);
console.log(`  проверено открытий страниц: ${checked} (ширины: ${WIDTHS.join(', ')})`);
if (problems) {
  console.log(`  найдено проблем: ${c.bad}${problems}${c.off}\n`);
  process.exit(Math.min(problems, 250));
}
console.log(`  ${c.ok}страницы отрабатывают без ошибок${c.off}\n`);
