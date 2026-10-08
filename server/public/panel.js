/* Панель администрирования — /panel.
 *
 * Один файл на все вкладки вместо прежних двух (admin.js про заведения,
 * panel-moderation.js про жалобы и людей): у них были свои cardHtml() и note(),
 * и подключённые вместе они молча перетирали друг друга.
 *
 * Устроено так: вкладка описывается объектом — откуда берутся данные, какие
 * у неё фильтры и как выглядит строка. Списки, фильтры, пагинацию и обработку
 * ошибок делает общий каркас, поэтому новая вкладка — это описание, а не ещё
 * одна копия загрузки с пагинацией.
 *
 * Адрес вкладки живёт в хеше: #/people?role=admin&page=2. Панель открывается
 * там, где её закрыли, ссылку на отфильтрованный список можно переслать,
 * а «назад» в браузере работает сам собой.
 */
(function () {
'use strict';

const BOOT = window.TKPanel || {};
const IS_ADMIN = !!BOOT.isAdmin;
const ACTIONS = BOOT.actions || {};
const CATALOG = BOOT.catalog || { cities: [], types: [], categories: {} };

const CITY = new Map((CATALOG.cities || []).map((c) => [c.code, c.name]));
const COUNTRY = new Map((CATALOG.countries || []).map((c) => [c.code, c.name]));
const VENUE_TYPE = new Map((CATALOG.types || []).map((t) => [t.code, t.name]));
// Город в списке заведения — со страной: «Нови-Сад · Сербия».
const VENUE_CITY = new Map((CATALOG.cities || []).map((c) => [c.code, c.name + (COUNTRY.get(c.country) ? ' · ' + COUNTRY.get(c.country) : '')]));
const CATEGORY = new Map(Object.entries(CATALOG.categories || {}).map(([code, c]) => [code, c.name]));

const nav = document.getElementById('nav');
const view = document.getElementById('view');
const viewTitle = document.getElementById('viewTitle');
const viewSub = document.getElementById('viewSub');
const viewTools = document.getElementById('viewTools');

// ── Мелочи ───────────────────────────────────────────────────────────────────

const esc = window.escapeHtml;

// Дата в панели читается человеком: день, месяц, время. Год — только у
// прошлогоднего, иначе он занимает место в каждой строке таблицы.
function when(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d)) return '—';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// «Сколько назад» — для последнего входа и свежести ошибки.
function ago(value) {
  if (!value) return '—';
  const sec = Math.round((Date.now() - new Date(value)) / 1000);
  if (isNaN(sec)) return '—';
  if (sec < 60) return 'только что';
  if (sec < 3600) return Math.floor(sec / 60) + ' мин назад';
  if (sec < 86400) return Math.floor(sec / 3600) + ' ч назад';
  if (sec < 2592000) return Math.floor(sec / 86400) + ' дн назад';
  return when(value);
}

function dur(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (!s) return '0 с';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return h + ' ч ' + String(m).padStart(2, '0') + ' м';
  if (m) return m + ' м ' + String(s % 60).padStart(2, '0') + ' с';
  return s + ' с';
}

function bytes(n) {
  const v = Number(n) || 0;
  if (v >= 1073741824) return (v / 1073741824).toFixed(1) + ' ГБ';
  if (v >= 1048576) return (v / 1048576).toFixed(0) + ' МБ';
  if (v >= 1024) return (v / 1024).toFixed(0) + ' КБ';
  return v + ' Б';
}

const num = (n) => String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// Число со словом в нужной форме: 1 запись, 2 записи, 5 записей.
function count(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  const word = a > 10 && a < 20 ? many : b === 1 ? one : b > 1 && b < 5 ? few : many;
  return num(n) + ' ' + word;
}

// Ссылка на вкладку: единственное место, где собирается адрес в хеше.
function href(name, params) {
  const q = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => { if (v !== '' && v != null) q.set(k, v); });
  const tail = q.toString();
  return '#/' + name + (tail ? '?' + tail : '');
}

const go = (name, params) => { location.hash = href(name, params); };

// ── Обращения к серверу ──────────────────────────────────────────────────────

async function api(path) {
  const res = await fetch('/api/admin' + path, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || 'HTTP ' + res.status);
  }
  return res.json();
}

async function send(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'HTTP ' + res.status);
  return data;
}

// ── Кусочки разметки ─────────────────────────────────────────────────────────

const note = (text) => '<p class="tk-panel__note">' + esc(text) + '</p>';

// Человек одинаково выглядит везде: в списке, в строке журнала, в жалобе.
// Кликается — открывает профиль.
function person(p, extra) {
  if (!p) return '<span class="tk-panel__gone">нет аккаунта</span>';
  const style = p.avatar && p.avatar.url
    ? 'background-image:url(' + esc(p.avatar.url) + ')'
    : 'background:' + esc((p.avatar && p.avatar.gradient) || '#333');
  const letter = p.avatar && p.avatar.url ? '' : esc((p.avatar && p.avatar.initial) || '?');

  return '<a class="tk-person" href="' + href('person', { id: p.id }) + '">' +
           '<span class="tk-person__pic" style="' + style + '">' + letter + '</span>' +
           '<span class="tk-person__name">' + esc(p.displayName || '') +
             (p.banned ? '<span class="tk-tag tk-tag--bad">ограничен</span>' : '') +
             (p.role && p.role !== 'user' ? '<span class="tk-tag">' + esc(p.role === 'admin' ? 'админ' : 'модератор') + '</span>' : '') +
             (extra ? '<span class="tk-person__extra">' + extra + '</span>' : '') +
           '</span>' +
         '</a>';
}

// Подробности действия — парами «ключ: значение», а не сырым JSON:
// журнал читают глазами, строка за строкой.
const META = {
  reason: 'причина', was: 'было', now: 'стало', status: 'статус', fields: 'поля', save: 'с записью',
  duration: 'длительность', peakViewers: 'пик', size: 'размер', rows: 'строк', sessions: 'сеансов',
  source: 'источник', rating: 'оценка', added: 'добавлено', total: 'всего', file: 'файл', error: 'ошибка',
  what: 'лимит', streams: 'эфиров', venues: 'заведений', recordings: 'записей', reports: 'жалоб', messages: 'сообщений',
  subscriptions: 'подписок', calls: 'звонков', byAdmin: 'из панели', streamsStopped: 'погашено эфиров', venuesStopped: 'погашено камер',
  resolved: 'разобрано', count: 'случаев', action: 'сделано', about: 'на что', city: 'город', type: 'тип',
  category: 'раздел', isAdult: '18+', wasLive: 'шёл', login: 'логин',
  privacy: 'приватность', audience: 'кому', template: 'заготовка', len: 'знаков', on: 'включено',
  chat: 'переписка', photos: 'фото', videos: 'видео',
};

function meta(m) {
  if (!m || typeof m !== 'object') return '';
  const show = (v) => typeof v === 'boolean' ? (v ? 'да' : 'нет')
    : Array.isArray(v) ? v.join(', ')
    : v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => (META[k] || k) + ' ' + show(x)).join(', ')
    : String(v);
  return Object.entries(m)
    .filter(([k, v]) => v !== '' && v != null && k !== 'fingerprint' && k !== 'filter')
    .map(([k, v]) => esc(META[k] || k) + ': ' + esc(show(k === 'duration' ? dur(v) : k === 'size' ? bytes(v) : v).slice(0, 120)))
    .join('<br>');
}

const dot = (on) => '<span class="tk-dot' + (on ? ' tk-dot--on' : '') + '"></span>';

function tile(title, value, hint) {
  return '<div class="tk-tile">' +
           '<p class="tk-tile__title">' + esc(title) + '</p>' +
           '<p class="tk-tile__value">' + value + '</p>' +
           (hint ? '<p class="tk-tile__hint">' + hint + '</p>' : '') +
         '</div>';
}

// Пагинация: страницы рисуются окном вокруг текущей — при сорока страницах
// журнала полный список номеров занял бы больше места, чем сами записи.
function pager(data, name, params) {
  if (!data || data.pages <= 1) return '';
  const page = data.page;
  const last = data.pages;
  const window_ = new Set([1, last, page, page - 1, page + 1, page - 2, page + 2]);
  const pages = [...window_].filter((n) => n >= 1 && n <= last).sort((a, b) => a - b);

  let html = '<nav class="tk-pager">';
  html += '<a class="tk-pager__step' + (page <= 1 ? ' is-off' : '') + '" href="' +
          href(name, { ...params, page: Math.max(1, page - 1) }) + '">Назад</a>';

  let prev = 0;
  for (const n of pages) {
    if (n - prev > 1) html += '<span class="tk-pager__gap">…</span>';
    html += '<a class="tk-pager__page' + (n === page ? ' is-on' : '') + '" href="' +
            href(name, { ...params, page: n }) + '">' + n + '</a>';
    prev = n;
  }

  html += '<a class="tk-pager__step' + (page >= last ? ' is-off' : '') + '" href="' +
          href(name, { ...params, page: Math.min(last, page + 1) }) + '">Вперёд</a>';
  html += '<span class="tk-pager__total">всего ' + num(data.total) + '</span>';
  return html + '</nav>';
}

function table(head, rows) {
  if (!rows.length) return note('Здесь пусто');
  return '<div class="tk-table__box"><table class="tk-table"><thead><tr>' +
         head.map((h) => '<th' + (h.cls ? ' class="' + h.cls + '"' : '') + '>' + esc(h.title) + '</th>').join('') +
         '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
}

// ── Фильтры ──────────────────────────────────────────────────────────────────
//
// Значения фильтров живут в адресе, а не в памяти скрипта: перезагрузка
// страницы и «назад» в браузере не должны сбрасывать отбор, за которым
// человек шёл в панель.
function filtersHtml(spec, params) {
  return (spec || []).map((f) => {
    const value = params[f.name] || '';
    if (f.type === 'search') {
      return '<input type="search" class="tk-field tk-field--search" data-filter="' + esc(f.name) + '" ' +
             'placeholder="' + esc(f.placeholder || 'Поиск') + '" value="' + esc(value) + '" autocomplete="off">';
    }
    if (f.type === 'date') {
      return '<label class="tk-field-date">' + esc(f.placeholder || '') +
             '<input type="date" class="tk-field" data-filter="' + esc(f.name) + '" value="' + esc(value) + '"></label>';
    }
    const options = typeof f.options === 'function' ? f.options() : f.options;
    return '<select class="tk-field tk-select" data-filter="' + esc(f.name) + '">' +
           options.map((o) => '<option value="' + esc(o.value) + '"' +
             (String(o.value) === String(value) ? ' selected' : '') + '>' + esc(o.title) + '</option>').join('') +
           '</select>';
  }).join('');
}

// ── Графики ──────────────────────────────────────────────────────────────────
//
// Один показатель — один график со своей шкалой: часы эфиров и число звонков
// на одной оси друг друга сплющивают. Столбики — HTML, а не SVG: подписи
// не растягиваются вместе с шириной, а столбик — это просто высота в процентах.
//
// Цвет один на все графики: у каждого одна серия, различать нечего, и
// название над графиком говорит, что он показывает. Синий #3987e5 — не
// зелёный «на связи» и не красный «ограничен» панели, прошёл проверку
// контраста на тёмном фоне (dataviz validate_palette, dark).
const dayLabel = (iso) => iso.slice(8, 10) + '.' + iso.slice(5, 7);

// labels — подпись каждой колонки (день, час, минута); foot — строка справа
// от названия; cap — верх шкалы, если он известен заранее (проценты — 100).
function series(title, labels, values, fmt, foot, cap) {
  const max = cap || Math.max(...values, 0);
  const cols = values.map((v, i) =>
    '<div class="tk-chart__col" data-tip="' + esc(labels[i] + ' — ' + fmt(v)) + '">' +
      (v ? '<i style="height:' + Math.min(100, Math.max(2, (v / max) * 100)).toFixed(1) + '%"></i>' : '') +
    '</div>').join('');

  const mid = Math.floor(labels.length / 2);
  return '<figure class="tk-chart">' +
    '<figcaption class="tk-chart__head"><span class="tk-chart__title">' + esc(title) + '</span>' +
      '<span class="tk-chart__total">' + esc(foot) + '</span></figcaption>' +
    '<div class="tk-chart__plot" role="img" aria-label="' + esc(title + ': ' + foot) + '">' +
      '<span class="tk-chart__max">' + esc(max ? fmt(max) : '') + '</span>' +
      '<div class="tk-chart__bars">' + cols + '</div>' +
    '</div>' +
    '<div class="tk-chart__axis"><span>' + esc(labels[0] || '') + '</span><span>' + esc(labels[mid] || '') + '</span><span>' + esc(labels[labels.length - 1] || '') + '</span></div>' +
  '</figure>';
}

// По дням — сводка.
function chart(title, days, values, format) {
  const fmt = format || num;
  const total = values.reduce((a, b) => a + b, 0);
  return series(title, days.map(dayLabel), values, fmt,
    'за период ' + fmt(Math.round(total * 10) / 10) + ' · сегодня ' + fmt(values[values.length - 1] || 0));
}

// Подсказка одна на страницу: следует за колонкой под курсором. Колонка
// во всю высоту графика — попасть в неё проще, чем в низкий столбик.
const tip = document.createElement('div');
tip.className = 'tk-chart__tip';
tip.hidden = true;
document.body.appendChild(tip);

view.addEventListener('mouseover', (e) => {
  const col = e.target.closest('.tk-chart__col');
  if (!col) { tip.hidden = true; return; }
  tip.textContent = col.dataset.tip;
  tip.hidden = false;
  const r = col.getBoundingClientRect();
  const w = tip.offsetWidth;
  tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2)) + 'px';
  tip.style.top = (r.top + window.scrollY - tip.offsetHeight - 6) + 'px';
});
view.addEventListener('mouseleave', () => { tip.hidden = true; });

// ── Вкладки ──────────────────────────────────────────────────────────────────

const PERIOD = [
  { value: '', title: 'За всё время' },
  { value: 'day', title: 'За сутки' },
  { value: 'week', title: 'За неделю' },
  { value: 'month', title: 'За месяц' },
];

// Готовый отрезок времени превращается в from= на стороне клиента: серверу
// ни к чему знать про «за неделю», он понимает только даты.
function periodFrom(value) {
  const days = { day: 1, week: 7, month: 30 }[value];
  if (!days) return '';
  return new Date(Date.now() - days * 86400000).toISOString();
}

const cityTitle = (code) => CITY.get(code) || code || '';

const VIEWS = {};

// ── Сводка ───────────────────────────────────────────────────────────────────
VIEWS.summary = {
  title: 'Сводка',
  // Период влияет только на графики: плитки — это «сейчас» и «за сутки».
  filters: [{ name: 'days', options: [
    { value: '30', title: 'Графики за 30 дней' }, { value: '14', title: 'За 14 дней' }, { value: '90', title: 'За 90 дней' },
  ] }],
  async render() {
    const d = await api('/summary');

    let html = '<div class="tk-tiles">';
    html += tile('Сейчас в эфире', num(d.live.streams),
      d.live.viewers ? num(d.live.viewers) + ' зрителей' : 'зрителей нет');
    html += tile('Камеры заведений', num(d.live.venues), 'включены сейчас');
    html += tile('На связи', num(d.people.online), 'из ' + num(d.people.total) + ' человек');
    html += tile('Новых жалоб', num(d.reports.new), d.reports.new ? '<a href="' + href('reports') + '">разобрать</a>' : 'разобраны');
    html += tile('Пришли за сутки', num(d.people.day), 'за неделю ' + num(d.people.week));
    html += tile('Эфиры за сутки', num(d.streams.day.count), d.streams.day.hours + ' ч, пик ' + num(d.streams.day.peak));
    html += tile('Эфиры за неделю', num(d.streams.week.count), d.streams.week.hours + ' ч, зрителе-часов ' + d.streams.week.viewerHours);
    html += tile('Записи', num(d.recordings.count), bytes(d.recordings.bytes) +
      (d.recordings.processing ? ', склеивается ' + d.recordings.processing : '') +
      (d.recordings.failed ? ', не вышло ' + d.recordings.failed : ''));

    if (d.errors) {
      html += tile('Ошибки', num(d.errors.groups),
        'случаев: ' + num(d.errors.cases) + ', за сутки: ' + num(d.errors.fresh) + ' · <a href="' + href('errors') + '">открыть</a>');
      html += tile('Неудачных входов', num(d.errors.loginFails), 'за сутки');
    }
    html += '</div>';
    html += '<h2 class="tk-panel__h2">По дням</h2><div id="trends">' + note('Собираем ряды…') + '</div>';

    return { html };
  },

  async after(params) {
    const box = document.getElementById('trends');
    let d;
    try {
      d = await api('/summary/daily?days=' + encodeURIComponent(params.days || 30));
    } catch (err) {
      if (box) box.innerHTML = note('Ряды не собрались: ' + err.message);
      return;
    }
    if (!box || !box.isConnected) return;

    const hours = (v) => String(v).replace('.', ',') + ' ч';
    const CHARTS = [
      ['registrations', 'Регистрации'],
      ['streams', 'Отрезки эфиров'],
      ['streamHours', 'Часы в эфире', hours],
      ['viewerHours', 'Зрителе-часы', hours],
      ['calls', 'Звонки'],
      ['reports', 'Жалобы'],
      ['loginFails', 'Неудачные входы'],
    ].filter(([key]) => d.series[key]);

    let html = '<div class="tk-charts">' +
      CHARTS.map(([key, title, fmt]) => chart(title, d.days, d.series[key], fmt || undefined)).join('') + '</div>';

    // Те же числа таблицей: график без неё не прочитать ни скринридеру,
    // ни тому, кому нужно точное число за конкретный день.
    html += '<details class="tk-card__more tk-charts__table"><summary>Таблица по дням</summary>' +
      table([{ title: 'День' }].concat(CHARTS.map(([, title]) => ({ title, cls: 'tk-num' }))),
        d.days.map((day, i) => '<tr><td>' + esc(dayLabel(day)) + '</td>' +
          CHARTS.map(([key]) => '<td class="tk-num">' + esc(String(d.series[key][i])) + '</td>').join('') + '</tr>').reverse()) +
      '</details>';

    box.innerHTML = html;
  },
};

// ── В эфире ──────────────────────────────────────────────────────────────────
VIEWS.live = {
  title: 'В эфире',
  refresh: 15000, // сам обновляется: это единственная вкладка про «прямо сейчас»
  async render() {
    const d = await api('/live');

    const rows = d.streams.map((s) => '<tr data-stream="' + esc(s.id) + '">' +
      '<td>' + dot(true) + '<a href="/stream/' + esc(s.id) + '" target="_blank" rel="noopener">' + esc(s.title || 'без названия') + '</a>' +
        (IS_ADMIN && s.session ? '<a class="tk-tag" href="' + href('stream', { id: s.session }) + '">хронология</a>' : '') +
        (s.isAdult ? '<span class="tk-tag tk-tag--bad">18+</span>' : '') + '</td>' +
      '<td>' + person(s.owner) + '</td>' +
      '<td><span class="tk-tag">' + esc(s.source === 'obs' ? 'OBS' : 'веб') + '</span></td>' +
      '<td>' + esc(CATEGORY.get(s.category) || s.category || '—') + (s.city ? ' · ' + esc(cityTitle(s.city)) : '') + '</td>' +
      '<td class="tk-num">' + num(s.viewers) + '</td>' +
      '<td class="tk-num">' + num(s.peakViewers) + '</td>' +
      '<td>' + esc(ago(s.startedAt || s.firstLiveAt)) + '</td>' +
      '<td class="tk-acts">' +
        '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="stop-stream" data-id="' + esc(s.id) + '">Стоп-эфир</button>' +
      '</td></tr>');

    let html = table([
      { title: 'Эфир' }, { title: 'Кто' }, { title: 'Источник' }, { title: 'Раздел' },
      { title: 'Зрителей', cls: 'tk-num' }, { title: 'Пик', cls: 'tk-num' }, { title: 'Идёт' }, { title: '' },
    ], rows);

    if (d.venues.length) {
      html += '<h2 class="tk-panel__h2">Камеры заведений</h2>';
      html += table([{ title: 'Заведение' }, { title: 'Город' }, { title: 'Владелец' }], d.venues.map((v) =>
        '<tr><td>' + dot(true) + esc(v.name || 'без названия') + '</td>' +
        '<td>' + esc(cityTitle(v.city)) + '</td>' +
        '<td>' + person(v.owner) + '</td></tr>'));
    }

    const total = d.streams.reduce((n, s) => n + (s.viewers || 0), 0);
    return { html, sub: d.streams.length ? 'эфиров: ' + d.streams.length + ', зрителей: ' + total : 'сейчас никто не вещает' };
  },
};

