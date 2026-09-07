// Обход страниц живым браузером.
//
//   node ops/browser/walk.mjs https://takebana.com
//   SMOKE_EMAIL=... SMOKE_PASSWORD=... node ops/browser/walk.mjs http://127.0.0.1:3000
//   SHOTS=./shots node ops/browser/walk.mjs http://127.0.0.1:3000
//
// Запускается через ops/browser-check.sh, который сам поднимает Chrome.
// Ловит то, чего не видит smoke.sh: исключения в консоли, запросы, вернувшие
// 4xx/5xx, несостоявшиеся загрузки, блокирующие alert() и битые картинки.
//
// Код возврата — число найденных проблем.

import { newPage } from './cdp.mjs';
import fs from 'node:fs';

const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const SHOTS = process.env.SHOTS || '';
const EMAIL = process.env.SMOKE_EMAIL || '';
const PASSWORD = process.env.SMOKE_PASSWORD || '';

const c = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', step: '\x1b[36m', dim: '\x1b[2m', off: '\x1b[0m' };
let problems = 0;

if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// Страницы, доступные без входа. Остальные добавляются, если заданы SMOKE_*.
const PUBLIC = [
  ['главная', '/'],
  ['вход', '/login'],
  ['регистрация', '/register'],
  ['о проекте', '/about'],
  ['условия', '/terms_of_service'],
];
const PRIVATE = [
  ['каталог эфиров', '/streaming'],
  ['личная главная', '/main'],
  ['переписка', '/chatsPage'],
];

async function check(p, name, url) {
  await p.goto(BASE + url);

  const info = JSON.parse(await p.eval(`JSON.stringify({
    path: location.pathname,
    title: document.title,
    text: document.body.innerText.trim().length,
    // src="" заставляет браузер повторно грузить саму страницу; без src — просто пустая картинка
    broken: [...document.images].filter(i => i.hasAttribute('src') && (!i.complete || i.naturalWidth === 0))
                                .map(i => i.getAttribute('src'))
  })`));

  const r = p.report();
  const dialogs = p.dialogs();
  const found = [];

  for (const e of new Set(r.exceptions)) found.push(['исключение в JS', e]);
  for (const d of new Set(dialogs))     found.push(['блокирующий диалог', d]);
  for (const h of new Set(r.http))      found.push(['ответ с ошибкой', h]);
  for (const f of new Set(r.failed))    found.push(['запрос не состоялся', f]);
  for (const i of new Set(info.broken)) found.push(['битая картинка', i]);
  if (info.text < 40) found.push(['пустая страница', `текста ${info.text} символов`]);

  const mark = found.length ? `${c.bad}✗${c.off}` : `${c.ok}✓${c.off}`;
  console.log(`  ${mark} ${name.padEnd(18)} ${c.dim}${url} → ${info.path}${c.off}`);
  for (const [kind, detail] of found) {
    problems++;
    console.log(`      ${c.bad}${kind}:${c.off} ${String(detail).slice(0, 160)}`);
  }

  if (SHOTS) {
    const file = `${SHOTS}/${url.replace(/[^a-z0-9]+/gi, '_') || 'root'}.png`;
    await p.shot(file);
  }
}

const p = await newPage();
console.log(`\n${c.step}── Публичные страницы ${c.off}`);
for (const [name, url] of PUBLIC) await check(p, name, url);

if (EMAIL && PASSWORD) {
  const code = await p.eval(`fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email:${JSON.stringify(EMAIL)},password:${JSON.stringify(PASSWORD)}})}).then(r=>r.status)`);
  if (code !== 200) {
    console.log(`\n  ${c.bad}✗${c.off} вход не удался (HTTP ${code}) — страницы за входом не проверены`);
    problems++;
  } else {
    console.log(`\n${c.step}── Страницы за входом ${c.off}`);
    for (const [name, url] of PRIVATE) await check(p, name, url);

    // Страница эфира: берём первый эфир из каталога, если он там есть
    const href = await p.eval(`(() => {
      const a = [...document.querySelectorAll('a[href*="/stream/"]')][0];
      return a ? new URL(a.href).pathname : '';
    })()`);
    if (href) await check(p, 'страница эфира', href);
    else console.log(`  ${c.warn}·${c.off} страница эфира      ${c.dim}в каталоге нет ни одного эфира${c.off}`);
  }
} else {
  console.log(`\n  ${c.warn}·${c.off} SMOKE_EMAIL / SMOKE_PASSWORD не заданы — страницы за входом пропущены`);
}

await p.close();

console.log(`\n${c.step}────────────────────────────────────────${c.off}`);
if (problems) {
  console.log(`  найдено проблем: ${c.bad}${problems}${c.off}\n`);
  process.exit(Math.min(problems, 250));
}
console.log(`  ${c.ok}страницы отрабатывают без ошибок${c.off}\n`);
