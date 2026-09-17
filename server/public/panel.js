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
const VENUE_TYPE = new Map((CATALOG.types || []).map((t) => [t.code, t.name]));
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

function chart(title, days, values, format) {
  const fmt = format || num;
  const max = Math.max(...values, 0);
  const total = values.reduce((a, b) => a + b, 0);
  const cols = values.map((v, i) =>
    '<div class="tk-chart__col" data-tip="' + esc(dayLabel(days[i]) + ' — ' + fmt(v)) + '">' +
      (v ? '<i style="height:' + Math.max(2, (v / max) * 100).toFixed(1) + '%"></i>' : '') +
    '</div>').join('');

  const mid = Math.floor(days.length / 2);
  return '<figure class="tk-chart">' +
    '<figcaption class="tk-chart__head"><span class="tk-chart__title">' + esc(title) + '</span>' +
      '<span class="tk-chart__total">' + esc('за период ' + fmt(Math.round(total * 10) / 10) + ' · сегодня ' + fmt(values[values.length - 1] || 0)) + '</span></figcaption>' +
    '<div class="tk-chart__plot" role="img" aria-label="' + esc(title + ': за период ' + fmt(total) + ', максимум за день ' + fmt(max)) + '">' +
      '<span class="tk-chart__max">' + esc(max ? fmt(max) : '') + '</span>' +
      '<div class="tk-chart__bars">' + cols + '</div>' +
    '</div>' +
    '<div class="tk-chart__axis"><span>' + dayLabel(days[0]) + '</span><span>' + dayLabel(days[mid]) + '</span><span>' + dayLabel(days[days.length - 1]) + '</span></div>' +
  '</figure>';
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
    '<td>' + esc(s.title || 'без названия') + (s.isAdult ? '<span class="tk-tag tk-tag--bad">18+</span>' : '') +
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

    html += '<div class="tk-dossier__cols"><section><h2 class="tk-panel__h2">Учётная запись</h2><dl class="tk-facts">';
    const fact = (k, v) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>';
    html += fact('Идентификатор', '<code>' + esc(p.id) + '</code>');
    if (a.email) html += fact('Почта', esc(a.email));
    html += fact('Вход', esc(a.provider === 'google' ? 'через Google' : 'по паролю'));
    html += fact('Заведён', esc(when(p.createdAt)));
    html += fact('Был на связи', esc(p.isOnline ? 'сейчас' : ago(p.lastSeen)));
    html += fact('Подтвердил 18+', a.adultConfirmedAt ? esc(when(a.adultConfirmedAt)) : 'нет');
    html += fact('Ключ вещания', a.hasStreamKey ? 'есть' : 'нет');
    html += fact('Фото в галерее', num(a.gallery));
    if (IS_ADMIN) html += fact('Открытых сеансов', num(a.sessions) + (a.sessionUntil ? ' <span class="tk-panel__why">до ' + esc(when(a.sessionUntil)) + '</span>' : ''));
    html += fact('Веб / OBS', num(d.streams.web) + ' / ' + num(d.streams.obs));
    html += '</dl></section>';

    html += '<section><h2 class="tk-panel__h2">Заведения</h2>';
    html += d.venues.length
      ? '<ul class="tk-list">' + d.venues.map((v) => '<li>' + (v.online ? dot(true) : '') + esc(v.name || 'без названия') +
          ' <span class="tk-panel__why">' + esc(cityTitle(v.city)) + ' · ' + esc(VENUE_TYPE.get(v.type) || v.type || '') +
          (v.status ? '' : ' · не активно') + '</span></li>').join('') + '</ul>'
      : note('Заведений нет');
    html += '</section></div>';

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
const TARGETS = { stream: 'эфир', user: 'пользователь', message: 'сообщение чата' };

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
const VENUE_FIELDS = [
  { key: 'name', label: 'Название', wide: true },
  { key: 'type', label: 'Тип', list: VENUE_TYPE },
  { key: 'city', label: 'Город', list: CITY },
  { key: 'country', label: 'Страна' },
  { key: 'address', label: 'Адрес', wide: true },
  { key: 'email', label: 'Почта', type: 'email' },
  { key: 'phone', label: 'Телефон', type: 'tel' },
  { key: 'lat', label: 'Широта' },
  { key: 'lng', label: 'Долгота' },
];

VIEWS.venues = {
  title: 'Заведения',
  admin: true,
  api: '/venues',
  csv: true,
  filters: [
    { name: 'q', type: 'search', placeholder: 'Название или адрес' },
    { name: 'status', options: [{ value: '', title: 'Все' }, { value: 'active', title: 'Активные' }, { value: 'inactive', title: 'Неактивные' }] },
    { name: 'city', options: () => [{ value: '', title: 'Любой город' }].concat((CATALOG.cities || []).map((c) => ({ value: c.code, title: c.name }))) },
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
        if (f.list) {
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
        '<div class="tk-fields">' + fields + '</div>' +
        '<div class="tk-card__acts">' +
          // Заперта, пока ничего не правили: иначе «Сохранить» нажимают
          // по привычке и шлют на сервер карточку без изменений.
          '<button type="button" class="tk-btn tk-btn--primary tk-btn--xs" data-act="venue-save" data-id="' + esc(v.id) + '" disabled>Сохранить</button>' +
          '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-act="venue-delete" data-id="' + esc(v.id) + '">Удалить</button>' +
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
const SCOPES = { server: 'сервер', client: 'браузер', media: 'медиа', external: 'внешние' };

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
    { name: 'scope', options: [{ value: '', title: 'Везде' }].concat(
      Object.entries(SCOPES).map(([value, title]) => ({ value, title }))) },
    { name: 'resolved', options: [
      { value: '', title: 'Неразобранные' }, { value: '1', title: 'Разобранные' }, { value: 'all', title: 'Все' },
    ] },
    { name: 'period', options: PERIOD },
  ],
  sub: (d) => Object.entries(d.byScope).map(([k, v]) => (SCOPES[k] || k) + ': ' + v.groups).join(' · ') || 'ошибок нет',
  render2(d) {
    if (!d.items.length) return note('Ошибок нет — или все разобраны');

    return '<div class="tk-cards tk-cards--wide">' + d.items.map((e) => { const more = errorMore(e); return (
      '<article class="tk-card tk-card--error' + (e.resolved ? ' is-done' : '') + '" data-card="' + esc(e.id) + '">' +
        '<div class="tk-card__head">' +
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
    html += tile('Звонки', num(d.daily.callMinutes) + ' мин', num(d.daily.calls) + ' разговоров, по двое');
    html += tile('Веб-эфиры', num(d.daily.streamMinutes) + ' мин', num(d.daily.webStreams) + ' эфиров: ведущий и выход в HLS');
    html += tile('Всего', num(d.daily.callMinutes + d.daily.streamMinutes) + ' мин', 'за ' + d.days + ' дней');
    html += tile('Камеры заведений', num(d.daily.venueSwitchOns), 'включений — минуты знает только Daily');
    html += '</div>';

    html += '<h2 class="tk-panel__h2">Bunny — хранение записей</h2><div class="tk-tiles">';
    html += tile('Лежит сейчас', bytes(d.bunny.storedBytes), num(d.bunny.storedCount) + ' записей');
    html += tile('Добавилось', bytes(d.bunny.addedBytes), num(d.bunny.addedCount) + ' записей за ' + d.days + ' дней');
    html += tile('Трафик', '—', 'знает только Bunny');
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
        html += tile(KIND[k] || k, num(v.minutes) + ' мин', num(v.meetings) + ' встреч, до ' + v.peak + ' участников');
      });
      html += '</div>';
      if (!d.daily.complete) html += '<p class="tk-panel__why">Встреч больше пяти тысяч — посчитаны не все, сузьте период.</p>';
      html += '<p class="tk-panel__why">Daily считает всё время участника в комнате, включая дозвон и подключение, — поэтому его минуты больше нашей оценки по состоявшимся разговорам. Счёт идёт по Daily, его цифра — та, что в счёте.</p>';
    }

    if (!d.bunny.configured) html += note('Bunny: ключ аккаунта (BUNNY_API_KEY) не задан — трафик и деньги неизвестны');
    else if (d.bunny.error) html += note('Bunny не ответил: ' + d.bunny.error);
    else {
      html += '<div class="tk-tiles">';
      html += tile('Трафик Bunny', bytes(d.bunny.bandwidthBytes), num(d.bunny.requests) + ' запросов' +
        (d.bunny.cacheHitRate != null ? ', из кэша ' + d.bunny.cacheHitRate + '%' : ''));
      if (d.bunny.storage) html += tile('Хранилище Bunny', bytes(d.bunny.storage.bytes), num(d.bunny.storage.files) + ' файлов');
      if (d.bunny.spentUsd != null) html += tile('Списано Bunny', '$' + d.bunny.spentUsd, 'на счёте $' + d.bunny.balanceUsd);
      html += '</div>';
    }

    const at = d.daily.cachedAt || d.bunny.cachedAt;
    if (at) html += '<p class="tk-panel__why">Данные на ' + esc(when(at)) + ', обновляются не чаще раза в 10 минут.</p>';
    box.innerHTML = html;
  },
};

// ── Система ──────────────────────────────────────────────────────────────────
VIEWS.system = {
  title: 'Система',
  admin: true,
  async render() {
    const d = await api('/system');

    let html = '<div class="tk-tiles">';
    html += tile('Процесс живёт', dur(d.process.uptime), 'Node ' + esc(d.process.node) + ', режим ' + esc(d.process.mode));
    html += tile('Память', bytes(d.process.rss), 'куча ' + bytes(d.process.heap));
    html += tile('База', d.db.state === 'connected' ? 'на связи' : 'недоступна', esc(d.db.name));
    html += tile('Открытых сеансов', num(d.db.sessions), 'в коллекции сессий');
    if (d.disk) {
      const share = Math.round((1 - d.disk.free / d.disk.total) * 100);
      html += tile('Свободно на диске', bytes(d.disk.free), 'занято ' + share + '% из ' + bytes(d.disk.total) + ' — сюда пишутся эфиры');
    }
    html += '</div>';

    html += '<div class="tk-dossier__cols"><section><h2 class="tk-panel__h2">Что в базе</h2><dl class="tk-facts">' +
      d.db.collections.map((c) => '<dt>' + esc(c.title) + '</dt><dd>' + num(c.count) + '</dd>').join('') +
      '</dl></section>';

    html += '<section><h2 class="tk-panel__h2">Настройки окружения</h2><dl class="tk-facts">' +
      d.env.map((e) => '<dt>' + esc(e.title) + '</dt><dd data-env="' + esc(e.key) + '">' + (e.set
        ? '<span class="tk-tag tk-tag--on">задана</span>'
        : '<span class="tk-tag tk-tag--bad">не задана</span>') + '</dd>').join('') +
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

const ORDER = ['summary', 'live', 'streams', 'people', 'reports', 'venues', 'recordings', 'audit', 'errors', 'costs', 'system'];

function drawNav(active) {
  nav.innerHTML = ORDER.filter((name) => !VIEWS[name].admin || IS_ADMIN).map((name) => {
    const v = VIEWS[name];
    const on = name === active || (active === 'person' && name === 'people');
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
  viewTools.innerHTML = filtersHtml(v.filters, params) +
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

  if (v.refresh) timer = setInterval(() => { if (!document.hidden) show(); }, v.refresh);
  badges();
}

// Счётчик новых жалоб виден со всех вкладок: это единственное, что требует
// внимания сразу, а не когда откроют нужный раздел.
async function badges() {
  try {
    const d = await api('/summary');
    const badge = nav.querySelector('[data-badge="reports"]');
    if (badge) {
      badge.textContent = d.reports.new ? String(d.reports.new) : '';
      badge.hidden = !d.reports.new;
    }
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

    if (act === 'venue-save') {
      const card = el.closest('[data-card]');
      const body = {};
      card.querySelectorAll('[data-field]').forEach((f) => {
        const value = f.value.trim();
        if (value) body[f.dataset.field] = value;
      });
      // Точка уходит целиком или не уходит вовсе: половина координаты
      // бессмысленна, а пустой объект сервер понял бы как «стереть».
      if (body.lat && body.lng) body.location = { lat: Number(body.lat), lng: Number(body.lng) };
      delete body.lat; delete body.lng;

      await send('PUT', '/api/admin/venues/' + id, body);
      toast('Заведение сохранено', 'ok');
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

// Очистка журнала — кнопка в шапке вкладки, рядом с фильтрами.
viewTools.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-act="audit-clear"]')) return;
  const params = serverParams(route().params);
  const filtered = Object.keys(params).length > 0;
  if (!await confirmDialog(filtered
    ? 'Удалить из журнала все записи по текущему отбору? Вернуть нельзя.'
    : 'Очистить весь журнал? Вернуть нельзя.', { okText: 'Очистить' })) return;
  try {
    const r = await send('DELETE', '/api/admin/audit?' + new URLSearchParams(params).toString());
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