// ── Эфиры (архив) ────────────────────────────────────────────────────────────
VIEWS.streams = {
  title: 'Эфиры',
  api: '/streams',
  csv: true,
  filters: [
    { name: 'q', type: 'search', placeholder: 'Название эфира' },
    { name: 'source', options: [{ value: '', title: 'Любой источник' }, { value: 'web', title: 'Веб' }, { value: 'obs', title: 'OBS' }] },
    { name: 'endedBy', options: [
      { value: '', title: 'Чем кончился' },
      { value: 'owner', title: 'Ведущий завершил' },
      { value: 'moderation', title: 'Погашен модерацией' },
      { value: 'cleanup', title: 'Брошен' },
      { value: 'restart', title: 'Перезапуск сервера' },
    ] },
    { name: 'real', options: [{ value: '', title: 'Все отрезки' }, { value: '1', title: 'Дольше минуты' }] },
    { name: 'period', options: PERIOD },
  ],
  sub: (d) => d.total + ' отрезков, ' + dur(d.totals.seconds) + ' в эфире, зрителе-часов ' +
       (Math.round((d.totals.viewerSeconds / 3600) * 10) / 10) + ', пик ' + d.totals.peak,
  head: [
    { title: 'Эфир' }, { title: 'Кто' }, { title: 'Источник' }, { title: 'Начало' },
    { title: 'Длительность', cls: 'tk-num' }, { title: 'Пик', cls: 'tk-num' },
    { title: 'Средний', cls: 'tk-num' }, { title: 'Чат', cls: 'tk-num' }, { title: 'Итог' },
  ],
  row: (s) => '<tr>' +
    '<td>' + (IS_ADMIN ? '<a href="' + href('stream', { id: s.id }) + '">' + esc(s.title || 'без названия') + '</a>' : esc(s.title || 'без названия')) +
      (s.isAdult ? '<span class="tk-tag tk-tag--bad">18+</span>' : '') +
      (s.recording ? '<a class="tk-tag" href="/recording/' + esc(s.recording) + '" target="_blank" rel="noopener">запись</a>' : '') + '</td>' +
    '<td>' + person(s.owner) + '</td>' +
    '<td><span class="tk-tag">' + esc(s.source === 'obs' ? 'OBS' : 'веб') + '</span></td>' +
    '<td>' + esc(when(s.startedAt)) + '</td>' +
    '<td class="tk-num">' + esc(dur(s.duration)) + '</td>' +
    '<td class="tk-num">' + num(s.peakViewers) + '</td>' +
    '<td class="tk-num">' + (s.duration ? (Math.round((s.viewerSeconds / s.duration) * 10) / 10) : 0) + '</td>' +
    '<td class="tk-num">' + num(s.chatMessages) + '</td>' +
    '<td>' + esc({ owner: 'завершён', moderation: 'погашен', cleanup: 'брошен', restart: 'перезапуск' }[s.endedBy] || '—') +
      (s.stopReason ? '<span class="tk-panel__why">' + esc(s.stopReason) + '</span>' : '') + '</td>' +
  '</tr>',
};

// ── Люди ─────────────────────────────────────────────────────────────────────
VIEWS.people = {
  title: 'Люди',
  api: '/users',
  csv: true,
  filters: [
    { name: 'q', type: 'search', placeholder: 'Имя или почта' },
    { name: 'role', options: [
      { value: '', title: 'Любая роль' }, { value: 'user', title: 'Пользователи' },
      { value: 'moderator', title: 'Модераторы' }, { value: 'admin', title: 'Администраторы' },
    ] },
    { name: 'status', options: [
      { value: '', title: 'Все' }, { value: 'online', title: 'Сейчас на связи' },
      { value: 'banned', title: 'Ограниченные' }, { value: 'adult', title: 'Подтвердили 18+' },
    ] },
    { name: 'provider', options: [
      { value: '', title: 'Любой вход' }, { value: 'password', title: 'По паролю' }, { value: 'google', title: 'Через Google' },
    ] },
    { name: 'sort', options: [
      { value: 'new', title: 'Новые сверху' }, { value: 'old', title: 'Старые сверху' },
      { value: 'name', title: 'По имени' }, { value: 'seen', title: 'По последнему входу' },
      { value: 'banned', title: 'Ограниченные сверху' },
    ] },
  ],
  sub: (d) => num(d.total) + ' человек',
  head: [{ title: 'Кто' }, { title: 'Роль' }, { title: 'Состояние' }, { title: 'Заведён' }, { title: 'Был на связи' }, { title: '' }],
  row: (p) => '<tr>' +
    '<td>' + person(p) + '</td>' +
    '<td>' + esc({ admin: 'администратор', moderator: 'модератор' }[p.role] || 'пользователь') + '</td>' +
    '<td>' + (p.isOnline ? dot(true) + 'на связи' : '—') + (p.banned ? '<span class="tk-tag tk-tag--bad">ограничен</span>' : '') + '</td>' +
    '<td>' + esc(when(p.createdAt)) + '</td>' +
    '<td>' + esc(ago(p.lastSeen)) + '</td>' +
    '<td class="tk-acts"><a class="tk-btn tk-btn--outline tk-btn--xs" href="' + href('person', { id: p.id }) + '">Инфо</a></td>' +
  '</tr>',
};

