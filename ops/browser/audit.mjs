// Аудит вёрстки: адаптив, кликабельность, битые ссылки, вес страницы.
//
//   SMOKE_EMAIL=... SMOKE_PASSWORD=... SHOTS=./shots \
//     RUNNER=audit.mjs bash ops/browser-check.sh http://127.0.0.1:3100
//
// browser-check.sh поднимает Chrome и передаёт управление сюда. В отличие от
// walk.mjs, который отвечает на вопрос «страница работает?», этот скрипт
// отвечает на «страница сделана?»: открывает каждую в четырёх ширинах, ищет
// горизонтальную прокрутку, мелкие кнопки, пустые ссылки, невидимый текст,
// картинки без размеров и считает, во что страница обходится браузеру.
//
// Код возврата — число находок.

import { newPage } from './cdp.mjs';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const SHOTS = process.env.SHOTS || '';
const EMAIL = process.env.SMOKE_EMAIL || '';
const PASSWORD = process.env.SMOKE_PASSWORD || '';
const ONLY = (process.env.AUDIT_PAGES || '').split(',').map(s => s.trim()).filter(Boolean);

const c = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', step: '\x1b[36m', dim: '\x1b[2m', off: '\x1b[0m' };

// Ширины подобраны по тому, чем реально пользуются: десктоп, ноутбук,
// планшет в портрете и телефон. Пятой «на всякий случай» нет намеренно —
// каждая добавляет полный прогон по всем страницам.
const SCREENS = [
  { name: 'десктоп', w: 1440, h: 900, mobile: false },
  { name: 'ноутбук', w: 1280, h: 800, mobile: false },
  { name: 'планшет', w: 768, h: 1024, mobile: true },
  { name: 'телефон', w: 390, h: 844, mobile: true },
];

const PUBLIC = [
  ['главная', '/'],
  ['вход', '/login'],
  ['регистрация', '/register'],
  ['о проекте', '/about'],
  ['условия', '/terms_of_service'],
  ['соглашение', '/user_agreement'],
  ['персональные данные', '/personal_data_processing'],
];
const PRIVATE = [
  ['каталог эфиров', '/streaming'],
  ['каталог с фильтрами', '/streaming/business?sub=horeca&city=belgrade&sort=new'],
  ['личная главная', '/main'],
  ['переписка', '/chatsPage'],
];

const findings = [];
const linksSeen = new Map();   // href -> страницы, где встретился
let requestsTotal = 0;
let bytesTotal = 0;

function add(page, screen, kind, text) {
  findings.push({ page, screen, kind, text });
}

// Всё, что собирается со страницы, считается в браузере одним куском:
// каждый вызов eval — это раунд по сокету, а страниц и ширин много.
const COLLECT = `(() => {
  const vw = window.innerWidth;
  const isVisible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // Горизонтальная прокрутка страницы и виновники: элементы, вылезшие вправо.
  const overflow = document.documentElement.scrollWidth - vw;
  const wide = [];
  if (overflow > 1) {
    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width <= document.documentElement.scrollWidth) {
        const tag = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
                    (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : '');
        wide.push(tag + ' до ' + Math.round(r.right) + 'px');
        if (wide.length >= 5) break;
      }
    }
  }

  // Кликабельные зоны. 32px — нижняя граница, ниже которой в палец
  // попадают через раз; для телефона это существенно, для мыши терпимо.
  const CLICKABLE = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [onclick]';
  const small = [];
  const empty = [];
  const links = [];
  for (const el of document.querySelectorAll(CLICKABLE)) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40) || el.tagName.toLowerCase();

    // Ссылку внутри абзаца не меряем: она такой высоты, какой строка текста,
    // и требовать от неё 32px — значит требовать этого от всей типографики.
    const inProse = el.tagName === 'A' && el.closest('p, li, td') &&
                    el.closest('p, li, td').textContent.trim().length > el.textContent.trim().length + 3;

    // Своя зона мала, если в неё трудно попасть пальцем: узкая по обеим
    // сторонам (значок) или совсем низкая (кнопка в одну строку).
    if (!inProse && (Math.min(r.width, r.height) < 32 || r.height < 24)) {
      small.push(label + ' — ' + Math.round(r.width) + '×' + Math.round(r.height));
    }

    if (el.tagName === 'A') {
      const href = el.getAttribute('href') || '';
      if (!href || href === '#') empty.push(label);
      else if (href.startsWith('/') && !href.startsWith('//')) links.push(href.split('#')[0]);
    }
    // Кнопка без подписи и без aria-label — для скринридера пустая.
    if (el.tagName === 'BUTTON' && !el.textContent.trim() && !el.getAttribute('aria-label')) {
      empty.push('button без подписи');
    }
  }

  // Картинки: без размеров — прыжок вёрстки при загрузке; вчетверо больше
  // показанного — лишние килобайты на пустом месте.
  const images = [];
  for (const img of document.images) {
    if (!isVisible(img)) continue;
    const r = img.getBoundingClientRect();
    if (!img.getAttribute('width') || !img.getAttribute('height')) {
      images.push('без width/height: ' + (img.getAttribute('src') || '').slice(-40));
    }
    // Двукратный запас — это норма для экранов с плотностью 2x, поэтому
    // придираемся только к тройному и выше.
    if (img.naturalWidth && r.width && img.naturalWidth > r.width * 3) {
      images.push('втрое больше показа (' + img.naturalWidth + 'px против ' + Math.round(r.width) + '): ' + (img.getAttribute('src') || '').slice(-40));
    }
  }

  // Текст цвета фона — его не видно, а он есть.
  const invisible = [];
  for (const el of document.querySelectorAll('p, span, a, h1, h2, h3, li, td, button')) {
    if (!el.textContent.trim() || !isVisible(el)) continue;
    const s = getComputedStyle(el);
    if (s.color === s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      invisible.push(el.textContent.trim().slice(0, 30));
      if (invisible.length >= 3) break;
    }
  }

  // Блокирующие скрипты в голове: без defer и async они тормозят отрисовку.
  const blocking = [...document.querySelectorAll('head script[src]')]
    .filter(s => !s.defer && !s.async)
    .map(s => s.getAttribute('src'));

  const external = [...new Set([...document.querySelectorAll('script[src], link[rel=stylesheet]')]
    .map(el => el.getAttribute('src') || el.getAttribute('href') || '')
    .filter(u => /^https?:\\/\\//.test(u))
    .map(u => new URL(u).host))];

  return {
    overflow, wide,
    small: [...new Set(small)].slice(0, 6),
    empty: [...new Set(empty)].slice(0, 6),
    links: [...new Set(links)],
    images: [...new Set(images)].slice(0, 6),
    invisible, blocking, external,
    title: document.title,
    height: document.documentElement.scrollHeight
  };
})()`;

async function auditPage(p, name, url) {
  process.stdout.write(`  ${name} ${c.dim}${url}${c.off}\n`);

  for (const s of SCREENS) {
    await p.send('Emulation.setDeviceMetricsOverride', {
      width: s.w, height: s.h, deviceScaleFactor: 1, mobile: s.mobile
    });

    await p.goto(BASE + url);
    const r = await p.report();
    const info = await p.eval(COLLECT);

    // Сетевое считаем один раз, на самой широкой: на остальных те же файлы.
    if (s.w === 1440) {
      const responses = p.events.filter(e => e.method === 'Network.responseReceived');
      requestsTotal += responses.length;
      for (const e of p.events.filter(e => e.method === 'Network.loadingFinished')) {
        bytesTotal += e.params.encodedDataLength || 0;
      }

      for (const line of r.exceptions) add(name, s.name, 'скрипт', line);
      for (const line of r.http) add(name, s.name, 'сеть', line);
      for (const line of info.blocking) add(name, '—', 'скорость', 'блокирующий скрипт в <head>: ' + line);
      for (const host of info.external) add(name, '—', 'скорость', 'внешний хост: ' + host);
      for (const line of info.images) add(name, '—', 'картинки', line);
      for (const line of info.invisible) add(name, '—', 'вёрстка', 'текст цвета фона: ' + line);
      for (const line of info.empty) add(name, '—', 'кликабельность', 'ссылка или кнопка в никуда: ' + line);
      for (const href of info.links) {
        if (!linksSeen.has(href)) linksSeen.set(href, new Set());
        linksSeen.get(href).add(name);
      }
    }

    if (info.overflow > 1) {
      add(name, s.name, 'адаптив', `страница шире экрана на ${info.overflow}px` +
          (info.wide.length ? ` — ${info.wide.join(', ')}` : ''));
    }
    // Мелкие зоны считаем только там, где жмут пальцем.
    if (s.mobile && info.small.length) {
      add(name, s.name, 'кликабельность', 'мелкие зоны: ' + info.small.join('; '));
    }

    if (SHOTS) {
      const file = `${SHOTS}/${s.w}${url.replace(/[^\w-]+/g, '_') || '_'}.png`;
      const { data } = await p.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    }
  }
}

// ── Прогон ───────────────────────────────────────────────────────────────────
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const p = await newPage();

console.log(`\n${c.step}── Публичные страницы ${c.off}`);
for (const [name, url] of PUBLIC) {
  if (ONLY.length && !ONLY.includes(url)) continue;
  await auditPage(p, name, url);
}

if (EMAIL && PASSWORD) {
  // Вход отправляется относительным адресом, а он считается от текущей
  // страницы. Если публичные страницы отфильтрованы через AUDIT_PAGES,
  // вкладка ещё на about:blank, и запрос падает на разборе адреса.
  await p.goto(BASE + '/');

  const code = await p.eval(`fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email:${JSON.stringify(EMAIL)},password:${JSON.stringify(PASSWORD)}})}).then(r=>r.status)`);

  if (code !== 200) {
    console.log(`  ${c.bad}✗${c.off} вход не удался (HTTP ${code})`);
    add('вход', '—', 'сеть', 'вход не удался, HTTP ' + code);
  } else {
    console.log(`\n${c.step}── Страницы за входом ${c.off}`);
    for (const [name, url] of PRIVATE) {
      if (ONLY.length && !ONLY.includes(url)) continue;
      await auditPage(p, name, url);
    }

    for (const extra of (process.env.SMOKE_PAGES || '').split(',').map(s => s.trim()).filter(Boolean)) {
      await auditPage(p, extra, extra);
    }
  }
}

// ── Ссылки ───────────────────────────────────────────────────────────────────
console.log(`\n${c.step}── Ссылки ${c.off}`);
const linkRows = [];
for (const [href, pages] of linksSeen) {
  // redirect: 'manual' отдаёт непрозрачный ответ со статусом 0 — переход
  // на вход выглядел как «ссылка не ответила». Идём по редиректу и смотрим,
  // чем всё кончилось.
  const status = await p.eval(
    `fetch(${JSON.stringify(href)}, { method: 'GET' }).then(r => r.status).catch(() => 0)`
  );
  linkRows.push({ href, status, pages: [...pages] });
  // Ноль — это не отказ, а невозможность проверить: так выглядит переход
  // на чужой домен (тот же /auth/google уводит к Google, и fetch к нему
  // упирается в межсайтовые правила). Разводим с настоящими ошибками.
  if (status >= 400) {
    add([...pages].join(', '), '—', 'ссылки', `${href} → ${status}`);
  } else if (status === 0) {
    add([...pages].join(', '), '—', 'ссылки', `${href} → уводит на другой домен, из браузера не проверить`);
  }
}
console.log(`  проверено ${linkRows.length}, битых ${linkRows.filter(r => r.status >= 400).length}` +
            `, внешних ${linkRows.filter(r => r.status === 0).length}`);

await p.close();

// ── Отчёт ────────────────────────────────────────────────────────────────────
const byKind = {};
for (const f of findings) (byKind[f.kind] ||= []).push(f);

console.log(`\n${c.step}────────────────────────────────────────${c.off}`);
console.log(`  запросов на страницу (в среднем): ${Math.round(requestsTotal / Math.max(1, PUBLIC.length + PRIVATE.length))}`);
console.log(`  суммарный вес загруженного: ${(bytesTotal / 1024 / 1024).toFixed(2)} МБ\n`);

for (const kind of Object.keys(byKind).sort()) {
  console.log(`${c.step}── ${kind} (${byKind[kind].length}) ${c.off}`);
  for (const f of byKind[kind]) {
    console.log(`  ${c.warn}·${c.off} ${f.page}${f.screen !== '—' ? ' / ' + f.screen : ''}: ${f.text}`);
  }
  console.log('');
}

if (SHOTS) {
  fs.writeFileSync(`${SHOTS}/audit.json`, JSON.stringify({ findings, links: linkRows }, null, 2));
  console.log(`  подробности: ${SHOTS}/audit.json\n`);
}

process.exit(Math.min(findings.length, 250));