// ── Профиль ──────────────────────────────────────────────────────────────────
VIEWS.person = {
  title: 'Профиль',
  hidden: true,
  async render(params) {
    if (!params.id) return { html: note('Человек не выбран') };
    const d = await api('/users/' + encodeURIComponent(params.id));
    const p = d.person;
    const a = d.account;

    let html = '<a class="tk-panel__back" href="' + href('people') + '">← ко всем людям</a>';

    // Причина ограничения — поле рядом с кнопкой: сервер без неё не ограничит,
    // а спрашивать её после нажатия нечем.
    html += '<div class="tk-dossier__head">' + person(p) +
      '<div class="tk-dossier__acts" data-card="' + esc(p.id) + '">' +
        (IS_ADMIN ? '<select class="tk-field tk-select" data-act="role" data-id="' + esc(p.id) + '">' +
          ['user', 'moderator', 'admin'].map((r) => '<option value="' + r + '"' + (p.role === r ? ' selected' : '') + '>' +
            ({ user: 'пользователь', moderator: 'модератор', admin: 'администратор' })[r] + '</option>').join('') +
          '</select>' : '') +
        (p.banned
          ? '<button type="button" class="tk-btn tk-btn--ok tk-btn--xs" data-act="unban" data-id="' + esc(p.id) + '">Снять ограничение</button>'
          : '<input type="text" class="tk-field" data-reason placeholder="Причина ограничения" maxlength="300">' +
            '<button type="button" class="tk-btn tk-btn--danger tk-btn--xs" data-act="ban" data-id="' + esc(p.id) + '">Ограничить</button>') +
        // Пароль — только аккаунту со входом по паролю, и не чужому
        // администратору: сервер откажет так же.
        (IS_ADMIN && a.provider === 'password' && (p.role !== 'admin' || p.id === BOOT.me.id)
          ? '<input type="password" class="tk-field" data-password placeholder="Новый пароль" minlength="6" maxlength="200" autocomplete="new-password">' +
            '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="password" data-id="' + esc(p.id) + '">Сменить пароль</button>' : '') +
        (IS_ADMIN && a.sessions ? '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="kill-sessions" data-id="' + esc(p.id) + '">Закрыть сеансы (' + a.sessions + ')</button>' : '') +
        // Удалить нельзя себя и администратора — сервер откажет так же.
        (IS_ADMIN && p.role !== 'admin' && p.id !== BOOT.me.id
          ? '<button type="button" class="tk-btn tk-btn--danger tk-btn--xs" data-act="user-delete" data-id="' + esc(p.id) + '" data-name="' + esc(p.displayName) + '">Удалить</button>' : '') +
      '</div></div>';

    if (p.banned) {
      html += '<p class="tk-panel__warn">Ограничен ' + esc(when(a.bannedAt)) + '. Причина: ' + esc(a.banReason || 'не указана') + '</p>';
    }

    if (d.live) {
      html += '<p class="tk-panel__live">' + dot(true) + 'Сейчас в эфире: <a href="/stream/' + esc(d.live.id) + '" target="_blank" rel="noopener">' +
        esc(d.live.title) + '</a> · ' + num(d.live.viewers) + ' зрителей · ' + esc(ago(d.live.startedAt)) +
        ' <button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="stop-stream" data-id="' + esc(d.live.id) + '">Стоп-эфир</button></p>';
    }

    html += '<div class="tk-tiles">';
    html += tile('Эфиров', num(d.streams.count), dur(d.streams.seconds) + ' всего');
    html += tile('Пик зрителей', num(d.streams.peak), d.streams.seconds
      ? 'в среднем ' + (Math.round((d.streams.viewerSeconds / d.streams.seconds) * 10) / 10) : 'эфиров не было');
    html += tile('Записей', num(d.recordings.count), bytes(d.recordings.bytes) + ', ' + dur(d.recordings.seconds));
    html += tile('Подписчиков', num(d.social.subscribers), 'сам подписан на ' + num(d.social.subscriptions));
    html += tile('Сообщений', num(d.social.messagesSent), 'получено ' + num(d.social.messagesGot) + ', в чатах ' + num(d.social.chatMessages));
    html += tile('Звонков', num(d.social.calls), num(d.social.callsAnswered) + ' состоялось, ' + dur(d.social.callSeconds));
    html += tile('Жалоб на него', num(Object.values(d.reports.on).reduce((s, n) => s + n, 0)),
      'новых ' + num(d.reports.on.new || 0) + ' · сам подал ' + num(d.reports.by));
    html += tile('Эфиров погашено', num(d.streams.stoppedByModeration), 'модерацией');
    html += '</div>';

    // Карточками по смыслу (07.10): прежде всё шло одним столбцом фактов,
    // а сроки хранения и заведения стояли рядом без рамок — не понять,
    // где что кончается.
    const fact = (k, v) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>';
    const card = (title, body, cls) => '<section class="tk-dcard' + (cls ? ' ' + cls : '') + '"><h2 class="tk-dcard__title">' + esc(title) + '</h2>' + body + '</section>';
    // «Заменить» — правка прямо в строке (data-act="fact-edit" ниже).
    const replace = (field, value) => ' <button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="fact-edit" data-field="' + field + '" data-id="' + esc(p.id) + '" data-value="' + esc(value || '') + '">Заменить</button>';

    let acc = fact('Идентификатор', '<code>' + esc(p.id) + '</code>');
    if (a.email) acc += fact('Почта', esc(a.email));
    acc += fact('Вход', esc(a.provider === 'google' ? 'через Google' : 'по паролю'));
    acc += fact('Заведён', esc(when(p.createdAt)));
    acc += fact('Был на связи', esc(p.isOnline ? 'сейчас' : ago(p.lastSeen)));
    if (IS_ADMIN) acc += fact('Открытых сеансов', num(a.sessions) + (a.sessionUntil ? ' <span class="tk-panel__why">до ' + esc(when(a.sessionUntil)) + '</span>' : ''));

    // Дату рождения меняет только администратор и только по документу.
    let prof = fact('Дата рождения', '<span class="tk-dcard__v">' + (a.birthDate ? esc(a.birthDate) + ' · ' + a.age + ' лет' : 'не указана') + '</span>' +
      (IS_ADMIN ? replace('birthDate', a.birthDate) : ''));
    prof += fact('Подтвердил 18+', a.adultConfirmedAt ? esc(when(a.adultConfirmedAt)) : 'нет');
    prof += fact('Описание', '<span class="tk-dcard__v tk-facts__pre">' + (a.bio ? esc(a.bio) : '—') + '</span>' + replace('bio', a.bio));
    if (a.links.length) {
      prof += fact('Ссылки', a.links.map((l) => '<a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(l.url) + '</a>').join('<br>'));
    }
    // Ссылка на сайт без nofollow — решает администратор (routes/admin/people.js).
    if (a.links.some((l) => l.kind === 'site')) {
      prof += fact('Сайт для поисковиков', (a.linksFollow ? 'индексируется' : 'nofollow, не индексируется') +
        (IS_ADMIN ? ' <button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="links-follow" data-id="' + esc(p.id) + '" data-on="' + (a.linksFollow ? '' : '1') + '">' +
          (a.linksFollow ? 'Закрыть от индексации' : 'Индексировать') + '</button>' : ''));
    }

    let media = fact('Ключ вещания', a.hasStreamKey ? 'есть' : 'нет');
    media += fact('Эфиры: веб / OBS', num(d.streams.web) + ' / ' + num(d.streams.obs));
    media += fact('Фото в галерее', num(a.gallery));

    html += '<div class="tk-dossier__cards">';
    html += card('Учётная запись', '<dl class="tk-facts">' + acc + '</dl>');
    html += card('Профиль и возраст', '<dl class="tk-facts">' + prof + '</dl>');
    html += card('Эфиры и файлы', '<dl class="tk-facts">' + media + '</dl>');

    // Сроки хранения его файлов: пусто — как у всех (вкладка «Сроки хранения»).
    if (d.retention) {
      html += card('Сроки хранения', '<div data-ret-box><div class="tk-dcard__ret">' +
        RET_KINDS.map(([k, name]) => '<label class="tk-dcard__ret-row"><span>' + esc(name) + '</span>' + retSelect(k, d.retention.own[k] ?? null, d.retention.all[k]) + '</label>').join('') +
        '</div><div class="tk-dcard__foot"><button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="ret-user" data-id="' + esc(p.id) + '">Сохранить сроки</button>' +
        '<span class="tk-panel__why">Пока не применяются: файлы хранятся бессрочно.</span></div></div>');
    }

    html += card('Заведения', d.venues.length
      ? '<ul class="tk-list">' + d.venues.map((v) => '<li>' + (v.online ? dot(true) : '') + esc(v.name || 'без названия') +
          ' <span class="tk-panel__why">' + esc(cityTitle(v.city) || v.cityOther || '') + ' · ' + esc(VENUE_TYPE.get(v.type) || v.typeOther || v.type || '') +
          (v.status ? '' : ' · не активно') + '</span></li>').join('') + '</ul>'
      : note('Заведений нет'));
    html += '</div>';

    if (IS_ADMIN) {
      html += '<h2 class="tk-panel__h2">Последние действия</h2>';
      html += d.journal.length
        ? table([{ title: 'Когда' }, { title: 'Что' }, { title: 'Объект' }, { title: 'Адрес' }], d.journal.map((r) =>
            '<tr><td>' + esc(when(r.at)) + '</td>' +
            '<td>' + esc(ACTIONS[r.action] || r.action) + (r.result !== 'ok' ? '<span class="tk-tag tk-tag--bad">' + (r.result === 'denied' ? 'отказано' : 'не вышло') + '</span>' : '') + '</td>' +
            '<td>' + esc(r.targetLabel || r.targetType || '—') + '</td>' +
            '<td><a href="' + href('audit', { ip: r.ip }) + '">' + esc(r.ip || '—') + '</a></td></tr>'))
        : note('Действий не записано');
      html += '<p class="tk-panel__more"><a href="' + href('audit', { actor: p.id }) + '">Весь журнал этого человека →</a></p>';
    }

    return { html, title: p.displayName, sub: 'Профиль' };
  },
};

// ── Жалобы ───────────────────────────────────────────────────────────────────
const REASONS = {
  spam: 'спам', abuse: 'оскорбления', adult: 'контент 18+',
  violence: 'насилие', copyright: 'права на контент', other: 'другое',
};
const TARGETS = { stream: 'эфир', user: 'пользователь', message: 'сообщение чата', recording: 'запись эфира', video: 'видео галереи', photo: 'фото галереи', comment: 'комментарий', meetup: 'отметка в заведении' };

VIEWS.reports = {
  title: 'Жалобы',
  api: '/reports',
  csv: true,
  filters: [
    { name: 'status', options: [
      { value: 'new', title: 'Новые' }, { value: 'resolved', title: 'Разобранные' }, { value: 'rejected', title: 'Отклонённые' },
    ] },
    { name: 'reason', options: [{ value: '', title: 'Любая причина' }].concat(
      Object.entries(REASONS).map(([value, title]) => ({ value, title }))) },
    { name: 'targetType', options: [{ value: '', title: 'Любой объект' }].concat(
      Object.entries(TARGETS).map(([value, title]) => ({ value, title }))) },
  ],
  sub: (d) => 'новых ' + num(d.counts.new || 0) + ', разобрано ' + num(d.counts.resolved || 0) +
              ', отклонено ' + num(d.counts.rejected || 0),
  render2(d, params) {
    if (!d.items.length) return note(params.status === 'new' ? 'Новых жалоб нет' : 'Здесь пусто');

    return '<div class="tk-cards">' + d.items.map((r) => {
      const t = r.target;
      const open = r.status === 'new';
      const authorId = r.targetType === 'user' ? r.targetId : (t && t.ownerId) || '';

      let target = esc(TARGETS[r.targetType] || r.targetType) + ' ';
      if (!t) target += '<span class="tk-panel__gone">удалён или уже недоступен</span>';
      else {
        target += '<b>' + esc((t.title || 'без названия').slice(0, 200)) + '</b>';
        if (r.targetType === 'stream') {
          target += t.stopped ? '<span class="tk-tag tk-tag--bad">погашен</span>'
                  : t.isActive ? '<span class="tk-tag tk-tag--on">в эфире</span>' : '<span class="tk-tag">не в эфире</span>';
        }
        if (t.banned) target += '<span class="tk-tag tk-tag--bad">уже ограничен</span>';
      }

      let acts = '';
      if (open) {
        if (r.targetType === 'recording' && t) {
          acts += '<a class="tk-btn tk-btn--outline tk-btn--xs" href="/recording/' + esc(r.targetId) + '" target="_blank" rel="noopener">Открыть</a>' +
                  '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="recording-delete" data-id="' + esc(r.targetId) + '">Удалить запись</button>';
        }
        if (r.targetType === 'video' && t) {
          acts += '<a class="tk-btn tk-btn--outline tk-btn--xs" href="/video/' + esc(r.targetId) + '" target="_blank" rel="noopener">Открыть</a>' +
                  '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="video-delete" data-id="' + esc(r.targetId) + '">Удалить видео</button>';
        }
        if (r.targetType === 'photo' && t) {
          acts += '<a class="tk-btn tk-btn--outline tk-btn--xs" href="/photo/' + esc(r.targetId) + '" target="_blank" rel="noopener">Открыть</a>' +
                  '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="photo-delete" data-id="' + esc(r.targetId) + '">Удалить фото</button>';
        }
        if (r.targetType === 'comment' && t) {
          acts += '<a class="tk-btn tk-btn--outline tk-btn--xs" href="' + esc(t.href) + '#c-' + esc(r.targetId) + '" target="_blank" rel="noopener">Открыть</a>' +
                  '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="comment-delete" data-id="' + esc(r.targetId) + '" data-href="' + esc(t.href) + '">Удалить комментарий</button>';
        }
        if (r.targetType === 'meetup' && t) {
          acts += '<a class="tk-btn tk-btn--outline tk-btn--xs" href="' + esc(t.href) + '" target="_blank" rel="noopener">Открыть</a>' +
                  '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="meetup-delete" data-id="' + esc(r.targetId) + '">Удалить отметку</button>';
        }
        if (r.targetType === 'stream' && t && t.isActive) {
          acts += '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="stop-stream" data-id="' + esc(r.targetId) + '">Остановить эфир</button>';
        }
        if (authorId && !(t && t.banned)) {
          acts += '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="ban" data-id="' + esc(authorId) + '">Ограничить автора</button>';
        }
        acts += '<button type="button" class="tk-btn tk-btn--primary tk-btn--xs" data-act="close-report" data-id="' + esc(r.id) + '" data-status="resolved">Разобрано</button>' +
                '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="close-report" data-id="' + esc(r.id) + '" data-status="rejected">Отклонить</button>';
      }

      return '<article class="tk-card" data-card="' + esc(r.id) + '">' +
        '<div class="tk-card__head"><p class="tk-card__name">' + esc(REASONS[r.reason] || r.reason) + '</p>' +
          '<span class="tk-card__when">' + esc(when(r.createdAt)) +
          (r.onTarget > 1 ? '<span class="tk-tag tk-tag--bad">жалоб на объект: ' + r.onTarget + '</span>' : '') + '</span></div>' +
        '<p class="tk-card__line">' + target + '</p>' +
        (r.comment ? '<p class="tk-card__quote">' + esc(r.comment) + '</p>' : '') +
        '<p class="tk-card__from">пожаловался ' + person(r.reporter) + '</p>' +
        (r.action ? '<p class="tk-card__from">решение: ' + esc(r.action) + '</p>' : '') +
        (r.resolvedBy ? '<p class="tk-card__from">разобрал ' + person(r.resolvedBy) + ' ' + esc(when(r.resolvedAt)) + '</p>' : '') +
        (open ? '<div class="tk-card__acts"><input type="text" class="tk-field" data-reason placeholder="Причина или что сделано" maxlength="300">' + acts + '</div>' : '') +
      '</article>';
    }).join('') + '</div>';
  },
};

// ── Заведения ────────────────────────────────────────────────────────────────
// Тип, страна и город — пункт справочника или своё текстом (utils/places.js,
// 30.09): поле своего под списком, оно в ходу, когда в списке «Своё».
const OTHER = '__other';
const VENUE_FIELDS = [
  { key: 'name', label: 'Название', wide: true },
  { key: 'type', label: 'Тип', list: VENUE_TYPE, own: true },
  { key: 'country', label: 'Страна', list: COUNTRY, own: true },
  { key: 'city', label: 'Город', list: VENUE_CITY, own: true },
  { key: 'address', label: 'Адрес', wide: true },
  { key: 'email', label: 'Почта', type: 'email' },
  { key: 'phone', label: 'Телефон', type: 'tel' },
  { key: 'lat', label: 'Широта' },
  { key: 'lng', label: 'Долгота' },
];

// Правка владельца одобренного заведения ждёт решения (29.09): что
// меняется — было и стало, новые фото картинками. Поля ниже — одобренное.
const DRAFT_LABELS = { name: 'Название', type: 'Тип', country: 'Страна', city: 'Город', address: 'Адрес', about: 'Описание',
  typeOther: 'Тип (своё)', countryOther: 'Страна (своё)', cityOther: 'Город (своё)',
  weekdayHours: 'Часы по будням', weekendHours: 'Часы по выходным', location: 'Точка', photos: 'Фото' };
const draftValue = (k, x) => {
  if (x == null || x === '') return '—';
  if (k === 'weekdayHours' || k === 'weekendHours') return (x.open || '?') + '–' + (x.close || '?');
  if (k === 'location') return x.lat != null ? Number(x.lat).toFixed(5) + ', ' + Number(x.lng).toFixed(5) : '—';
  if (k === 'type') return VENUE_TYPE.get(x) || x;
  if (k === 'country') return COUNTRY.get(x) || x;
  if (k === 'city') return VENUE_CITY.get(x) || x;
  return String(x);
};

function venueDraft(v) {
  if (!v.pending) return '';
  const rows = Object.entries(v.pending.changes).map(([k, c]) => {
    if (k === 'photos') {
      return '<li><b>Фото:</b> было ' + c.was + ', станет ' + c.now +
        (c.added.length ? '<span class="tk-draft__pics">' + c.added.map((u) => '<a href="' + esc(u) + '" target="_blank" rel="noopener"><img src="' + esc(u) + '" alt=""></a>').join('') + '</span>' : '') + '</li>';
    }
    return '<li><b>' + esc(DRAFT_LABELS[k] || k) + ':</b> <s>' + esc(draftValue(k, c.was)) + '</s> → ' + esc(draftValue(k, c.now)) + '</li>';
  }).join('');
  return '<div class="tk-draft"><p class="tk-draft__head">Правка владельца · ' + esc(when(v.pending.at)) + '</p>' +
    (rows ? '<ul class="tk-draft__list">' + rows + '</ul>' : '<p class="tk-panel__why">Без изменений по сути</p>') +
    '<div class="tk-card__acts">' +
      '<button type="button" class="tk-btn tk-btn--ok tk-btn--xs" data-act="venue-draft" data-id="' + esc(v.id) + '" data-accept="1">Принять правку</button>' +
      '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="venue-draft" data-id="' + esc(v.id) + '">Отклонить</button>' +
    '</div></div>';
}

// Своё владельца — тип, страна, город, которых нет в справочнике (30.09).
// Взять в общий список: имя по-русски и по-английски, то же своё у других
// заведений станет этим пунктом разом (routes/admin/venues.js). Город — после
// страны: без неё его не к чему привязать.
const OWN_KINDS = [['type', 'Тип'], ['country', 'Страна'], ['city', 'Город']];
function venueOwn(v) {
  const rows = OWN_KINDS.filter(([k]) => !v[k] && v[k + 'Other']).map(([k, title]) => {
    const blocked = k === 'city' && !COUNTRY.has(v.country);
    return '<div class="tk-own" data-own="' + k + '">' +
      '<p class="tk-own__what"><b>' + esc(title) + ':</b> «' + esc(v[k + 'Other']) + '» — вписано владельцем, в списке нет</p>' +
      (blocked ? '<p class="tk-panel__why">Сначала добавьте в список страну — город привязывается к ней.</p>'
        : '<div class="tk-own__line">' +
          '<input type="text" class="tk-field" data-own-ru value="' + esc(v[k + 'Other']) + '" placeholder="По-русски" maxlength="60">' +
          '<input type="text" class="tk-field" data-own-en value="' + esc(v[k + 'Other']) + '" placeholder="По-английски" maxlength="60">' +
          '<button type="button" class="tk-btn tk-btn--ok tk-btn--xs" data-act="venue-place" data-id="' + esc(v.id) + '" data-kind="' + k + '">Добавить в общий список</button>' +
        '</div>') +
    '</div>';
  }).join('');
  return rows ? '<div class="tk-owns">' + rows + '</div>' : '';
}

VIEWS.venues = {
  title: 'Заведения',
  admin: true,
  api: '/venues',
  csv: true,
  filters: [
    { name: 'q', type: 'search', placeholder: 'Название или адрес' },
    { name: 'status', options: [{ value: '', title: 'Все' }, { value: 'active', title: 'Активные' }, { value: 'inactive', title: 'Неактивные' }, { value: 'pending', title: 'Правки на проверке' }] },
    { name: 'country', options: () => [{ value: '', title: 'Любая страна' }].concat((CATALOG.countries || []).map((c) => ({ value: c.code, title: c.name }))) },
    { name: 'city', options: () => [{ value: '', title: 'Любой город' }].concat([...VENUE_CITY].map(([code, title]) => ({ value: code, title }))) },
    { name: 'type', options: () => [{ value: '', title: 'Любой тип' }].concat((CATALOG.types || []).map((t) => ({ value: t.code, title: t.name }))) },
    { name: 'online', options: [{ value: '', title: 'Камера: всё равно' }, { value: '1', title: 'Камера включена' }] },
  ],
  sub: (d) => num(d.total) + ' заведений',
  render2(d) {
    if (!d.items.length) return note('Заведений нет');

    return '<div class="tk-cards tk-cards--wide">' + d.items.map((v) => {
      const value = (key) => key === 'lat' || key === 'lng'
        ? (v.location ? v.location[key] : '') : (v[key] == null ? '' : v[key]);

      const fields = VENUE_FIELDS.map((f) => {
        const val = String(value(f.key) == null ? '' : value(f.key));
        let control;
        if (f.own) {
          // Пункт справочника или своё: в списке «Своё», текст — в поле под ним.
          const mine = v[f.key + 'Other'] || '';
          const known = f.list.has(val);
          control = '<select class="tk-field tk-select" data-field="' + f.key + '">' +
            '<option value=""' + (known || mine ? '' : ' selected') + '>Не выбран</option>' +
            '<option value="' + OTHER + '"' + (!known && mine ? ' selected' : '') + '>Своё — ниже</option>' +
            [...f.list.entries()].map(([code, title]) => '<option value="' + esc(code) + '"' +
              (code === val ? ' selected' : '') + '>' + esc(title) + '</option>').join('') + '</select>' +
            '<input type="text" class="tk-field" data-field="' + f.key + 'Other" value="' + esc(mine) + '" placeholder="своё, если нет в списке" maxlength="60">';
        } else if (f.list) {
          // Заведения, заполненные до закрытых списков, держат город строкой
          // и не держат типа вовсе: чужое значение показываем первой строкой,
          // чтобы его было видно и можно было заменить, а не потерять молча.
          const known = f.list.has(val);
          control = '<select class="tk-field tk-select" data-field="' + f.key + '">' +
            '<option value=""' + (known ? '' : ' selected') + '>' + (known || !val ? 'Не выбран' : esc(val) + ' — не из списка') + '</option>' +
            [...f.list.entries()].map(([code, title]) => '<option value="' + esc(code) + '"' +
              (code === val ? ' selected' : '') + '>' + esc(title) + '</option>').join('') + '</select>';
        } else {
          control = '<input type="' + (f.type || 'text') + '" class="tk-field" data-field="' + f.key + '" value="' + esc(val) + '">';
        }
        return '<label class="tk-field-row' + (f.wide ? ' tk-field-row--wide' : '') + '">' +
               '<span class="tk-field-row__label">' + esc(f.label) + '</span>' + control + '</label>';
      }).join('');

      return '<article class="tk-card" data-card="' + esc(v.id) + '">' +
        '<div class="tk-card__head">' +
          '<p class="tk-card__name">' + esc(v.name || 'без названия') +
            (v.online ? '<span class="tk-tag tk-tag--on">камера</span>' : '') + '</p>' +
          '<label class="tk-switch"><input type="checkbox" data-act="venue-status" data-id="' + esc(v.id) + '"' +
            (v.status ? ' checked' : '') + '><span>активно</span></label>' +
        '</div>' +
        '<p class="tk-card__from">' + person(v.owner) + ' · оценка ' +
          (v.rating.count ? v.rating.avg + ' (' + v.rating.count + ')' : 'нет') + ' · фото ' + v.photos + '</p>' +
        venueDraft(v) +
        venueOwn(v) +
        '<div class="tk-fields">' + fields + '</div>' +
        '<div class="tk-card__acts">' +
          // Заперта, пока ничего не правили: иначе «Сохранить» нажимают
          // по привычке и шлют на сервер карточку без изменений.
          '<button type="button" class="tk-btn tk-btn--primary tk-btn--xs" data-act="venue-save" data-id="' + esc(v.id) + '" disabled>Сохранить</button>' +
          '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="venue-delete" data-id="' + esc(v.id) + '">Удалить</button>' +
          '<a class="tk-btn tk-btn--outline tk-btn--xs" href="' + href('camera', { id: v.id }) + '">Камера: хронология</a>' +
        '</div></article>';
    }).join('') + '</div>';
  },
};

// ── Записи ───────────────────────────────────────────────────────────────────
VIEWS.recordings = {
  title: 'Записи',
  api: '/recordings',
  csv: true,
  filters: [
    { name: 'q', type: 'search', placeholder: 'Название' },
    { name: 'status', options: [
      { value: '', title: 'Любое состояние' }, { value: 'ready', title: 'Готовы' },
      { value: 'processing', title: 'Склеиваются' }, { value: 'failed', title: 'Не вышли' },
    ] },
    { name: 'adult', options: [{ value: '', title: 'Все' }, { value: '1', title: 'Только 18+' }] },
    { name: 'period', options: PERIOD },
  ],
  sub: (d) => num(d.total) + ' записей, ' + bytes(d.totals.bytes) + ', ' + dur(d.totals.seconds),
  head: [
    { title: 'Запись' }, { title: 'Кто' }, { title: 'Состояние' }, { title: 'Длительность', cls: 'tk-num' },
    { title: 'Размер', cls: 'tk-num' }, { title: 'Записан' }, { title: '' },
  ],
  row: (r) => '<tr>' +
    '<td>' + (r.status === 'ready'
      ? '<a href="/recording/' + esc(r.id) + '" target="_blank" rel="noopener">' + esc(r.title || 'без названия') + '</a>'
      : esc(r.title || 'без названия')) + (r.isAdult ? '<span class="tk-tag tk-tag--bad">18+</span>' : '') + '</td>' +
    '<td>' + person(r.owner) + '</td>' +
    '<td>' + esc({ ready: 'готова', processing: 'склеивается', failed: 'не вышла' }[r.status] || r.status) + '</td>' +
    '<td class="tk-num">' + esc(dur(r.duration)) + '</td>' +
    '<td class="tk-num">' + esc(bytes(r.size)) + '</td>' +
    '<td>' + esc(when(r.recordedAt || r.createdAt)) + '</td>' +
    '<td class="tk-acts"><button type="button" class="tk-btn tk-btn--danger tk-btn--xs" data-act="recording-delete" data-id="' + esc(r.id) + '">Удалить</button></td>' +
  '</tr>',
};

// ── Журнал ───────────────────────────────────────────────────────────────────
//
// Группы действий — по началу кода: auth.*, stream.*, mod.*. Так фильтр
// остаётся коротким, когда самих действий уже полсотни.
const GROUPS = [
  { value: '', title: 'Все действия' },
  { value: 'auth', title: 'Вход и пароли' },
  { value: 'stream', title: 'Эфиры' },
  { value: 'recording', title: 'Записи' },
  { value: 'video', title: 'Видео галереи' },
  { value: 'venue', title: 'Заведения' },
  { value: 'mod', title: 'Модерация' },
  { value: 'report', title: 'Жалобы' },
  { value: 'profile', title: 'Профили' },
  { value: 'admin', title: 'Панель' },
];

VIEWS.audit = {
  title: 'Журнал',
  admin: true,
  api: '/audit',
  filters: [
    { name: 'q', type: 'search', placeholder: 'Кто или что' },
    { name: 'group', options: GROUPS },
    { name: 'action', options: () => [{ value: '', title: 'Любое действие' }].concat(
      Object.entries(ACTIONS).map(([value, title]) => ({ value, title }))) },
    { name: 'result', options: [
      { value: '', title: 'Любой итог' }, { value: 'ok', title: 'Получилось' },
      { value: 'fail', title: 'Не получилось' }, { value: 'denied', title: 'Отказано' },
    ] },
    { name: 'period', options: PERIOD },
  ],
  csv: true,
  sub: (d) => (d.total >= 10000 ? 'больше 10 000' : num(d.total)) + ' записей',
  // Очищает то, что отобрано фильтрами, — без отбора весь журнал.
  tools: () => '<button type="button" class="tk-btn tk-btn--danger tk-btn--xs" data-act="audit-clear">Очистить</button>',
  head: [{ title: 'Когда' }, { title: 'Кто' }, { title: 'Действие' }, { title: 'Объект' }, { title: 'Адрес' }, { title: 'Подробности' }],
  row: (r) => '<tr>' +
    '<td class="tk-nowrap">' + esc(when(r.at)) + '</td>' +
    '<td>' + (r.actorNow ? person(r.actorNow) : '<span class="tk-panel__gone">' + esc(r.actorLogin || 'без входа') + '</span>') + '</td>' +
    '<td>' + esc(r.label) +
      (r.result !== 'ok' ? '<span class="tk-tag tk-tag--bad">' + esc(r.result === 'denied' ? 'отказано' : 'не вышло') + '</span>' : '') + '</td>' +
    '<td>' + esc(r.targetLabel || r.targetType || '—') + '</td>' +
    '<td class="tk-nowrap">' + (r.ip ? '<a href="' + href('audit', { ip: r.ip }) + '">' + esc(r.ip) + '</a>' : '—') + '</td>' +
    // Подпись — в span: у ячейки таблицы свой display, и block с .tk-panel__why
    // сбивал линию под строкой.
    '<td><span class="tk-panel__why">' + meta(r.meta) + '</span></td>' +
  '</tr>',
};

// ── Ошибки ───────────────────────────────────────────────────────────────────
// check — не ошибки, а отчёты проверок связи и звука (routes/clientErrors.js).
// В «Все ошибки» их намеренно нет, видны только по выбору «проверки»:
// их шлёт исправная страница. В подписи со счётчиками они есть — иначе
// о них негде было бы вспомнить.
const SCOPES = { server: 'сервер', client: 'браузер', media: 'медиа', external: 'внешние', check: 'проверки' };

// Раскрывашка карточки ошибки: стек, подробности, браузер. У отчёта о
// звонке (CallDiag) стека нет — его суть в lastMeta.details, построчно.
function errorMore(e) {
  const meta = Object.assign({}, e.lastMeta);
  const lines = Array.isArray(meta.details) ? meta.details : [];
  delete meta.details;
  Object.keys(meta).forEach((k) => { if (!meta[k]) delete meta[k]; });
  return [e.stack, lines.join('\n'), Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '', e.lastUa]
    .filter(Boolean).join('\n\n');
}

VIEWS.errors = {
  title: 'Ошибки',
  admin: true,
  api: '/errors',
  csv: true,
  filters: [
    { name: 'q', type: 'search', placeholder: 'Текст или маршрут' },
    { name: 'scope', options: [{ value: '', title: 'Все ошибки' }].concat(
      Object.entries(SCOPES).map(([value, title]) => ({ value, title }))) },
    { name: 'resolved', options: [
      { value: '', title: 'Неразобранные' }, { value: '1', title: 'Разобранные' }, { value: 'all', title: 'Все' },
    ] },
    { name: 'period', options: PERIOD },
  ],
  sub: (d) => Object.entries(d.byScope).map(([k, v]) => (SCOPES[k] || k) + ': ' + v.groups).join(' · ') || 'ошибок нет',
  render2(d, params) {
    if (!d.items.length) return note('Ошибок нет — или все разобраны');

    // Полоса разбора пачкой (errorBulk ниже): галочки на карточках, «все
    // на странице», а когда их больше страницы — «все N по отбору».
    const done = params.resolved === '1';
    bulkAll = false;
    const bulk =
      '<div class="tk-bulk" data-bulk data-total="' + d.total + '" data-shown="' + d.items.length + '">' +
        '<label class="tk-switch"><input type="checkbox" data-pick-all> Выбрать все на странице</label>' +
        '<span class="tk-bulk__count" data-bulk-count>ничего не выбрано</span>' +
        (d.total > d.items.length ? '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-bulk-all hidden>Все ' + num(d.total) + ' по отбору</button>' : '') +
        '<span class="tk-bulk__acts">' +
          (params.resolved !== 'all'
            ? '<button type="button" class="tk-btn tk-btn--' + (done ? 'outline' : 'ok') + ' tk-btn--xs" data-bulk-act="' + (done ? 'reopen' : 'resolve') + '" disabled>' +
                (done ? 'Вернуть в работу' : 'Разобрано') + '</button>'
            : '') +
          '<button type="button" class="tk-btn tk-btn--danger tk-btn--xs" data-bulk-act="delete" disabled>Удалить</button>' +
        '</span>' +
      '</div>';

    return bulk + '<div class="tk-cards tk-cards--wide">' + d.items.map((e) => { const more = errorMore(e); return (
      '<article class="tk-card tk-card--error' + (e.resolved ? ' is-done' : '') + '" data-card="' + esc(e.id) + '">' +
        '<div class="tk-card__head">' +
          '<label class="tk-card__pick" title="Выбрать"><input type="checkbox" data-pick value="' + esc(e.id) + '"></label>' +
          '<p class="tk-card__name"><span class="tk-tag">' + esc(SCOPES[e.scope] || e.scope) + '</span> ' +
            esc(e.name) + (e.status ? ' · ' + e.status : '') + '</p>' +
          '<span class="tk-card__when">' + esc(ago(e.lastAt)) +
            '<span class="tk-tag' + (e.count > 10 ? ' tk-tag--bad' : '') + '">' + num(e.count) + ' раз</span></span>' +
        '</div>' +
        '<p class="tk-card__line"><code>' + esc(e.message) + '</code></p>' +
        '<p class="tk-card__from">' + esc(e.route || 'без маршрута') + ' · впервые ' + esc(when(e.firstAt)) +
          (e.lastUser ? ' · последний раз у ' + person(e.lastUser) : '') +
          (e.lastIp ? ' · ' + esc(e.lastIp) : '') + '</p>' +
        (more ? '<details class="tk-card__more"><summary>Стек и подробности</summary><pre>' + esc(more) + '</pre></details>' : '') +
        '<div class="tk-card__acts">' +
          '<button type="button" class="tk-btn tk-btn--' + (e.resolved ? 'outline' : 'ok') + ' tk-btn--xs" ' +
            'data-act="error-resolve" data-id="' + esc(e.id) + '" data-resolved="' + (e.resolved ? '0' : '1') + '">' +
            (e.resolved ? 'Вернуть в работу' : 'Разобрано') + '</button>' +
          '<span class="tk-panel__why">отпечаток ' + esc(e.fingerprint) + '</span>' +
        '</div>' +
      '</article>'); }).join('') + '</div>';
  },
};

// Разбор ошибок пачкой. Выбор живёт в самих галочках: перерисовка списка
// после действия его и сбрасывает, отдельного состояния держать незачем.
// Щелчок по пустому месту карточки — та же галочка: по двадцать карточек
// кликать в квадратик размером с букву долго.
// «Все по отбору» — не галочки, а флаг: он включается кнопкой и гаснет,
// стоит снять хоть одну галочку.
let bulkAll = false;

function bulkSync() {
  const bar = view.querySelector('[data-bulk]');
  if (!bar) return;
  const picks = [...view.querySelectorAll('[data-pick]')];
  const on = picks.filter((x) => x.checked);
  if (on.length < picks.length) bulkAll = false;
  picks.forEach((x) => x.closest('.tk-card').classList.toggle('is-picked', x.checked));
  bar.querySelector('[data-pick-all]').checked = picks.length > 0 && on.length === picks.length;
  const all = bar.querySelector('[data-bulk-all]');
  if (all) all.hidden = bulkAll || on.length !== picks.length;
  const n = bulkAll ? Number(bar.dataset.total) : on.length;
  bar.querySelector('[data-bulk-count]').textContent = n
    ? 'выбрано: ' + num(n) + (bulkAll ? ' — все по отбору' : '') : 'ничего не выбрано';
  bar.querySelectorAll('[data-bulk-act]').forEach((b) => { b.disabled = !n; });
}

view.addEventListener('change', (e) => {
  if (e.target.matches('[data-pick-all]')) {
    view.querySelectorAll('[data-pick]').forEach((x) => { x.checked = e.target.checked; });
  }
  if (e.target.matches('[data-pick], [data-pick-all]')) bulkSync();
});

view.addEventListener('click', async (e) => {
  const card = e.target.closest('.tk-card--error');
  if (card && !e.target.closest('a, button, input, label, summary, pre') && !String(getSelection())) {
    const box = card.querySelector('[data-pick]');
    box.checked = !box.checked;
    return bulkSync();
  }
  if (e.target.closest('[data-bulk-all]')) { bulkAll = true; return bulkSync(); }

  const btn = e.target.closest('[data-bulk-act]');
  if (!btn) return;
  const action = btn.dataset.bulkAct;
  const ids = [...view.querySelectorAll('[data-pick]:checked')].map((x) => x.value);
  const n = bulkAll ? Number(view.querySelector('[data-bulk]').dataset.total) : ids.length;
  if (action === 'delete' && !await confirmDialog('Удалить из журнала карточек: ' + num(n) +
    '? Если ошибка повторится, карточка появится заново.', { okText: 'Удалить' })) return;
  try {
    const query = bulkAll ? '?' + new URLSearchParams(serverParams(route().params)).toString() : '';
    const r = await send('POST', '/api/admin/errors/bulk' + query, bulkAll ? { action, all: true } : { action, ids });
    toast((action === 'delete' ? 'Удалено: ' : action === 'resolve' ? 'Разобрано: ' : 'Вернули в работу: ') + num(r.rows), 'ok');
    bulkAll = false;
    show();
  } catch (err) {
    toast(err.message || 'Не получилось', 'error');
  }
});

// ── Попытки (телеметрия) ─────────────────────────────────────────────────────
// Одна строка — одна попытка человека: посмотреть эфир, выйти в эфир…
// (docs/TELEMETRY.md, models/Trace.js). Только администратору: адреса.
const KIND_TITLE = {
  'live.view': 'эфир · зритель', 'live.host': 'эфир · ведущий', 'venue.view': 'камера · зритель',
  'venue.host': 'камера · заведение', call: 'звонок', upload: 'загрузка', 'chat.media': 'медиа в переписке', notice: 'сбой связи',
};
// Попытка ведёт на карточку того, к чему относится: звонка, камеры.
const KIND_LINK = {
  call: (id) => href('call', { id }),
  'venue.view': (id) => href('camera', { id }),
  'venue.host': (id) => href('camera', { id }),
};
const OUTCOME_TITLE = { open: 'идёт', ok: 'вышло', fail: 'ошибка', gave_up: 'не дождался', partial: 'оборвалось' };
const REASON_TITLE = {
  no_manifest: 'плейлист не пришёл', no_frame: 'плейлист есть, картинки нет', fallback_busy: 'запасной путь переполнен',
  error: 'ошибка', no_camera: 'нет камеры',
  camera_denied: 'камера запрещена', no_publish: 'видео не дошло до сервера ни разу',
  host_lost: 'ведущий выпал из Daily, пока запускали выход',
  lost: 'связь пропала и не вернулась', not_connected: 'не соединились', no_peer: 'собеседник так и не вошёл',
  canceled: 'отменили', too_big: 'слишком большой', novideo: 'не видео', long: 'слишком длинное', encode: 'пережатие', store: 'хранилище',
  processing: 'не обработалось на сервере', processing_timeout: 'обработка дольше 5 минут', stalled: 'отправка встала',
  network: 'не открылось (сеть)', decode: 'не открылось (файл)', unsupported: 'запись не поддерживается', recorder: 'сбой записи',
  empty: 'пустая запись', mic_denied: 'микрофон запрещён', cam_denied: 'камера запрещена', no_mic: 'нет микрофона', no_cam: 'нет камеры',
  timeout: 'время вышло', offline: 'нет интернета', no_server: 'нет связи с сервером', server: 'ошибка сервера', busy: 'сервер занят',
};
const STEP_TITLE = {
  manifest: 'плейлист', frame: 'кадр', camera: 'камера', joined: 'вошёл в Daily', live: 'в эфире', slow: 'Daily грузится',
  fallback: 'запасной путь', busy: 'запасной путь занят', reset: 'перезапуск плеера', reconnect: 'переподключение',
  net_good: 'сеть хорошая', net_low: 'сеть слабая', net_bad: 'сеть плохая', out_drop: 'выход оборвался', out_lost: 'выход потерян',
  watch: 'адрес получен', publish: 'публикация', pub_fail: 'публикация не дошла', vp8_fallback: 'H.264 не пошёл — перешли на VP8', notice_slow: 'сказали «ждём»',
  notice_no_route: 'сказали «видео не доходит»',
  peer: 'собеседник в разговоре', stuck: 'Daily застрял', switch_own: 'перешли на свой путь', media_denied: 'камера/микрофон запрещены',
  notice_silent: 'сказали «не слышно собеседника»',
  draft: 'черновик заведён', first_chunk: 'первый кусок дошёл', uploaded: 'файл доехал', retry: 'повтор',
  offline: 'ждали сеть', resumed: 'продолжено на другой странице', sent: 'файл ушёл', processing: 'обрабатывается на сервере',
};
const STAT_TITLE = {
  stalls: 'подвисаний', stallMs: 'стоял, мс', resets: 'перезапусков', player: 'плеер', height: 'качество', lastErr: 'ошибка',
  reconnects: 'переподключений', media: 'камера/микрофон',
  pubs: 'публикаций', fails: 'не дошло', ice: 'путь ICE',
  what: 'что', kb: 'КБ', type: 'тип', files: 'файлов', pages: 'страниц', bytes: 'байт дошло', sendMs: 'отправка, мс',
  kbps: 'кбит/с', retries: 'повторов', ms: 'всего, мс', dir: 'куда', group: 'в группе', retry: 'повтор №', tries: 'попыток открыть',
  video: 'с видео', role: 'сторона', size: 'участников', stuck: 'почему ушли с Daily', heard: 'звук через 10 с', heardEnd: 'звук в конце',
  relay: 'реле TURN дано', turnErr: 'отказы TURN',
};
const sec = (ms) => (ms / 1000).toFixed(1).replace('.', ',') + ' с';

function outcomeTag(t) {
  const bad = ['fail', 'gave_up', 'partial'].includes(t.outcome);
  return '<span class="tk-tag' + (bad ? ' tk-tag--bad' : t.outcome === 'ok' ? ' tk-tag--on' : '') + '">' + esc(OUTCOME_TITLE[t.outcome] || t.outcome) + '</span>' +
    (t.reason ? '<span class="tk-panel__why">' + esc(REASON_TITLE[t.reason] || t.reason) + '</span>' : '');
}

function stepsText(steps) {
  return (steps || []).map((x) => esc(STEP_TITLE[x.s] || x.s) + ' ' + sec(x.ms)).join(' · ');
}

function statsText(stats) {
  return Object.entries(stats || {}).filter(([, v]) => v !== '' && v != null && v !== 0)
    .map(([k, v]) => esc(STAT_TITLE[k] || k) + ': ' + esc(k === 'height' ? v + 'p' : String(v))).join(' · ');
}

// Что было с файлом после приёма (utils/uploadTrace.js): очередь,
// пережатие, выгрузка в хранилище, исход.
function serverText(s) {
  return [
    s.outcome === 'ok' ? 'обработано' : 'не обработано' + (s.reason ? ' (' + (REASON_TITLE[s.reason] || s.reason) + ')' : ''),
    s.queueMs != null ? 'очередь ' + sec(s.queueMs) : '',
    s.encodeMs != null ? 'пережатие ' + sec(s.encodeMs) : '',
    s.storeMs != null ? 'в хранилище ' + sec(s.storeMs) : '',
    s.ms != null ? 'всего ' + sec(s.ms) : '',
    s.kb ? s.kb + ' КБ после пережатия' : '',
  ].filter(Boolean).map(esc).join(' · ');
}

// Сеть: страна · провайдер, часовой пояс, «VPN?» — догадка (utils/netInfo.js).
function netText(t) {
  const n = t.net || {};
  return esc([n.country, n.org].filter(Boolean).join(' · ') || '—') +
    (n.vpn ? '<span class="tk-tag tk-tag--bad" title="адрес хостинга или пояс браузера не совпадает со страной">VPN?</span>' : '') +
    (n.tz ? '<span class="tk-panel__why">' + esc(n.tz + (n.type ? ' · ' + n.type : '')) + '</span>' : '');
}

function traceRow(t, withKind) {
  return '<tr>' +
    '<td class="tk-nowrap">' + esc(when(t.at)) + '</td>' +
    (withKind ? '<td>' + (KIND_LINK[t.kind] && t.target
      ? '<a href="' + KIND_LINK[t.kind](t.target) + '">' + esc(KIND_TITLE[t.kind]) + '</a>'
      : esc(KIND_TITLE[t.kind] || t.kind)) + '</td>' : '') +
    '<td>' + (t.user ? person(t.user) : '<span class="tk-panel__gone">гость</span>') + '</td>' +
    '<td>' + outcomeTag(t) + '</td>' +
    '<td>' + esc(t.route || '—') + '</td>' +
    '<td><span class="tk-panel__why">' + stepsText(t.steps) + '</span>' +
      (Object.keys(t.stats || {}).length ? '<span class="tk-panel__why">' + statsText(t.stats) + '</span>' : '') +
      (t.server ? '<span class="tk-panel__why">на сервере: ' + serverText(t.server) + '</span>' : '') + '</td>' +
    '<td>' + netText(t) + '</td>' +
    '<td>' + esc(t.device || '—') + (t.standalone ? '<span class="tk-tag">с иконки</span>' : '') + '</td>' +
    '<td class="tk-nowrap">' + (t.ip ? '<a href="' + href('traces', { ip: t.ip }) + '">' + esc(t.ip) + '</a>' : '—') + '</td>' +
  '</tr>';
}

const TRACE_HEAD = (withKind) => [{ title: 'Когда' }].concat(withKind ? [{ title: 'Что' }] : [],
  [{ title: 'Кто' }, { title: 'Исход' }, { title: 'Путь' }, { title: 'Этапы и числа' }, { title: 'Сеть' }, { title: 'Устройство' }, { title: 'Адрес' }]);

const DBIP = '<p class="tk-panel__why">Страна и провайдер: <a href="https://db-ip.com" target="_blank" rel="noopener">IP Geolocation by DB-IP</a></p>';

VIEWS.traces = {
  title: 'Попытки',
  admin: true,
  api: '/traces',
  csv: true,
  // Очищает то, что отобрано фильтрами, — без отбора все попытки.
  tools: () => '<button type="button" class="tk-btn tk-btn--danger tk-btn--xs" data-act="traces-clear">Очистить</button>',
  filters: [
    { name: 'kind', options: [{ value: '', title: 'Все направления' }].concat(Object.entries(KIND_TITLE).map(([value, title]) => ({ value, title }))) },
    { name: 'outcome', options: [{ value: '', title: 'Любой исход' }, { value: 'bad', title: 'Не вышло' }].concat(
      Object.entries(OUTCOME_TITLE).map(([value, title]) => ({ value, title }))) },
    { name: 'route', options: [{ value: '', title: 'Любой путь' }, { value: 'cdn', title: 'CDN' }, { value: 'fallback', title: 'Запасной' }, { value: 'daily', title: 'Daily' }, { value: 'own', title: 'Свой' }] },
    { name: 'vpn', options: [{ value: '', title: 'VPN: всё равно' }, { value: '1', title: 'Похоже на VPN' }] },
    { name: 'period', options: PERIOD },
  ],
  sub: (d) => 'попыток: ' + num(d.total) + (d.total >= 10000 ? '+' : ''),
  render2(d) {
    return table(TRACE_HEAD(true), d.items.map((t) => traceRow(t, true))) + DBIP;
  },
};

// ── Карточка эфира ───────────────────────────────────────────────────────────
// Хронология конвейера, ведущий (с выжимкой журнала Daily по кнопке)
// и зрители строками — routes/admin/traces.js.
const EVENT_TITLE = {
  'daily.out.start': 'выход Daily запущен', 'daily.out.drop': 'выход Daily оборвался', 'daily.out.retry': 'перезапуск выхода',
  'daily.out.back': 'выход вернулся', 'daily.out.lost': 'выход не вернулся', 'rtmp.in': 'поток пришёл', 'rtmp.out': 'поток ушёл',
  'hls.start': 'конвейер запущен', 'hls.ready': 'первый плейлист', 'hls.late': 'плейлиста нет минуту', 'hls.exit': 'ffmpeg вышел',
  'hls.stop': 'конвейер остановлен', 'host.away': 'ведущий свернул', 'host.back': 'ведущий вернулся',
  'rtmp.info': 'параметры потока', 'rtmp.low': 'вещатель шлёт мало данных', 'rtmp.ok': 'поток выровнялся',
  'hls.giveup': 'ffmpeg сдался после 5 перезапусков',
  // Камера заведения (utils/venueLog.js).
  'cam.on': 'камеру включили', 'cam.off': 'камеру выключили', 'owner.left': 'страница владельца отключилась',
  'owner.back': 'владелец вернулся за минуту', 'mtx.ready': 'публикация пришла в MediaMTX', 'mtx.gone': 'публикация кончилась', 'mtx.novideo': 'пришёл один звук — владельцу VP8',
};
const ENDED_BY = { owner: 'кнопкой', moderation: 'модерация', lapsed: 'владелец пропал', absent: 'владельца нет на странице', restart: 'сменён новым' };
const eventTitle = (e) => (e.e === 'cam.demand' ? (e.d && e.d.on ? 'попросили видео у владельца' : 'зрителей нет — видео не просим') : EVENT_TITLE[e.e] || e.e);
const PROFILE_TITLE = { full: '720/480/360', lite: '480p', copy: 'копия', venue: 'камера, пережатие', venueCopy: 'камера, копия' };

// Подробности события — по-русски, без пустого и «нет»: «режим 720/480/360 ·
// знак поверх · режим до обрыва», «без видео 42,0 с · попыток 4».
const EVENT_KEYS = { ms: 'за', downMs: 'без видео', sec: 'шёл', tries: 'попыток', n: 'попытка', attempt: 'с попытки',
  status: 'ответ Daily', msg: '', code: 'код', signal: 'сигнал', restart: 'перезапуск',
  size: 'кадр', codec: '', fps: 'кадров/с', of: 'из', kbps: 'кбит/с', want: 'заявлено', lowSec: 'плохо было', viewers: 'зрителей' };
function eventMeta(e) {
  const d = e.d || {};
  const out = [];
  if (d.profile) out.push('режим ' + (PROFILE_TITLE[d.profile] || d.profile));
  if (d.mark) out.push(d.mark === 'frame' ? 'знак в кадре' : 'знак поверх');
  if (d.kept) out.push('режим до обрыва');
  if (d.daily) out.push('от Daily');
  if (d.ok) out.push('Daily согласился');
  if (d.host != null) out.push(d.host ? 'ведущий в комнате' : d.host === false ? 'ведущего нет в комнате' : 'есть ли ведущий — неизвестно');
  if (d.by) out.push(ENDED_BY[d.by] || d.by);
  if (d.engine === 'daily') out.push('комната Daily');
  Object.entries(d).forEach(([k, v]) => {
    if (!(k in EVENT_KEYS) || v == null || v === '') return;
    const val = k === 'ms' || k === 'downMs' ? sec(v) : k === 'sec' || k === 'lowSec' ? dur(v) : String(v);
    out.push((EVENT_KEYS[k] ? EVENT_KEYS[k] + ' ' : '') + val);
  });
  return esc(out.join(' · '));
}

VIEWS.stream = {
  title: 'Эфир',
  hidden: true,
  admin: true,
  async render(params) {
    if (!params.id) return { html: note('Эфир не выбран') };
    const d = await api('/streams/' + encodeURIComponent(params.id) + '/detail');
    const s = d.session;
    const t0 = new Date(s.startedAt).getTime();
    const rel = (at) => { const x = Math.round((new Date(at).getTime() - t0) / 1000); return (x < 0 ? '−' : '') + dur(Math.abs(x)); };
    const fact = (k, v) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>';

    let html = '<a class="tk-panel__back" href="' + href('streams') + '">← ко всем эфирам</a>';
    html += '<div class="tk-dossier__cols"><section><h2 class="tk-panel__h2">Эфир</h2><dl class="tk-facts">' +
      fact('Ведущий', s.owner ? person(s.owner) : '—') +
      fact('Источник', esc(s.source === 'obs' ? 'OBS' : 'веб')) +
      fact('Начало', esc(when(s.startedAt))) +
      fact('Длительность', esc(s.endedAt ? dur(s.duration) : 'идёт')) +
      fact('Пик зрителей', num(s.peakViewers)) +
      fact('Итог', esc({ owner: 'завершён', moderation: 'погашен', cleanup: 'брошен', restart: 'перезапуск' }[s.endedBy] || '—')) +
      '</dl></section>';

    html += '<section><h2 class="tk-panel__h2">Ведущий</h2>' +
      (d.host.length ? table(TRACE_HEAD(false), d.host.map((t) => traceRow(t, false))) : note('Попыток ведущего нет — эфир до 2 октября или OBS')) +
      (s.room ? '<p><button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="stream-daily" data-id="' + esc(s.id) + '">Журнал Daily</button></p><div data-daily></div>' : '') +
      '</section></div>';

    html += '<h2 class="tk-panel__h2">Хронология</h2>' + (s.events.length
      ? table([{ title: 'От начала' }, { title: 'Что' }, { title: 'Подробности' }], s.events.map((e) =>
          '<tr><td class="tk-nowrap tk-num">' + esc(rel(e.at)) + '</td><td>' + esc(eventTitle(e)) + '</td>' +
          '<td><span class="tk-panel__why">' + eventMeta(e) + '</span></td></tr>'))
      : note('Хронологии нет — эфир до 2 октября'));

    const v = d.viewers;
    const count = (o) => v.filter((t) => t.outcome === o).length;
    html += '<h2 class="tk-panel__h2">Зрители</h2>' +
      (v.length ? '<p class="tk-panel__why">' + esc('просмотров: ' + v.length + ' · вышло: ' + count('ok') + ' · не дождались: ' + count('gave_up') +
        ' · оборвалось: ' + count('partial') + ' · запасной путь: ' + v.filter((t) => t.route === 'fallback').length) + '</p>' : '') +
      (v.length ? table(TRACE_HEAD(false), v.map((t) => traceRow(t, false))) : note('Зрителей с телеметрией нет')) + DBIP;

    return { html, title: s.title || 'Эфир без названия' };
  },
};

// Встреча у Daily: у эфира одна сторона (ведущий), у звонка — по стороне
// на участника (routes/admin/traces.js, dailyMeetings).
// ── Карточка камеры заведения ────────────────────────────────────────────────
// Сеансы камеры от «включить» до «выключить», выбранный — с хронологией
// сервера (utils/venueLog.js), владелец и зрители — попытками в его окне.
VIEWS.camera = {
  title: 'Камера',
  hidden: true,
  admin: true,
  async render(params) {
    if (!params.id) return { html: note('Заведение не выбрано') };
    const d = await api('/venues/' + encodeURIComponent(params.id) + '/camera' + (params.s ? '?s=' + encodeURIComponent(params.s) : ''));
    const v = d.venue;
    const s = d.session;
    const fact = (k, x) => '<dt>' + esc(k) + '</dt><dd>' + x + '</dd>';
    const length = (x) => (x.endedAt ? dur(Math.round((new Date(x.endedAt) - new Date(x.startedAt)) / 1000)) : 'идёт');

    let html = '<a class="tk-panel__back" href="' + href('venues', { q: v.name }) + '">← к заведениям</a>';
    html += '<dl class="tk-facts">' + fact('Владелец', v.owner ? person(v.owner) : '—') +
      fact('Камера сейчас', v.online ? '<span class="tk-tag tk-tag--on">включена</span>' : 'выключена') + '</dl>';
    if (!d.sessions.length) return { html: html + note('Сеансов нет — камеру не включали с 4 октября'), title: v.name || 'Камера' };

    html += '<h2 class="tk-panel__h2">Сеансы</h2>' + table([{ title: 'Начало' }, { title: 'Шёл' }, { title: 'Пик зрителей' }, { title: 'Выключили' }],
      d.sessions.map((x) => '<tr><td class="tk-nowrap">' +
        (s && x.id === s.id ? esc(when(x.startedAt)) : '<a href="' + href('camera', { id: v.id, s: x.id }) + '">' + esc(when(x.startedAt)) + '</a>') + '</td>' +
        '<td class="tk-num">' + esc(length(x)) + '</td><td class="tk-num">' + num(x.peakViewers) + '</td>' +
        '<td>' + esc(x.endedAt ? ENDED_BY[x.endedBy] || x.endedBy || '—' : '—') + '</td></tr>'));

    const t0 = new Date(s.startedAt).getTime();
    const rel = (at) => { const x = Math.round((new Date(at).getTime() - t0) / 1000); return (x < 0 ? '−' : '') + dur(Math.abs(x)); };
    html += '<h2 class="tk-panel__h2">Хронология · ' + esc(when(s.startedAt)) + '</h2>' +
      table([{ title: 'От начала' }, { title: 'Что' }, { title: 'Подробности' }], s.events.map((e) =>
        '<tr><td class="tk-nowrap tk-num">' + esc(rel(e.at)) + '</td><td>' + esc(eventTitle(e)) + '</td>' +
        '<td><span class="tk-panel__why">' + eventMeta(e) + '</span></td></tr>'));
    html += '<h2 class="tk-panel__h2">Владелец</h2>' +
      (d.host.length ? table(TRACE_HEAD(false), d.host.map((t) => traceRow(t, false))) : note('Попыток владельца в этом сеансе нет'));
    html += '<h2 class="tk-panel__h2">Зрители</h2>' +
      (d.viewers.length ? table(TRACE_HEAD(false), d.viewers.map((t) => traceRow(t, false))) : note('Зрителей с телеметрией нет')) + DBIP;
    return { html, title: v.name || 'Камера' };
  },
};

// ── Карточка звонка ──────────────────────────────────────────────────────────
// Запись журнала звонков, реле TURN по людям (utils/turnLog.js), попытки
// сторон и журнал Daily по кнопке — routes/admin/traces.js.
const CALL_STATUS = { ringing: 'звонит', answered: 'разговор был', declined: 'отклонён', canceled: 'отменён', missed: 'не ответили', failed: 'не поднялся' };
const TURN_ERR = { 486: 'квота на человека', 508: 'порты кончились', auth: 'неверный ключ' };

function turnRow(t) {
  const errs = Object.entries(t.errors).map(([k, v]) => (TURN_ERR[k] || k) + (v > 1 ? ' ×' + v : '')).join(', ');
  return '<tr><td>' + (t.user ? person(t.user) : '—') + '</td>' +
    '<td class="tk-num">' + num(t.allocs) + (t.open ? '<span class="tk-panel__why">открыто ' + num(t.open) + '</span>' : '') + '</td>' +
    '<td class="tk-num">' + num(t.inKB) + '</td><td class="tk-num">' + num(t.outKB) + '</td>' +
    '<td>' + (errs ? '<span class="tk-tag tk-tag--bad">' + esc(errs) + '</span>' : '—') + '</td></tr>';
}

VIEWS.call = {
  title: 'Звонок',
  hidden: true,
  admin: true,
  async render(params) {
    if (!params.id) return { html: note('Звонок не выбран') };
    const d = await api('/calls/' + encodeURIComponent(params.id) + '/detail');
    const c = d.call;
    const fact = (k, v) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>';

    let html = '<a class="tk-panel__back" href="' + href('traces', { kind: 'call' }) + '">← к попыткам звонков</a>';
    if (c) {
      html += '<h2 class="tk-panel__h2">Звонок</h2><dl class="tk-facts">' +
        fact('Кто звонил', c.caller ? person(c.caller) : '—') +
        fact(c.chat ? 'Ответил первым' : 'Кому', c.callee ? person(c.callee) : '—') +
        (c.people.length ? fact('Ещё в разговоре', c.people.map((p) => (p.user ? person(p.user) : '—')).join(' ')) : '') +
        fact('Тип', esc((c.type === 'video' ? 'с видео' : 'голосом') + (c.group ? ', группа' : '') + (c.chat ? ', звонок группе' : ''))) +
        fact('Начало', esc(when(c.startedAt))) +
        fact('Итог', esc((CALL_STATUS[c.status] || c.status) + (c.duration ? ', ' + dur(c.duration) : ''))) +
        fact('Путь', esc(c.path === 'own' ? 'свой сервер' : 'Daily') + (c.fallback ? '<span class="tk-panel__why">ушли с Daily: ' + esc(c.fallback) + '</span>' : '')) +
        '</dl>';
      html += '<h2 class="tk-panel__h2">Наш TURN</h2>' + (c.turn.length
        ? table([{ title: 'Кто' }, { title: 'Реле' }, { title: 'От собеседника, КБ' }, { title: 'К собеседнику, КБ' }, { title: 'Отказы' }], c.turn.map(turnRow)) +
          '<p class="tk-panel__why">Реле браузер берёт всегда, даже если пошёл напрямую; через реле шло, если КБ не ноль.</p>'
        : note(c.path === 'own' ? 'Строк coturn нет — журнал coturn не читается или звонок до 4 октября' : 'Через наш TURN не шло'));
    } else {
      html += note('Записи в журнале звонков нет — только попытки');
    }

    html += '<h2 class="tk-panel__h2">Стороны</h2>' +
      (d.sides.length ? table(TRACE_HEAD(false), d.sides.map((t) => traceRow(t, false))) : note('Попыток нет — разговор не начался или до 3 октября')) + DBIP;
    if (c && (c.path === 'daily' || c.fallback)) {
      html += '<p><button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="call-daily" data-id="' + esc(c.id) + '">Журнал Daily</button></p><div data-daily></div>';
    }
    return { html };
  },
};

function dailyDigest(m) {
  return '<p class="tk-panel__why">' + esc('Встреча ' + when(m.start) + ', ' + dur(m.duration)) + '</p>' +
    m.sides.map((x) => (m.sides.length > 1 ? '<h3 class="tk-panel__h3">' + (x.user ? person(x.user) : 'участник') + '</h3>' : '') + dailySide(x)).join('');
}

function dailySide(m) {
  const fact = (k, v) => '<dt>' + esc(k) + '</dt><dd>' + esc(v == null || v === '' ? '—' : String(v)) + '</dd>';
  return '<dl class="tk-facts">' +
    fact('Устройство', [m.os, m.browser].filter(Boolean).join(' · ')) +
    fact('Часовой пояс', m.tz) +
    fact('Загрузка Daily', m.bundleMs == null ? null : sec(m.bundleMs) + (m.failedOver ? ', через запасной домен' : '')) +
    fact('Первый кадр отправлен', m.ttfmMs == null ? null : sec(m.ttfmMs)) +
    fact('Камера', m.cameraDenied ? 'доступ запрещён' : '') +
    fact('Доступная отдача', m.availKbps == null ? null : m.availKbps + ' кбит/с (минимум ' + m.availMinKbps + ')') +
    fact('Отправлял', m.sentKbps == null ? null : m.sentKbps + ' кбит/с') +
    fact('Кадр', m.frames.join(', ')) +
    fact('Сеть по Daily', m.net.join(', ')) +
    fact('Переподключения', m.reconnects + (m.stale ? ', связь пропадала ' + m.stale + ' раз' : '')) +
    fact('Ошибок в журнале', m.errors) +
    '</dl>';
}

view.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act="stream-daily"], [data-act="call-daily"]');
  if (!btn) return;
  const box = view.querySelector('[data-daily]');
  btn.disabled = true;
  box.innerHTML = note('Спрашиваем Daily…');
  try {
    const d = await api((btn.dataset.act === 'call-daily' ? '/calls/' : '/streams/') + encodeURIComponent(btn.dataset.id) + '/daily');
    box.innerHTML = d.meetings.length ? d.meetings.map(dailyDigest).join('') : note('У Daily нет встреч этой комнаты');
  } catch (err) {
    box.innerHTML = note(err.message);
  }
  btn.disabled = false;
});

// ── Расходы ──────────────────────────────────────────────────────────────────
VIEWS.costs = {
  title: 'Расходы',
  admin: true,
  csv: true,
  filters: [{ name: 'days', options: [
    { value: '30', title: 'За 30 дней' }, { value: '7', title: 'За неделю' },
    { value: '1', title: 'За сутки' }, { value: '90', title: 'За 90 дней' },
  ] }],
  async render(params) {
    const d = await api('/costs?days=' + encodeURIComponent(params.days || 30));

    let html = '<h2 class="tk-panel__h2">Daily — участнико-минуты</h2><div class="tk-tiles">';
    html += tile('Звонки', num(d.daily.callMinutes) + ' мин', count(d.daily.calls, 'разговор', 'разговора', 'разговоров') + ', по двое');
    html += tile('Веб-эфиры', num(d.daily.streamMinutes) + ' мин', count(d.daily.webStreams, 'эфир', 'эфира', 'эфиров') + ': ведущий и выход в HLS');
    html += tile('Всего', num(d.daily.callMinutes + d.daily.streamMinutes) + ' мин', 'за ' + count(d.days, 'день', 'дня', 'дней'));
    html += tile('Камеры заведений', num(d.daily.venueSwitchOns), 'включений — минуты знает только Daily');
    html += tile('Звонки мимо Daily', num(d.ownCalls.minutes) + ' мин', count(d.ownCalls.calls, 'разговор', 'разговора', 'разговоров') + ' через свой сервер');
    html += '</div>';

    html += '<h2 class="tk-panel__h2">Bunny — хранение записей</h2><div class="tk-tiles">';
    html += tile('Лежит сейчас', bytes(d.bunny.storedBytes), count(d.bunny.storedCount, 'запись', 'записи', 'записей'));
    html += tile('Добавилось', bytes(d.bunny.addedBytes), count(d.bunny.addedCount, 'запись', 'записи', 'записей') + ' за ' + count(d.days, 'день', 'дня', 'дней'));
    html += '</div>';

    html += '<h2 class="tk-panel__h2">Своё железо</h2><div class="tk-tiles">';
    html += tile('Эфиры с OBS', num(d.obs.streams), d.obs.hours + ' ч транскода на нашем сервере');
    html += '</div>';

    html += '<h2 class="tk-panel__h2">По данным поставщиков</h2>' +
      '<div id="providers">' + note('Сверяем с Daily и Bunny…') + '</div>';

    html += '<h2 class="tk-panel__h2">Чего мы не измеряем</h2><ul class="tk-list">' +
      d.unknown.map((u) => '<li>' + esc(u) + '</li>').join('') + '</ul>';

    return { html, sub: 'Выше — наша оценка, ниже — что говорят сами поставщики' };
  },

  // Поставщики отвечают секундами — дорисовываем, когда ответят.
  async after(params) {
    const box = document.getElementById('providers');
    let d;
    try {
      d = await api('/costs/providers?days=' + encodeURIComponent(params.days || 30));
    } catch (err) {
      if (box) box.innerHTML = note('Сверка не удалась: ' + err.message);
      return;
    }
    if (!box || !box.isConnected) return;

    const KIND = { stream: 'Веб-эфиры', call: 'Звонки', venue: 'Камеры заведений', other: 'Прочие комнаты' };
    let html = '';

    if (!d.daily.configured) html += note('Daily: ключ API не задан');
    else if (d.daily.error) html += note('Daily не ответил: ' + d.daily.error);
    else {
      html += '<div class="tk-tiles">';
      html += tile('Daily всего', num(d.daily.minutes) + ' мин', d.daily.usd != null ? '≈ $' + d.daily.usd : 'цена минуты не задана');
      Object.entries(d.daily.kinds).forEach(([k, v]) => {
        html += tile(KIND[k] || k, num(v.minutes) + ' мин', count(v.meetings, 'встреча', 'встречи', 'встреч') + ', до ' + count(v.peak, 'участника', 'участников', 'участников'));
      });
      html += '</div>';
      if (!d.daily.complete) html += '<p class="tk-panel__why">Встреч больше пяти тысяч — посчитаны не все, сузьте период.</p>';
      html += '<p class="tk-panel__why">Daily считает всё время участника в комнате, включая дозвон и подключение, — поэтому его минуты больше нашей оценки по состоявшимся разговорам. Счёт идёт по Daily, его цифра — та, что в счёте.</p>';
    }

    if (!d.bunny.configured) html += note('Bunny: ключ аккаунта (BUNNY_API_KEY) не задан — трафик и деньги неизвестны');
    else if (d.bunny.error) html += note('Bunny не ответил: ' + d.bunny.error);
    else {
      html += '<div class="tk-tiles">';
      html += tile('Трафик Bunny', bytes(d.bunny.bandwidthBytes), count(d.bunny.requests, 'запрос', 'запроса', 'запросов') +
        (d.bunny.cacheHitRate != null ? ', из кэша ' + d.bunny.cacheHitRate + '%' : ''));
      if (d.bunny.storage) html += tile('Хранилище Bunny', bytes(d.bunny.storage.bytes), count(d.bunny.storage.files, 'файл', 'файла', 'файлов'));
      if (d.bunny.spentUsd != null) html += tile('Списано Bunny', '$' + d.bunny.spentUsd, 'на счёте $' + d.bunny.balanceUsd);
      html += '</div>';
    }

    const at = d.daily.cachedAt || d.bunny.cachedAt;
    if (at) html += '<p class="tk-panel__why">Данные на ' + esc(when(at)) + ', обновляются не чаще раза в 10 минут.</p>';
    box.innerHTML = html;
  },
};

// ── Хранилище ────────────────────────────────────────────────────────────────
//
// Что лежит в Bunny и на диске сервера, по видам, и во что это обходится.
// Отчёт считает сервер обходом хранилищ (utils/storageReport.js) — пока
// считает, вкладка показывает «считаем» и спрашивает снова.
const STORE_GROUPS = {
  recordings: 'Записи эфиров', gallery: 'Галерея профилей', chat: 'Переписка', avatars: 'Аватары',
  covers: 'Обложки эфиров', venues: 'Фото заведений', drafts: 'Видео в загрузке', recChunks: 'Куски идущих записей',
  live: 'Эфиры сейчас (HLS)', basemap: 'Подложка карты', other: 'Прочее',
};
const STORE_KINDS = {
  video: 'видео', hls: 'качества HLS', cover: 'обложки', photo: 'фото', image: 'фото', audio: 'аудио',
  voice: 'голосовые', round: 'кружки', file: 'файлы', preview: 'превью в ленте', part: 'недокачанное',
  orphan: 'без владельца',
};
const kindTitle = (group, kind) => (group === 'chat' && kind === 'file' ? 'документы' : STORE_KINDS[kind] || kind);
const money = (n) => (n == null ? '—' : '$' + (n < 10 ? n.toFixed(2) : num(Math.round(n))));

// Доля — полоса одного цвета (тот же синий, что у графиков сводки): видов
// много, и различать их цветом не нужно — подпись стоит в той же строке.
const share = (part, whole) => {
  const p = whole ? (part / whole) * 100 : 0;
  return '<span class="tk-share" title="' + p.toFixed(1) + '%"><i style="width:' + (part ? Math.max(1, p).toFixed(1) : 0) + '%"></i></span>';
};

function storeTable(t, prices) {
  const groups = Object.entries(t.groups).sort((a, b) => b[1].bytes - a[1].bytes);
  const rows = [];
  for (const [g, v] of groups) {
    rows.push('<tr class="tk-store__group"><td>' + esc(STORE_GROUPS[g] || g) + '</td><td>' + num(v.files) + '</td><td>' + bytes(v.bytes) +
      '</td><td>' + share(v.bytes, t.bytes) + '</td>' + (prices ? '<td>' + money(prices[g]) + '</td>' : '') + '</tr>');
    const kinds = Object.entries(v.kinds);
    // Один вид без подписи («файлы») — строка повторила бы группу.
    if (kinds.length === 1 && kinds[0][0] === 'file') continue;
    kinds.sort((a, b) => b[1].bytes - a[1].bytes).forEach(([k, x]) => {
      rows.push('<tr class="tk-store__kind' + (k === 'orphan' ? ' is-orphan' : '') + '"><td>' + esc(kindTitle(g, k)) + '</td><td>' + num(x.files) +
        '</td><td>' + bytes(x.bytes) + '</td><td>' + share(x.bytes, t.bytes) + '</td>' + (prices ? '<td></td>' : '') + '</tr>');
    });
  }
  const head = [{ title: 'Что' }, { title: 'Файлов' }, { title: 'Объём' }, { title: 'Доля' }];
  if (prices) head.push({ title: 'В месяц' });
  return table(head, rows);
}

function filesTable(list) {
  return table([{ title: 'Файл' }, { title: 'Где' }, { title: 'Что' }, { title: 'Размер' }, { title: 'Загружен' }], list.map((f) =>
    '<tr><td><code>' + esc(f.key) + '</code>' + (f.link ? ' <a href="' + esc(f.link) + '" target="_blank" rel="noopener">открыть</a>' : '') + '</td>' +
    '<td>' + esc(f.place) + '</td><td>' + esc((STORE_GROUPS[f.group] || f.group) + ', ' + kindTitle(f.group, f.kind)) + '</td>' +
    '<td>' + bytes(f.size) + '</td><td>' + esc(when(f.at)) + '</td></tr>'));
}

let storePending = false;

VIEWS.storage = {
  title: 'Хранилище',
  admin: true,
  csv: true,
  tools: () => '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" id="storageFresh">Пересчитать</button>',
  async render() {
    const d = await api('/storage');
    storePending = !!d.pending;
    if (d.pending) return { html: note('Считаем место: обходим Bunny и диск сервера. Начали ' + when(d.startedAt) + ' — страница обновится сама.'), sub: '' };
    if (d.error) return { html: note('Не удалось посчитать: ' + d.error), sub: '' };

    const r = d.report, c = d.costs, z = d.zone;
    let html = '';

    html += '<h2 class="tk-panel__h2">Bunny — записи, галерея, переписка</h2>';
    if (!r.bunny) {
      html += note('Хранилище Bunny не подключено: записи, галерея и файлы переписки лежат на диске сервера — они ниже.');
    } else {
      const b = r.bunny, cb = c.bunny;
      html += '<div class="tk-tiles">';
      html += tile('Занято', bytes(b.bytes), count(b.files, 'файл', 'файла', 'файлов'));
      html += tile('Хранение в месяц', money(cb.monthUsd), '$' + c.tariff.storeGb + ' за ГБ × ' + count(c.tariff.copies, 'копия', 'копии', 'копий'));
      html += tile('Добавилось за 30 дней', bytes(b.added30), 'это +' + money(cb.forecast[0].usd - cb.monthUsd) + ' в месяц к счёту');
      html += tile('Без владельца', bytes(cb.orphanBytes), cb.orphanBytes ? money(cb.orphanUsd) + ' в месяц впустую' : 'лишнего нет');
      if (c.traffic) {
        html += tile('Трафик за 30 дней', bytes(c.traffic.bytes), '≈ ' + money(c.traffic.usd) + ' по $' + c.tariff.trafficGb + ' за ГБ');
        if (c.traffic.spentUsd != null) html += tile('Списано Bunny', money(c.traffic.spentUsd), 'за 30 дней, на счёте ' + money(c.traffic.balanceUsd));
      }
      html += '</div>';
      if (!z.configured) html += '<p class="tk-panel__why">Ключ аккаунта Bunny (BUNNY_API_KEY) не задан: трафик, списания и число копий неизвестны — считаем одну копию.</p>';
      else if (z.error) html += '<p class="tk-panel__why">Bunny не ответил: ' + esc(z.error) + '</p>';
      else if (z.storage) html += '<p class="tk-panel__why">Сам Bunny считает ' + bytes(z.storage.bytes) + ', ' + count(z.storage.files, 'файл', 'файла', 'файлов') + ' (регион ' + esc(z.storage.region) + '); его цифра обновляется с задержкой до суток.</p>';
      html += storeTable(b, cb.groups);

      html += '<h2 class="tk-panel__h2">Прогноз хранения</h2>';
      html += table([{ title: 'Через' }, { title: 'Объём' }, { title: 'Хранение в месяц' }], cb.forecast.map((f) =>
        '<tr><td>' + count(f.months, 'месяц', 'месяца', 'месяцев') + '</td><td>' + bytes(f.bytes) + '</td><td>' + money(f.usd) + '</td></tr>'));
      html += '<p class="tk-panel__why">Если каждый месяц добавляется столько же, сколько за последние 30 дней. Удалённое за это время не вычтено — прогноз с запасом.</p>';
    }

    const s = r.server, cs = c.server;
    html += '<h2 class="tk-panel__h2">Сервер — аватары, обложки, эфиры, база</h2><div class="tk-tiles">';
    if (s.disk) html += tile('Свободно на диске', bytes(s.disk.free), 'занято ' + Math.round((1 - s.disk.free / s.disk.total) * 100) + '% из ' + bytes(s.disk.total));
    html += tile('Наши файлы и база', bytes(cs.usedBytes), count(s.files, 'файл', 'файла', 'файлов') + ', база ' + bytes(cs.dbBytes));
    html += tile('Добавилось за 30 дней', bytes(s.added30), cs.daysLeft != null ? 'диска так хватит на ' + count(cs.daysLeft, 'день', 'дня', 'дней') : 'рост нулевой');
    html += tile('Сервер в месяц', cs.hostingMonth ? money(cs.hostingMonth) : 'оплачен вперёд', 'место на диске входит в тариф');
    html += '</div>';
    html += storeTable(s, null);

    const months = [...new Set([...Object.keys((r.bunny && r.bunny.months) || {}), ...Object.keys(s.months)])].sort().reverse().slice(0, 12);
    if (months.length) {
      const sum = (m) => Object.values(m || {}).reduce((a, n) => a + n, 0);
      const peak = Math.max(...months.map((m) => sum(r.bunny && r.bunny.months[m]) + sum(s.months[m])), 1);
      html += '<h2 class="tk-panel__h2">Сколько добавлялось по месяцам</h2>';
      html += table([{ title: 'Месяц' }, { title: 'Bunny' }, { title: 'Сервер' }, { title: '' }], months.map((m) => {
        const bb = sum(r.bunny && r.bunny.months[m]), ss = sum(s.months[m]);
        return '<tr><td>' + esc(m.slice(5) + '.' + m.slice(0, 4)) + '</td><td>' + (r.bunny ? bytes(bb) : '—') + '</td><td>' + bytes(ss) + '</td><td>' + share(bb + ss, peak) + '</td></tr>';
      }));
      html += '<p class="tk-panel__why">По дате загрузки файлов, которые лежат сейчас: удалённое сюда не попадает.</p>';
    }

    const tag = (list, place) => list.map((f) => ({ ...f, place }));
    const top = tag((r.bunny && r.bunny.top) || [], 'Bunny').concat(tag(s.top, 'Сервер')).sort((a, b) => b.size - a.size).slice(0, 20);
    html += '<h2 class="tk-panel__h2">Самые большие файлы</h2>' + filesTable(top);
    const orphans = tag((r.bunny && r.bunny.orphanTop) || [], 'Bunny').concat(tag(s.orphanTop, 'Сервер')).sort((a, b) => b.size - a.size);
    if (orphans.length) {
      html += '<h2 class="tk-panel__h2">Без владельца</h2>' + filesTable(orphans) +
        '<p class="tk-panel__why">На эти файлы не ссылается ни одна запись, видео, фото или сообщение: скорее всего, остались от прерванной загрузки или удаления. Хранить их незачем.</p>';
    }

    return { html, sub: 'Посчитано ' + when(r.at) + (r.ms < 1000 ? ' меньше чем за секунду' : ' за ' + dur(r.ms / 1000)) + (r.bunny ? ', папок Bunny: ' + num(r.bunny.dirs) : '') + '. Пересчёт — не чаще раза в 30 минут, или кнопкой' };
  },

  after() {
    const btn = document.getElementById('storageFresh');
    if (btn) btn.onclick = async () => {
      btn.disabled = true;
      view.innerHTML = note('Пересчитываем…');
      try { await api('/storage?fresh=1'); } catch (err) { toast('Не удалось: ' + err.message, 'error'); }
      show();
    };
    // Считается — спрашиваем снова, пока вкладка открыта.
    if (storePending) setTimeout(() => { if (route().name === 'storage') show(); }, 3000);
  },
};

// ── Сроки хранения ───────────────────────────────────────────────────────────
//
// Сколько хранить то, что люди загружают, — всем и отдельным людям
// (routes/admin/retention.js). Пока сроки не применяются: вкладка хранит
// решение и считает, сколько файлов и места ушло бы сегодня.
const RET_KINDS = [
  ['chat', 'Переписка', 'фото, видео, голосовые, кружки и документы в личных и групповых чатах'],
  ['photos', 'Фото галереи', 'лента фото в профиле'],
  ['videos', 'Видео галереи', 'загруженные видео в профиле'],
  ['recordings', 'Записи эфиров', 'сохранённые после эфира записи'],
];
const RET_DAYS = [[0, 'бессрочно'], [30, '30 дней'], [90, '3 месяца'], [180, 'полгода'], [365, '1 год'], [730, '2 года'], [1095, '3 года'], [1825, '5 лет']];
const retTitle = (days) => (RET_DAYS.find((d) => d[0] === days) || [0, days + ' дн.'])[1];

// Выбор срока. inherit — у человека: первым пунктом «как у всех (…)».
function retSelect(kind, value, inherit) {
  const list = RET_DAYS.some((d) => d[0] === value) || value == null ? RET_DAYS : RET_DAYS.concat([[value, value + ' дн.']]);
  return '<select class="tk-field tk-select tk-ret" data-ret="' + kind + '">' +
    (inherit != null ? '<option value=""' + (value == null ? ' selected' : '') + '>как у всех — ' + esc(retTitle(inherit)) + '</option>' : '') +
    list.map(([d, t]) => '<option value="' + d + '"' + (value === d ? ' selected' : '') + '>' + esc(t) + '</option>').join('') +
  '</select>';
}

// Собрать выбранное: у общих — числа, у личных пустое — null («как у всех»).
function retValues(root) {
  const out = {};
  root.querySelectorAll('[data-ret]').forEach((s) => { out[s.dataset.ret] = s.value === '' ? null : Number(s.value); });
  return out;
}

VIEWS.retention = {
  title: 'Сроки хранения',
  admin: true,
  async render() {
    const d = await api('/retention');
    let html = '<p class="tk-panel__warn">Сроки пока не применяются: все файлы хранятся бессрочно. Здесь их задают заранее и видят, сколько файлов ушло бы, начни мы убирать сегодня.</p>';
    html += table([{ title: 'Что' }, { title: 'Хранить' }, { title: 'Ушло бы сегодня' }], RET_KINDS.map(([k, name, hint]) => {
      const p = d.preview[k] || { files: 0, bytes: 0 };
      return '<tr><td>' + esc(name) + '<br><span class="tk-panel__why">' + esc(hint) + '</span></td>' +
        '<td>' + retSelect(k, d.policy[k]) + '</td>' +
        '<td>' + (p.files ? count(p.files, 'файл', 'файла', 'файлов') + (k === 'photos' ? '' : ', ' + bytes(p.bytes)) : '—') + '</td></tr>';
    }));
    html += '<p class="tk-panel__more"><button type="button" class="tk-btn tk-btn--primary tk-btn--xs" data-act="ret-save">Сохранить сроки</button></p>';
    html += '<p class="tk-panel__why">Срок считается от загрузки. Чей файл — того и срок: у вложения — отправителя. Аватары, обложки и фото заведений не в счёт: они мелкие и лежат на своём сервере. «Ушло бы» считает и личные сроки людей ниже; у фото размер в базе не хранится — только число.</p>';

    html += '<h2 class="tk-panel__h2">Личные сроки</h2>';
    html += d.people.length
      ? table([{ title: 'Человек' }].concat(RET_KINDS.map(([, name]) => ({ title: name }))), d.people.map((p) =>
          '<tr><td>' + person(p.person) + '</td>' + RET_KINDS.map(([k]) => '<td>' + (p.own[k] == null ? '<span class="tk-panel__why">как у всех</span>' : esc(retTitle(p.own[k]))) + '</td>').join('') + '</tr>'))
      : note('Ни у кого нет своих сроков');
    html += '<p class="tk-panel__why">Свой срок задают в профиле человека — например, тому, кому нужно хранить дольше (потом — пакетом подписки).</p>';
    return { html, sub: d.updatedAt ? 'Изменены ' + when(d.updatedAt) : 'По умолчанию — всё бессрочно' };
  },
};

// ── Нагрузка ─────────────────────────────────────────────────────────────────
//
// Верх «Системы» (02.10.2026, план п. 7): замеры раз в минуту
// (utils/loadStats.js) — сейчас и графиком за отрезок. Здесь же выбор знака
// эфиров: он делается ради процессора (routes/admin/load.js). Отдельной
// вкладки «Водяной знак» больше нет.
const LOAD_RANGES = [
  { value: 'hour', title: 'За час' },
  { value: '', title: 'За сутки' },
  { value: 'week', title: 'За неделю' },
  { value: 'month', title: 'За месяц' },
];
const PROC_NAMES = { ffmpeg: 'ffmpeg', node: 'Node', mongo: 'база', mediamtx: 'MediaMTX', turn: 'TURN', other: 'прочее' };
const comma = (n, d = 1) => (Number(n) || 0).toFixed(d).replace('.', ',');
const pct = (n) => comma(n) + '%';

function loadLabel(iso, range) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  const dm = p(d.getDate()) + '.' + p(d.getMonth() + 1);
  const hm = p(d.getHours()) + ':' + p(d.getMinutes());
  return range === 'month' ? dm : range === 'week' ? dm + ' ' + hm : hm;
}

function loadHtml(d) {
  const s = d.last;
  const c = d.usage.count;
  const streams = (c.full || 0) + (c.lite || 0) + (c.copy || 0);
  const inFrame = d.mode === 'frame';

  let html = '<h2 class="tk-panel__h2">Нагрузка</h2><div class="tk-tiles">';
  html += tile('Процессор', s ? pct(s.cpu) : '—', s
    ? 'средняя загрузка ' + comma(s.load, 2) + ' на 4 ядра; выше ' + d.warn + '% пять минут — запись в журнал ошибок'
    : 'замеров ещё нет — первый через минуту после запуска');
  if (s && s.procs) {
    const parts = Object.entries(s.procs).sort((a, b) => b[1] - a[1]).map(([k, v]) => (PROC_NAMES[k] || k) + ' ' + comma(v));
    html += tile('Ядер по процессам', parts[0] || '—', parts.slice(1).join(' · ') || 'остальные — ноль');
  }
  if (s) html += tile('Память', pct(s.mem), 'занято, без кэша диска');
  html += tile('Эфиров сейчас', num(streams), [
    c.full ? c.full + ' в трёх качествах' : '',
    c.lite ? c.lite + ' облегчённо, 480p' : '',
    c.copy ? c.copy + ' копией' : '',
    c.venue ? count(c.venue, 'камера', 'камеры', 'камер') + ' заведений' : '',
  ].filter(Boolean).join(', ') || 'ни одного');
  if (s) html += tile('Зрителей · звонков', num(s.viewers) + ' · ' + num(s.calls), 'зрители — в комнатах эфиров, звонки — идущие');
  if (s && s.net) html += tile('Сеть, Мбит/с', comma(s.net.tx) + ' ↑ · ' + comma(s.net.rx) + ' ↓', 'исходящий и входящий за последнюю минуту; трафик за месяц — ниже');
  if (s) html += tile('Запасной путь', num(s.lf || 0), 'зрителей смотрят эфир с нашего канала (/lf/), а не через Bunny');
  if (s) html += tile('Порты TURN', num(s.turn || 0) + ' из ' + num(d.turnPorts), 'оценка по звонкам своим путём; у порога — запись в журнал ошибок');
  if (s && s.encode) {
    const e = s.encode;
    html += tile('Очередь пережатия', num(e.recording + e.chat + e.gallery),
      'записи эфиров ' + num(e.recording) + ', переписка ' + num(e.chat) + ', галерея ' + num(e.gallery) + ' — вместе с идущими');
  }
  html += '</div>';

  const pts = d.points;
  if (pts.length) {
    const labels = pts.map((p) => loadLabel(p.at, d.range));
    const avg = (key) => pts.reduce((a, p) => a + (p[key] || 0), 0) / pts.length;
    const peak = (key) => Math.max(...pts.map((p) => p[key] || 0));
    const ff = pts.map((p) => (p.procs && p.procs.ffmpeg) || 0);
    html += '<div class="tk-charts">' +
      series('Процессор, в среднем', labels, pts.map((p) => p.cpu || 0), pct, 'за отрезок ' + pct(avg('cpu')), 100) +
      series('Процессор, пик', labels, pts.map((p) => p.cpuMax || 0), pct, 'максимум ' + pct(peak('cpuMax')), 100) +
      series('ffmpeg, ядер', labels, ff, comma, 'в среднем ' + comma(ff.reduce((a, b) => a + b, 0) / ff.length)) +
      series('Эфиров', labels, pts.map((p) => p.streams), num, 'максимум ' + num(peak('streams'))) +
      series('Зрителей', labels, pts.map((p) => p.viewers), num, 'максимум ' + num(peak('viewers'))) +
      series('Звонков', labels, pts.map((p) => p.calls), num, 'максимум ' + num(peak('calls'))) +
      series('Сеть исходящая, Мбит/с', labels, pts.map((p) => p.tx || 0), comma, 'в среднем ' + comma(avg('tx')) + ', пик ' + comma(peak('txMax'))) +
      series('Сеть входящая, Мбит/с', labels, pts.map((p) => p.rx || 0), comma, 'в среднем ' + comma(avg('rx'))) +
      series('Зрителей на запасном пути', labels, pts.map((p) => p.lf), num, 'максимум ' + num(peak('lf'))) +
      series('Порты TURN', labels, pts.map((p) => p.turn), num, 'максимум ' + num(peak('turn')) + ' из ' + num(d.turnPorts), d.turnPorts) +
      series('Очередь пережатия', labels, pts.map((p) => p.encode), num, 'максимум ' + num(peak('encode'))) +
      series('Диск эфиров занят', labels, pts.map((p) => p.disk || 0), pct, 'максимум ' + pct(peak('disk')) + '; от ' + d.diskWarn + '% — в журнал', 100) +
    '</div>';
  } else {
    html += note('За этот отрезок замеров нет');
  }

  html += '<h2 class="tk-panel__h2">Знак эфиров</h2>';
  html += '<div class="tk-card"><label class="tk-switch tk-switch--wrap"><input type="checkbox" data-act="wm-frame"' + (inFrame ? ' checked' : '') + '> Знак в кадре — пережимать каждый эфир на сервере</label>' +
    '<p class="tk-panel__why">Сейчас: ' + (inFrame ? 'в кадре' : 'поверх плеера') + (d.modeAt ? ', изменено ' + when(d.modeAt) : ', по умолчанию') +
    '. По оценке видео сейчас занимает ≈ ' + comma(d.usage.cores) + ' из 4 ядер.</p></div>';
  html += '<p class="tk-panel__why"><b>Поверх плеера</b> — первые два эфира идут в трёх качествах (720p, 480p, 360p), остальные — копией того, что прислал вещатель: одно качество, процессора почти не тратят. Одновременно — десятки эфиров. Знак рисует страница: на экране и на записи экрана он есть, но по прямой ссылке на поток его нет.</p>';
  html += '<p class="tk-panel__why"><b>В кадре</b> — знак вшит в видео, убрать его нельзя. Первые два эфира — в трёх качествах, остальные — одним 480p. Каждый эфир стоит процессора: при четырёх-пяти одновременно сервер у предела, тормозит и сайт.</p>';
  html += '<p class="tk-panel__why">Смена действует на эфиры, начатые после неё; идущие доходят как начались. Записи — всегда со знаком в кадре: при знаке поверх плеера запись пережимается со знаком после эфира, в фоне. Камеры заведений — всегда со знаком в кадре: их пережимаем в любом случае.</p>';
  return html;
}

// ── Система ──────────────────────────────────────────────────────────────────
VIEWS.system = {
  title: 'Система',
  admin: true,
  filters: [{ name: 'range', options: LOAD_RANGES }],
  async render(params) {
    const [d, load] = await Promise.all([api('/system'), api('/load?range=' + encodeURIComponent(params.range || ''))]);

    let html = loadHtml(load);
    html += '<h2 class="tk-panel__h2">Процесс, база, диск</h2><div class="tk-tiles">';
    html += tile('Процесс живёт', dur(d.process.uptime), 'Node ' + esc(d.process.node) + ', режим ' + esc(d.process.mode));
    html += tile('Память', bytes(d.process.rss), 'куча ' + bytes(d.process.heap));
    html += tile('База', d.db.state === 'connected' ? 'на связи' : 'недоступна', esc(d.db.name));
    html += tile('Открытых сеансов', num(d.db.sessions), 'в коллекции сессий');
    if (d.disk) {
      const share = Math.round((1 - d.disk.free / d.disk.total) * 100);
      html += tile('Свободно на диске', bytes(d.disk.free), 'занято ' + share + '% из ' + bytes(d.disk.total) + ' — сюда пишутся эфиры');
    }
    // Сверх лимита Hostinger режет весь сервер до 10 Мбит/с (utils/traffic.js).
    if (d.traffic) {
      const t = d.traffic;
      const tb = (n) => (n / 1e12).toFixed(2) + ' ТБ';
      const share = Math.round(((t.rx + t.tx) / t.limit) * 100);
      html += tile('Трафик за месяц', tb(t.rx + t.tx) + ' · ' + share + '%',
        'из ' + tb(t.limit) + '; исходящий ' + tb(t.tx) + ', входящий ' + tb(t.rx) +
        '. К концу месяца ≈ ' + tb(t.forecast) + (t.forecast > t.limit ? ' — <b>выше лимита</b>' : '') +
        (new Date(t.since).getUTCDate() > 1 && t.month === new Date(t.since).toISOString().slice(0, 7) ? '. Счёт с ' + when(t.since) : ''));
    }
    html += '</div>';

    html += '<div class="tk-dossier__cols"><section><h2 class="tk-panel__h2">Что в базе</h2><dl class="tk-facts">' +
      d.db.collections.map((c) => '<dt>' + esc(c.title) + '</dt><dd>' + num(c.count) + '</dd>').join('') +
      '</dl></section>';

    html += '<section><h2 class="tk-panel__h2">Настройки окружения</h2><dl class="tk-facts">' +
      d.env.map((e) => '<dt>' + esc(e.title) + '</dt><dd data-env="' + esc(e.key) + '">' + (e.set
        ? '<span class="tk-tag tk-tag--on">задана</span>'
        : '<span class="tk-tag tk-tag--bad">не задана</span>' +
          (e.missing.length ? '<span class="tk-panel__why">нет ' + e.missing.map(esc).join(', ') + '</span>' : '')) + '</dd>').join('') +
      '</dl><p class="tk-panel__why" id="envChecked">Проверяем сервисы…</p></section></div>';

    return { html, sub: 'Состояние процесса, базы и диска' };
  },

  // Заданная переменная ещё не значит рабочая: сервер делает по запросу
  // к каждому сервису, и отказ показывается третьим состоянием — «ошибка».
  async after() {
    const status = document.getElementById('envChecked');
    let d;
    try {
      d = await api('/system/checks');
    } catch (err) {
      if (status) status.textContent = 'Проверка не удалась: ' + err.message;
      return;
    }
    if (!status || !status.isConnected) return;

    Object.entries(d.env).forEach(([key, r]) => {
      const cell = view.querySelector('[data-env="' + key + '"]');
      if (!cell || r.ok) return;
      cell.innerHTML = '<span class="tk-tag tk-tag--bad">ошибка</span><span class="tk-panel__why">' + esc(r.error) + '</span>';
    });
    status.textContent = 'Сервисы проверены ' + when(d.checkedAt) + '. Значения переменных панель не запрашивает и не получает.';
  },
};

// ── Поддержка ────────────────────────────────────────────────────────────────
//
// Переписка официального аккаунта (utils/support.js): список диалогов
// и лента одного, ответ — от имени аккаунта поддержки. Аккаунт выбирается
// на вкладке «Рассылка».
const ATT = { image: 'фото', video: 'видео', round: 'кружок', voice: 'голосовое', audio: 'аудио', file: 'файл' };

function supportMessage(m, supportId) {
  const mine = m.sender === supportId;
  let body = '';
  if (m.expired) body = '<em>сообщение исчезло</em>';
  else if (m.limit) body = '<em>сообщение с ограничением — открыть может только получатель</em>';
  else {
    body = (m.attachments || []).map((a) => a.url
      ? '<a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(ATT[a.kind] || a.kind) + (a.name ? ': ' + esc(a.name) : '') + '</a>'
      : esc(ATT[a.kind] || a.kind)).join('<br>');
    if (m.content) body += (body ? '<br>' : '') + esc(m.content);
  }
  if (m.forwardedFrom) body = '<span class="tk-panel__why">переслано от ' + esc(m.forwardedFrom.name) + '</span><br>' + body;
  return '<li class="tk-sup__msg' + (mine ? ' tk-sup__msg--mine' : '') + '" data-at="' + esc(m.sentAt) + '">' +
    '<div class="tk-sup__text">' + body + '</div>' +
    '<span class="tk-sup__when">' + esc(when(m.sentAt)) + (mine ? (m.readAt ? ' · прочитано' : ' · доставлено') : '') + '</span></li>';
}

const lastText = (l) => (l ? (l.mine ? 'Вы: ' : '') + (l.kind ? '[' + (ATT[l.kind] || l.kind) + '] ' : '') + l.text : '—');

VIEWS.support = {
  title: 'Поддержка',
  admin: true,
  // Список обновляется сам: обращения приходят, пока вкладка открыта.
  // Открытый диалог — нет: перерисовка стёрла бы недописанный ответ.
  refresh: (params) => (params.peer ? 0 : 30000),
  // Отбор — только у списка: в открытом диалоге отбирать нечего.
  filters: (params) => (params.peer ? [] : [{ name: 'show', options: [
    { value: '', title: 'С ответами людей' }, { value: 'unread', title: 'Непрочитанные' }, { value: 'all', title: 'Все диалоги' },
  ] }]),
  async render(params) {
    if (params.peer) return supportThread(params);
    const d = await api('/support/dialogs?' + new URLSearchParams(serverParams(params)).toString() + '&page=' + (params.page || 1));
    if (!d.account) {
      return { html: note('Аккаунт поддержки не выбран — его выбирают на вкладке «Рассылка».') +
        '<p class="tk-panel__more"><a href="' + href('broadcast') + '">Выбрать →</a></p>' };
    }
    const rows = d.items.map((r) => '<tr>' +
      '<td>' + person(r.peer) + '</td>' +
      '<td><a class="tk-sup__last" href="' + href('support', { peer: r.peer.id }) + '">' + esc(lastText(r.last)) + '</a></td>' +
      '<td class="tk-num">' + (r.unread ? '<span class="tk-panel__badge">' + num(r.unread) + '</span>' : '') + '</td>' +
      '<td>' + esc(ago(r.at)) + '</td></tr>');
    return {
      html: table([{ title: 'Кто' }, { title: 'Последнее' }, { title: 'Новых', cls: 'tk-num' }, { title: 'Когда' }], rows) + pager(d, 'support', params),
      sub: 'от имени ' + d.account.displayName + ' · ' + count(d.total, 'диалог', 'диалога', 'диалогов'),
    };
  },
  async after(params) {
    if (!params.peer) return;
    const list = document.getElementById('supList');
    if (list) list.lastElementChild && list.lastElementChild.scrollIntoView({ block: 'end' });
    try {
      await send('POST', '/api/admin/support/dialogs/' + encodeURIComponent(params.peer) + '/read');
      badges();
    } catch (_) { /* лента видна и без отметки */ }
  },
};

async function supportThread(params) {
  const d = await api('/support/dialogs/' + encodeURIComponent(params.peer));
  const html = '<a class="tk-panel__back" href="' + href('support') + '">← ко всем диалогам</a>' +
    '<div class="tk-dossier__head">' + person(d.peer) +
      '<a class="tk-btn tk-btn--outline tk-btn--xs" href="/userPage/' + esc(d.peer.id) + '" target="_blank" rel="noopener">Страница на сайте</a></div>' +
    '<div class="tk-sup">' +
      (d.more ? '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs tk-sup__more" data-act="sup-more" data-id="' + esc(d.peer.id) + '">Раньше</button>' : '') +
      (d.messages.length ? '' : note('Переписки ещё нет — первое сообщение начнёт её.')) +
      '<ol class="tk-sup__list" id="supList" data-support="' + esc(d.account.id) + '">' +
        d.messages.map((m) => supportMessage(m, d.account.id)).join('') + '</ol>' +
      '<form class="tk-sup__form" data-peer="' + esc(d.peer.id) + '">' +
        '<textarea class="tk-field" name="content" rows="3" maxlength="5000" placeholder="Ответ от имени ' + esc(d.account.displayName) + '"></textarea>' +
        '<button type="submit" class="tk-btn tk-btn--primary tk-btn--xs">Отправить</button>' +
      '</form>' +
    '</div>';
  return { html, title: d.peer.displayName, sub: 'Переписка с поддержкой' };
}

// Ответ: Ctrl/Cmd+Enter тоже отправляет — в панели пишут длинно, Enter
// остаётся переносом строки.
view.addEventListener('submit', async (e) => {
  const form = e.target.closest('.tk-sup__form');
  if (!form) return;
  e.preventDefault();
  const field = form.elements.content;
  const content = field.value.trim();
  if (!content) return;
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    const r = await send('POST', '/api/admin/support/dialogs/' + encodeURIComponent(form.dataset.peer) + '/send', { content });
    const list = document.getElementById('supList');
    list.insertAdjacentHTML('beforeend', supportMessage(r.message, list.dataset.support));
    list.lastElementChild.scrollIntoView({ block: 'end' });
    const empty = list.previousElementSibling;
    if (empty && empty.classList.contains('tk-panel__note')) empty.remove();
    field.value = '';
  } catch (err) {
    toast(err.message || 'Не отправилось', 'error');
  }
  btn.disabled = false;
});
view.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.closest('.tk-sup__form')) {
    e.preventDefault();
    e.target.closest('.tk-sup__form').requestSubmit();
  }
});

// ── Рассылка ─────────────────────────────────────────────────────────────────
//
// Письмо от аккаунта поддержки сразу многим: от руки или с заготовки,
// на двух языках — каждому уходит на его (utils/support.js).
const AUDIENCES = {
  all: 'Все', recent: 'Новые за последние дни', nopush: 'Без пуш-уведомлений', self: 'Только мне — проверить',
};
const BROADCAST_STATUS = { running: 'идёт', done: 'готово', stopped: 'прервана' };
let TEMPLATES = [];

VIEWS.broadcast = {
  title: 'Рассылка',
  admin: true,
  async render() {
    const d = await api('/support');
    TEMPLATES = d.templates;
    const a = d.account;

    let html = '<h2 class="tk-panel__h2">Аккаунт поддержки</h2><div class="tk-card"><div class="tk-dossier__head">' +
      (a ? person(a) : note('Не выбран. Аккаунтом поддержки может быть только администратор.')) +
      '<div class="tk-dossier__acts">' +
        '<select class="tk-field tk-select" id="supAccount">' +
          (a ? '' : '<option value="">Выберите администратора</option>') +
          d.admins.map((p) => '<option value="' + esc(p.id) + '"' + (a && a.id === p.id ? ' selected' : '') + '>' + esc(p.displayName) + '</option>').join('') +
        '</select>' +
        '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="sup-account">Назначить</button>' +
      '</div></div>' +
      (a ? '<label class="tk-switch tk-switch--wrap"><input type="checkbox" data-act="sup-welcome"' + (a.welcome ? ' checked' : '') + '> Приветствие каждому новичку сразу после регистрации</label>' : '') +
      '</div>';

    if (a) {
      html += '<h2 class="tk-panel__h2">Новая рассылка</h2><div class="tk-card" id="bcForm">' +
        '<div class="tk-fields">' +
          '<label class="tk-field-row tk-field-row--wide"><span class="tk-field-row__label">Заготовка</span>' +
            '<select class="tk-field tk-select" id="bcTemplate"><option value="">От руки</option>' +
            TEMPLATES.map((t) => '<option value="' + esc(t.key) + '">' + esc(t.title) + '</option>').join('') + '</select></label>' +
          '<label class="tk-field-row"><span class="tk-field-row__label">По-русски</span>' +
            '<textarea class="tk-field tk-sup__area" id="bcRu" rows="12" maxlength="5000"></textarea></label>' +
          '<label class="tk-field-row"><span class="tk-field-row__label">По-английски — кто пользуется сайтом на английском</span>' +
            '<textarea class="tk-field tk-sup__area" id="bcEn" rows="12" maxlength="5000"></textarea></label>' +
          '<label class="tk-field-row"><span class="tk-field-row__label">Кому</span>' +
            '<select class="tk-field tk-select" id="bcAudience">' +
            Object.entries(AUDIENCES).map(([k, v]) => '<option value="' + k + '">' + esc(v) + '</option>').join('') + '</select></label>' +
          '<label class="tk-field-row" id="bcDaysRow" hidden><span class="tk-field-row__label">Дней</span>' +
            '<input class="tk-field" type="number" id="bcDays" min="1" max="365" value="7"></label>' +
        '</div>' +
        '<div class="tk-card__acts">' +
          '<label class="tk-switch"><input type="checkbox" id="bcPush" checked> С пуш-уведомлением</label>' +
          '<span class="tk-panel__why" id="bcCount"></span>' +
          '<button type="button" class="tk-btn tk-btn--primary tk-btn--xs" data-act="bc-send">Отправить</button>' +
        '</div></div>';
    }

    html += '<h2 class="tk-panel__h2">Отправленные</h2><div id="bcHistory">' + note('Загружаем…') + '</div>';
    return { html, sub: a ? 'от имени ' + a.displayName : 'сначала выберите аккаунт поддержки' };
  },
  async after() {
    audienceCount();
    history();
  },
};

async function audienceCount() {
  const box = document.getElementById('bcCount');
  if (!box) return;
  const kind = document.getElementById('bcAudience').value;
  document.getElementById('bcDaysRow').hidden = kind !== 'recent';
  const days = document.getElementById('bcDays').value;
  try {
    const d = await api('/support/audience?kind=' + kind + '&days=' + encodeURIComponent(days));
    box.textContent = 'получат ' + count(d.count, 'человек', 'человека', 'человек');
    box.dataset.count = d.count;
  } catch (err) {
    box.textContent = err.message;
  }
}

// История; пока рассылка идёт — перечитывается сама, пока вкладка на экране.
async function history() {
  const box = document.getElementById('bcHistory');
  if (!box) return;
  let d;
  try {
    d = await api('/support/broadcasts?perPage=20');
  } catch (err) {
    box.innerHTML = note('Не загрузилась: ' + err.message);
    return;
  }
  if (!box.isConnected) return;
  const title = (b) => {
    const t = TEMPLATES.find((x) => x.key === b.template);
    return (t ? t.title + ': ' : '') + (b.text.ru || b.text.en).slice(0, 90);
  };
  box.innerHTML = table(
    [{ title: 'Когда' }, { title: 'Кто' }, { title: 'Текст' }, { title: 'Кому' }, { title: 'Дошло', cls: 'tk-num' }, { title: 'Статус' }],
    d.items.map((b) => '<tr><td class="tk-nowrap">' + esc(when(b.createdAt)) + '</td>' +
      '<td>' + person(b.by) + '</td>' +
      '<td>' + esc(title(b)) + (b.text.en ? ' <span class="tk-tag">EN</span>' : '') + (b.push ? '' : ' <span class="tk-tag">без пуша</span>') + '</td>' +
      '<td>' + esc(AUDIENCES[b.audience.kind] || b.audience.kind) + (b.audience.days ? ' (' + b.audience.days + ' дн)' : '') + '</td>' +
      '<td class="tk-num">' + num(b.sent) + ' из ' + num(b.total) + (b.failed ? ' <span class="tk-tag tk-tag--bad">ошибок ' + num(b.failed) + '</span>' : '') + '</td>' +
      '<td>' + (b.status === 'running' ? dot(true) : '') + esc(BROADCAST_STATUS[b.status] || b.status) + '</td></tr>'));
  if (d.items.some((b) => b.status === 'running')) setTimeout(() => { if (box.isConnected) history(); }, 4000);
}

view.addEventListener('change', (e) => {
  const id = e.target.id;
  if (id === 'bcAudience' || id === 'bcDays') audienceCount();
  if (id === 'bcTemplate') {
    const ru = document.getElementById('bcRu');
    const en = document.getElementById('bcEn');
    const t = TEMPLATES.find((x) => x.key === e.target.value);
    ru.value = t ? t.ru : '';
    en.value = t ? t.en : '';
  }
});

// ── Каркас ───────────────────────────────────────────────────────────────────

// «За неделю» в фильтре — это from= для сервера. Отдельная функция, потому
// что тем же набором пользуются выгрузка и очистка журнала.
function serverParams(params) {
  const out = {};
  Object.entries(params).forEach(([k, v]) => {
    if (v === '' || v == null || k === 'page') return;
    if (k === 'period') { const f = periodFrom(v); if (f) out.from = f; return; }
    out[k] = v;
  });
  return out;
}

const ORDER = ['summary', 'live', 'streams', 'people', 'reports', 'support', 'broadcast', 'venues', 'recordings', 'audit', 'errors', 'traces', 'costs', 'storage', 'retention', 'system'];

function drawNav(active) {
  nav.innerHTML = ORDER.filter((name) => !VIEWS[name].admin || IS_ADMIN).map((name) => {
    const v = VIEWS[name];
    const on = name === active || (active === 'person' && name === 'people') || (active === 'stream' && name === 'streams');
    return '<a class="tk-panel__tab' + (on ? ' is-on' : '') + '" href="' + href(name) + '" data-tab="' + name + '">' +
           esc(v.title) + '<span class="tk-panel__badge" data-badge="' + name + '" hidden></span></a>';
  }).join('');
}

function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, query] = raw.split('?');
  const params = {};
  new URLSearchParams(query || '').forEach((v, k) => { params[k] = v; });
  return { name: VIEWS[name] ? name : 'summary', params };
}

let timer = null;
let token = 0;

async function show() {
  const { name, params } = route();
  const v = VIEWS[name];
  const mine = ++token; // ответ на прошлую вкладку не должен перерисовать новую

  if (timer) { clearInterval(timer); timer = null; }
  tip.hidden = true; // подсказка графика не должна пережить уход со сводки
  if (v.admin && !IS_ADMIN) {
    view.innerHTML = note('Этот раздел открыт только администратору');
    return;
  }

  drawNav(name);
  viewTitle.textContent = v.title;
  viewSub.textContent = '';
  viewTools.innerHTML = filtersHtml(typeof v.filters === 'function' ? v.filters(params) : v.filters, params) +
    // Выгрузка — тем же отбором, что на экране: сервер читает те же параметры.
    (v.csv ? '<a class="tk-btn tk-btn--outline tk-btn--xs" href="/api/admin/' + (v.api ? v.api.slice(1) : name) + '.csv?' +
      new URLSearchParams(serverParams(params)).toString() + '">CSV</a>' : '') +
    (v.tools ? v.tools(params) : '');
  view.innerHTML = note('Загружаем…');

  try {
    let out;
    if (v.api) {
      const query = new URLSearchParams({ ...serverParams(params), page: params.page || 1 }).toString();
      const data = await api(v.api + '?' + query);
      const html = v.render2
        ? v.render2(data, params)
        : table(v.head, data.items.map(v.row));
      out = { html: html + pager(data, name, params), sub: v.sub ? v.sub(data) : '' };
    } else {
      out = await v.render(params);
    }

    if (mine !== token) return;
    view.innerHTML = out.html;
    if (out.title) viewTitle.textContent = out.title;
    viewSub.textContent = out.sub || '';
    if (v.after) v.after(params);
  } catch (err) {
    if (mine !== token) return;
    view.innerHTML = note(err.message === 'HTTP 403' ? 'Нет прав на этот раздел' : 'Не удалось загрузить: ' + err.message);
  }

  const every = typeof v.refresh === 'function' ? v.refresh(params) : v.refresh;
  if (every) timer = setInterval(() => { if (!document.hidden) show(); }, every);
  badges();
}

// Счётчики новых жалоб и обращений в поддержку видны со всех вкладок: это
// то, что требует внимания сразу, а не когда откроют нужный раздел.
async function badges() {
  try {
    const d = await api('/summary');
    const put = (name, n) => {
      const badge = nav.querySelector('[data-badge="' + name + '"]');
      if (!badge) return;
      badge.textContent = n ? String(n) : '';
      badge.hidden = !n;
    };
    put('reports', d.reports.new);
    put('support', d.support); // непрочитанное поддержкой (routes/admin/support.js)
    put('venues', d.venuesReview); // заявки и правки заведений на проверке
  } catch (_) {
    // Панель без счётчика работает; ошибку покажет сама вкладка.
  }
}

// ── Действия ─────────────────────────────────────────────────────────────────

const reasonOf = (node) => {
  const card = node.closest('[data-card]');
  const field = card && card.querySelector('[data-reason]');
  return field ? field.value.trim() : '';
};

view.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT' || el.type === 'checkbox') return;

  const act = el.dataset.act;
  const id = el.dataset.id;

  try {
    if (act === 'sup-more') {
      const list = document.getElementById('supList');
      const first = list.firstElementChild;
      const d = await api('/support/dialogs/' + encodeURIComponent(id) + (first ? '?before=' + encodeURIComponent(first.dataset.at) : ''));
      list.insertAdjacentHTML('afterbegin', d.messages.map((m) => supportMessage(m, d.account.id)).join(''));
      if (!d.more) el.remove();
      return;
    }

    if (act === 'sup-account') {
      const userId = document.getElementById('supAccount').value;
      if (!userId) return toast('Выберите администратора', 'error');
      if (!await confirmDialog('Назначить аккаунтом поддержки? От него пойдут рассылки, его переписка откроется во вкладке «Поддержка».', { okText: 'Назначить' })) return;
      await send('POST', '/api/admin/support/account', { userId });
      toast('Аккаунт поддержки назначен', 'ok');
      return show();
    }

    if (act === 'bc-send') {
      const text = { ru: document.getElementById('bcRu').value.trim(), en: document.getElementById('bcEn').value.trim() };
      if (!text.ru && !text.en) return toast('Напишите текст рассылки', 'error');
      const kind = document.getElementById('bcAudience').value;
      const n = Number(document.getElementById('bcCount').dataset.count || 0);
      if (kind !== 'self' && !await confirmDialog('Отправить ' + count(n, 'человеку', 'людям', 'людям') + '? Отменить рассылку нельзя.', { okText: 'Отправить' })) return;
      el.disabled = true;
      try {
        const r = await send('POST', '/api/admin/support/broadcast', {
          text,
          template: document.getElementById('bcTemplate').value,
          audience: { kind, days: Number(document.getElementById('bcDays').value) || 7 },
          push: document.getElementById('bcPush').checked,
        });
        toast('Рассылка пошла: ' + count(r.total, 'получатель', 'получателя', 'получателей'), 'ok');
        history();
      } finally {
        el.disabled = false;
      }
      return;
    }

    if (act === 'ret-save') {
      await send('PUT', '/api/admin/retention', retValues(view));
      toast('Сроки сохранены', 'ok');
      return show();
    }

    if (act === 'ret-user') {
      await send('PUT', '/api/admin/users/' + id + '/retention', retValues(el.closest('[data-ret-box]')));
      toast('Сроки человека сохранены', 'ok');
      return;
    }

    if (act === 'stop-stream') {
      const reason = reasonOf(el);
      if (!await confirmDialog('Остановить эфир? Зрители и вещатель увидят это сразу.', { okText: 'Остановить' })) return;
      await send('POST', '/api/moderation/streams/' + id + '/stop', { reason });
      toast('Эфир остановлен', 'ok');
      return show();
    }

    if (act === 'ban') {
      // Причина обязательна и на сервере: спрашиваем здесь, а не после отказа.
      const reason = reasonOf(el);
      if (reason.length < 3) return toast('Впишите причину ограничения', 'error');
      if (!await confirmDialog('Ограничить? Вход останется, писать и вещать будет нельзя.', { okText: 'Ограничить' })) return;
      const r = await send('POST', '/api/moderation/users/' + id + '/ban', { reason });
      toast('Ограничен' + (r.streamsStopped ? ', эфир погашен' : ''), 'ok');
      return show();
    }

    if (act === 'unban') {
      if (!await confirmDialog('Снять ограничение?', { okText: 'Снять' })) return;
      await send('POST', '/api/moderation/users/' + id + '/unban');
      toast('Ограничение снято', 'ok');
      return show();
    }

    if (act === 'password') {
      const field = el.closest('[data-card]').querySelector('[data-password]');
      const password = field.value;
      if (password.length < 6) return toast('Пароль — не короче 6 символов', 'error');
      if (!await confirmDialog('Задать новый пароль? Открытые сеансы человека закроются, войти можно будет только с новым.', { okText: 'Сменить' })) return;
      const r = await send('POST', '/api/admin/users/' + id + '/password', { password });
      field.value = '';
      toast('Пароль сменён' + (r.sessions ? ', сеансов закрыто: ' + r.sessions : ''), 'ok');
      return show();
    }

    // «Заменить» в досье: дата рождения (по документу, только администратор)
    // и описание профиля — поле прямо в строке, «Сохранить» / «Отмена».
    if (act === 'fact-edit') {
      const dd = el.closest('dd');
      const birth = el.dataset.field === 'birthDate';
      dd.innerHTML = '<div class="tk-dcard__edit">' +
        (birth
          ? '<input type="date" class="tk-field" data-fact-input min="1900-01-01" max="' + new Date().toISOString().slice(0, 10) + '" value="' + esc(el.dataset.value) + '">'
          : '<textarea class="tk-field" data-fact-input maxlength="300" rows="4">' + esc(el.dataset.value) + '</textarea>') +
        '<span class="tk-dcard__edit-acts"><button type="button" class="tk-btn tk-btn--primary tk-btn--xs" data-act="fact-save" data-field="' + esc(el.dataset.field) + '" data-id="' + esc(id) + '">Сохранить</button>' +
        '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="fact-cancel">Отмена</button></span></div>';
      dd.querySelector('[data-fact-input]').focus();
      return;
    }

    if (act === 'fact-cancel') return show();

    if (act === 'fact-save') {
      const value = el.closest('dd').querySelector('[data-fact-input]').value;
      if (el.dataset.field === 'birthDate') {
        if (!value) return toast('Укажите дату', 'error');
        if (!await confirmDialog('Заменить дату рождения на ' + value + '? Делайте это только по документу.', { okText: 'Заменить' })) return;
        await send('POST', '/api/admin/users/' + id + '/birthdate', { birthDate: value });
        toast('Дата рождения заменена', 'ok');
      } else {
        await send('POST', '/api/admin/users/' + id + '/bio', { bio: value });
        toast(value.trim() ? 'Описание заменено' : 'Описание убрано', 'ok');
      }
      return show();
    }

    if (act === 'links-follow') {
      const on = !!el.dataset.on;
      if (!await confirmDialog(on ? 'Открыть ссылку на сайт поисковикам? Она будет без nofollow.' : 'Вернуть ссылке на сайт nofollow?', { okText: on ? 'Открыть' : 'Закрыть' })) return;
      await send('POST', '/api/admin/users/' + id + '/links-follow', { on });
      toast(on ? 'Ссылка на сайт индексируется' : 'Ссылка снова с nofollow', 'ok');
      return show();
    }

    if (act === 'kill-sessions') {
      if (!await confirmDialog('Закрыть все открытые сеансы? Человеку придётся войти заново.', { okText: 'Закрыть' })) return;
      const r = await send('POST', '/api/admin/users/' + id + '/sessions/kill');
      toast('Сеансов закрыто: ' + r.sessions, 'ok');
      return show();
    }

    if (act === 'user-delete') {
      if (!await confirmDialog('Удалить ' + el.dataset.name + ' насовсем? Уйдут эфиры, записи, заведения, переписка и подписки. Вернуть нельзя.', { okText: 'Удалить' })) return;
      await send('DELETE', '/api/admin/users/' + id);
      toast('Аккаунт удалён', 'ok');
      return go('people');
    }

    if (act === 'close-report') {
      await send('POST', '/api/moderation/reports/' + id + '/close', { status: el.dataset.status, action: reasonOf(el) });
      toast(el.dataset.status === 'resolved' ? 'Жалоба разобрана' : 'Жалоба отклонена', 'ok');
      return show();
    }

    if (act === 'error-resolve') {
      await send('POST', '/api/admin/errors/' + id + '/resolve', { resolved: el.dataset.resolved === '1' });
      return show();
    }

    if (act === 'recording-delete') {
      if (!await confirmDialog('Удалить запись? Файл уйдёт из хранилища навсегда.', { okText: 'Удалить' })) return;
      await send('DELETE', '/recording/' + id);
      toast('Запись удалена', 'ok');
      return show();
    }

    if (act === 'video-delete') {
      if (!await confirmDialog('Удалить видео? Файл уйдёт из хранилища навсегда.', { okText: 'Удалить' })) return;
      await send('DELETE', '/video/' + id);
      toast('Видео удалено', 'ok');
      return show();
    }

    if (act === 'photo-delete') {
      if (!await confirmDialog('Удалить фото? Файл уйдёт из хранилища навсегда.', { okText: 'Удалить' })) return;
      await send('DELETE', '/photo/' + id);
      toast('Фото удалено', 'ok');
      return show();
    }

    if (act === 'meetup-delete') {
      if (!await confirmDialog('Удалить отметку?', { okText: 'Удалить' })) return;
      await send('DELETE', '/meetups/' + id);
      toast('Отметка удалена', 'ok');
      return show();
    }

    if (act === 'comment-delete') {
      if (!await confirmDialog('Удалить комментарий?', { okText: 'Удалить' })) return;
      await send('DELETE', el.dataset.href + '/comments/' + id);
      toast('Комментарий удалён', 'ok');
      return show();
    }

    if (act === 'venue-save') {
      const card = el.closest('[data-card]');
      const body = {};
      card.querySelectorAll('[data-field]').forEach((f) => {
        const value = f.value.trim();
        if (value) body[f.dataset.field] = value;
      });
      // Тип, страна, город — всегда шестёркой: пустое своё стирает прежнее.
      ['type', 'country', 'city'].forEach((k) => {
        body[k] = body[k] || '';
        body[k + 'Other'] = body[k] === OTHER || !body[k] ? body[k + 'Other'] || '' : '';
      });
      // Точка уходит целиком или не уходит вовсе: половина координаты
      // бессмысленна, а пустой объект сервер понял бы как «стереть».
      if (body.lat && body.lng) body.location = { lat: Number(body.lat), lng: Number(body.lng) };
      delete body.lat; delete body.lng;

      await send('PUT', '/api/admin/venues/' + id, body);
      toast('Заведение сохранено', 'ok');
      return show();
    }

    if (act === 'venue-place') {
      const box = el.closest('[data-own]');
      const ru = box.querySelector('[data-own-ru]').value.trim();
      const en = box.querySelector('[data-own-en]').value.trim();
      if (!ru) return toast('Впишите название по-русски');
      const r = await send('POST', '/api/admin/venues/' + id + '/place', { kind: el.dataset.kind, ru, en });
      toast('Добавлено в список' + (r.venues > 1 ? ' — у заведений: ' + r.venues : ''), 'ok');
      // Справочник панели — из страницы: новый пункт появится в списках после перезагрузки.
      return location.reload();
    }

    if (act === 'venue-draft') {
      const accept = !!el.dataset.accept;
      if (!accept && !await confirmDialog('Отклонить правку? Новые фото из неё удалятся, в заведении останется прежнее.', { okText: 'Отклонить' })) return;
      await send('POST', '/api/admin/venues/' + id + '/pending', { accept });
      toast(accept ? 'Правка принята' : 'Правка отклонена', 'ok');
      return show();
    }

    if (act === 'venue-delete') {
      if (!await confirmDialog('Удалить заведение? Вместе с ним уйдут фотографии.', { okText: 'Удалить' })) return;
      await send('DELETE', '/api/admin/venues/' + id);
      toast('Заведение удалено', 'ok');
      return show();
    }
  } catch (err) {
    toast(err.message || 'Не получилось', 'error');
  }
});

// Очистка журнала и попыток — кнопка в шапке вкладки, рядом с фильтрами.
const CLEAR = {
  'audit-clear': { api: '/audit', some: 'Удалить из журнала все записи по текущему отбору?', all: 'Очистить весь журнал?' },
  'traces-clear': { api: '/traces', some: 'Удалить все попытки по текущему отбору?', all: 'Удалить все попытки?' },
};
viewTools.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  const c = btn && CLEAR[btn.dataset.act];
  if (!c) return;
  const params = serverParams(route().params);
  const filtered = Object.keys(params).length > 0;
  if (!await confirmDialog((filtered ? c.some : c.all) + ' Вернуть нельзя.', { okText: 'Очистить' })) return;
  try {
    const r = await send('DELETE', '/api/admin' + c.api + '?' + new URLSearchParams(params).toString());
    toast('Удалено записей: ' + num(r.rows), 'ok');
    show();
  } catch (err) {
    toast(err.message || 'Не получилось', 'error');
  }
});

// Правка поля карточки отпирает её «Сохранить».
view.addEventListener('input', (e) => {
  const field = e.target.closest('[data-field]');
  const card = field && field.closest('[data-card]');
  const save = card && card.querySelector('[data-act="venue-save"]');
  if (save) save.disabled = false;
});

view.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;

  try {
    if (el.dataset.act === 'venue-status') {
      await send('PUT', '/api/admin/venues/' + el.dataset.id + '/status', { status: el.checked });
      toast(el.checked ? 'Заведение активно' : 'Заведение выключено', 'ok');
    }

    if (el.dataset.act === 'sup-welcome') {
      await send('POST', '/api/admin/support/welcome', { on: el.checked });
      toast(el.checked ? 'Новичкам — приветствие' : 'Приветствие выключено', 'ok');
    }

    if (el.dataset.act === 'wm-frame') {
      if (el.checked && !await confirmDialog('Пережимать каждый эфир со знаком? При четырёх-пяти эфирах сразу сервер будет у предела процессора.', { okText: 'Включить' })) return show();
      await send('PUT', '/api/admin/watermark', { mode: el.checked ? 'frame' : 'overlay' });
      toast(el.checked ? 'Знак — в кадре, с новых эфиров' : 'Знак — поверх плеера, с новых эфиров', 'ok');
      return show();
    }

    if (el.dataset.act === 'role') {
      if (!await confirmDialog('Сменить роль? Это выдача прав, а не пометка.', { okText: 'Сменить' })) return show();
      await send('POST', '/api/moderation/users/' + el.dataset.id + '/role', { role: el.value });
      toast('Роль изменена', 'ok');
      return show();
    }
  } catch (err) {
    toast(err.message || 'Не получилось', 'error');
    show();
  }
});

// ── Фильтры: правка адреса ───────────────────────────────────────────────────
//
// Любой фильтр сбрасывает страницу на первую: остаться на седьмой странице
// выборки, которой больше нет, — верный способ увидеть пустоту вместо данных.
let typing = null;

viewTools.addEventListener('input', (e) => {
  const el = e.target.closest('[data-filter]');
  if (!el || el.type !== 'search') return;
  clearTimeout(typing);
  typing = setTimeout(() => applyFilter(el.dataset.filter, el.value.trim()), 350);
});

viewTools.addEventListener('change', (e) => {
  const el = e.target.closest('[data-filter]');
  if (!el || el.type === 'search') return;
  applyFilter(el.dataset.filter, el.value);
});

function applyFilter(name, value) {
  const { name: viewName, params } = route();
  go(viewName, { ...params, [name]: value, page: 1 });
}

window.addEventListener('hashchange', show);
show();
})();
