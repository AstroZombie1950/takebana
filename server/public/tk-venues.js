// Раздел «Заведения» /venues (29.09): вид «Список и карта / Список / Карта»,
// поиск и фильтры, связь карточек с метками. Разметка — views/venues.ejs,
// карточки рисует сервер (views/partials/venueCard.ejs) — и при смене
// фильтров тоже, фрагментом /venues/cards. Карта — tk-map.js, вёрстка —
// css/venues.css, решения — docs/VENUES.md.
//
// До 29.09 здесь была «Карта заведений» /map: узкая панель, поиск выпадашкой
// и карточка поверх карты. Оценка из той карточки переехала на страницу
// заведения (public/tk-venue.js).
(function () {
  const $ = (id) => document.getElementById(id);
  // Подписи — из общего словаря (public/tk-i18n.js); он подключён шапкой
  // кабинета, то есть до этого файла.
  const t = (key, arg) => (window.t ? window.t(key, arg) : '');
  const tkText = (el, key, vars) => (window.tkText ? window.tkText(el, key, vars) : undefined);

  const root = $('venues');
  const form = $('venueFilters');
  const query = $('venueQuery');
  const clear = $('venueClear');
  const reset = form.querySelector('[data-reset]');
  const list = root.querySelector('.tk-venues__list');
  const cardsEl = $('venueCards');
  const countEl = $('venueCount');
  const empty = $('venueEmpty');
  const emptyNote = $('venueEmptyNote');
  const showAll = $('venueShowAll');
  const mapEl = $('venueMap');
  const follow = $('venueFollow');
  const fab = $('venueFab');
  const wide = matchMedia('(min-width: 1024px)');
  const phone = matchMedia('(max-width: 639px)');

  // «Показать» нужна только без скрипта: здесь фильтр применяется сразу.
  form.querySelectorAll('[data-nojs]').forEach((el) => el.remove());

  // ── Страна, потом город (30.09) ──
  // В списке городов — только города выбранной страны; без страны он заперт.
  // Пункты всех стран сервер кладёт разом, здесь они переставляются.
  const country = $('venueCountry');
  const city = $('venueCity');
  const cityOpts = Array.from(city.options).filter((o) => o.dataset.country);

  function fillCities() {
    const c = country.value;
    const keep = city.value;
    cityOpts.forEach((o) => o.remove());
    const mine = cityOpts.filter((o) => o.dataset.country === c);
    mine.forEach((o) => city.append(o));
    if (!mine.some((o) => o.value === keep)) city.value = '';
    city.disabled = !c || !mine.length;
  }
  country.addEventListener('change', fillCities);
  fillCities();

  // ── Выпадашка с галочками ──
  // Тип заведения; на телефоне в неё же ложатся «В эфире» и «Открыто сейчас»
  // («Фильтры»), на широком они метками рядом. Подпись — что выбрано.
  const more = $('venueMore');
  const morePanel = $('venueMorePanel');
  const moreVal = $('venueMoreVal');
  const flags = $('venueFlags');
  const flagsHome = flags.nextElementSibling;

  function placeFlags() {
    if (phone.matches) morePanel.append(flags);
    else form.querySelector('.tk-venues__filters').insertBefore(flags, flagsHome);
    paintMore();
  }

  function paintMore() {
    const types = Array.from(morePanel.querySelectorAll('[name="type"]:checked'), (b) => b.nextElementSibling.textContent.trim());
    const extra = phone.matches ? flags.querySelectorAll(':checked').length : 0;
    const n = types.length + extra;
    moreVal.removeAttribute('data-i18n');
    moreVal.removeAttribute('data-i18n-vars');
    if (!n) tkText(moreVal, 'venues.anyType');
    else if (!extra && n <= 2) moreVal.textContent = types.join(', ');
    else tkText(moreVal, 'venues.picked', { n });
  }

  phone.addEventListener('change', placeFlags);
  placeFlags();
  // Мимо и Escape — закрыть; галочки внутри — нет: выбирают несколько.
  document.addEventListener('click', (e) => { if (more.open && !more.contains(e.target)) more.open = false; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && more.open) { more.open = false; more.querySelector('summary').focus(); }
  });

  // Форма слова по числу: plural(5, 'venues.count') → ключ venues.countMany.
  function plural(n, base) {
    const d10 = n % 10, d100 = n % 100;
    return base + (d10 === 1 && d100 !== 11 ? 'One' : d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14) ? 'Few' : 'Many');
  }

  // ── Карточки ──
  // Точки карты — из самих карточек: сервер отдаёт их один раз, разметкой.
  let cards = [];

  function readCards() {
    cards = Array.from(cardsEl.querySelectorAll('.tk-vc'), (el) => {
      const lat = parseFloat(el.dataset.lat), lng = parseFloat(el.dataset.lng);
      return {
        el, id: el.dataset.id, name: el.dataset.name, photo: el.dataset.pin || '',
        lat, lng, has: Number.isFinite(lat) && Number.isFinite(lng),
        online: el.classList.contains('is-live'),
      };
    });
    if (map) map.setPoints(points());
  }

  const points = () => cards.filter((c) => c.has)
    .map((c) => ({ id: c.id, lng: c.lng, lat: c.lat, name: c.name, photo: c.photo, online: c.online }));
  const cardOf = (id) => cards.find((c) => c.id === id);

  // ── Вид ──
  // Выбор помним отдельно для широкого и узкого экрана: «Карта» на телефоне
  // не значит, что и на компьютере человек хочет карту без списка.
  const viewKey = () => 'tk.venues.view.' + (wide.matches ? 'wide' : 'narrow');
  const view = () => root.dataset.view;

  function storedView() {
    let v = null;
    try { v = localStorage.getItem(viewKey()); } catch (e) {}
    if (v === 'list' || v === 'map' || (v === 'split' && wide.matches)) return v;
    return wide.matches ? 'split' : 'list';
  }

  // later — первый показ страницы: карта рядом со списком ждёт, пока
  // страница дорисуется (ensureMapLater).
  function setView(v, remember, later) {
    if (v === 'split' && !wide.matches) v = 'list';
    root.dataset.view = v;
    root.querySelectorAll('[data-set-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.setView === v)));
    tkText(fab, v === 'map' ? 'venues.viewList' : 'venues.viewMap');
    if (remember) {
      try { localStorage.setItem(viewKey(), v); } catch (e) {}
    }
    if (v === 'split' && later) ensureMapLater();
    else if (v !== 'list') ensureMap();
    refresh();
  }

  root.querySelectorAll('[data-set-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.setView, true)));
  fab.addEventListener('click', () => setView(view() === 'map' ? 'list' : 'map', true));
  wide.addEventListener('change', () => setView(storedView(), false));

  // ── Карта ──
  // Поднимается, когда её впервые показывают: MapLibre — около 290 КБ,
  // а телефону в списке карта не нужна вовсе.
  const FOCUS_ZOOM = 15;
  let map = null;
  let mounting = null;
  let bounds = null;

  const tip = document.createElement('div');
  tip.className = 'tk-venues__tip';
  tip.hidden = true;
  mapEl.append(tip);

  // Стили MapLibre — вместе с картой, не в <head>: в виде «Список» они
  // не нужны, а в <head> задерживали отрисовку всей страницы.
  function mapStyles() {
    return new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/vendor/maplibre-gl-6.9.0/maplibre-gl.css';
      link.onload = resolve;
      link.onerror = reject;
      document.head.append(link);
    });
  }

  function ensureMap() {
    if (mounting) return mounting;
    mounting = mapStyles().then(() => TKMap.mount(mapEl)).then((m) => {
      map = m;
      m.setPoints(points());
      m.on('move', (b) => { bounds = b; refresh(); });
      m.on('click', pick);
      m.on('hover', (id, at) => {
        const c = id && cardOf(id);
        tip.hidden = !c;
        mark(c ? id : null, 'is-hot');
        if (!c) return;
        tip.textContent = c.name;
        tip.style.left = at.x + 'px';
        tip.style.top = at.y + 'px';
      });
      // Выбранное (?venue= или «На карте» до загрузки) карта покажет сама;
      // иначе — все найденные разом, чтобы список не начинался с пустоты.
      if (sel) {
        const c = cardOf(sel);
        m.mark(sel, 'sel');
        if (c && c.has) m.flyTo(c.lng, c.lat, FOCUS_ZOOM);
      } else {
        fitAll();
      }
      return m;
    }).catch((e) => {
      console.error('Карта не загрузилась:', e);
      toast(t('venues.mapFailed'), 'error');
      mounting = null;
    });
    return mounting;
  }

  // Рядом со списком карта не главное: поднимаем её, когда страница
  // дорисовалась и браузер свободен. MapLibre разбирается и заводит WebGL
  // около секунды, и всё это время список не отвечал (PageSpeed 04.10:
  // TBT 1,27 с на компьютере — docs/seo, задача 43). Вид «Карта», кнопка
  // и «На карте» поднимают её сразу.
  function ensureMapLater() {
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
    const go = () => idle(() => ensureMap(), { timeout: 3000 });
    if (document.readyState === 'complete') go();
    else addEventListener('load', go, { once: true });
  }

  function fitAll() {
    const p = points();
    if (map && p.length) map.fit(p);
  }

  // Список следует за картой, когда они рядом и ничего не ищут: запрос ищет
  // по всему городу, а карта сама подстраивается под найденное.
  const scoped = () => view() === 'split' && follow.checked && !query.value.trim() && !!bounds;
  const inView = (c) => c.has && c.lat >= bounds.south && c.lat <= bounds.north && c.lng >= bounds.west && c.lng <= bounds.east;

  function refresh() {
    const only = scoped();
    let n = 0;
    cards.forEach((c) => {
      const show = !only || inView(c);
      c.el.hidden = !show;
      if (show) n++;
    });

    const q = query.value.trim();
    tkText(countEl.firstElementChild, plural(n, 'venues.count'), { n });
    const scope = countEl.lastElementChild;
    // Город или страна — подписью пункта: у добавленных панелью ключа
    // словаря нет, текст уже на языке страницы.
    const where = city.value ? city : country.value ? country : null;
    const opt = where && where.options[where.selectedIndex];
    if (only) tkText(scope, 'venues.scopeView');
    else if (q) tkText(scope, 'venues.scopeQuery', { q });
    else if (opt && opt.dataset.i18n) tkText(scope, opt.dataset.i18n);
    else if (opt) { scope.removeAttribute('data-i18n'); scope.textContent = opt.textContent; }
    else tkText(scope, 'common.allCities');

    empty.hidden = n > 0;
    const offscreen = only && cards.length > 0;
    showAll.hidden = !offscreen;
    tkText(emptyNote, offscreen ? 'venues.emptyView' : 'venues.emptyFilter');
  }

  follow.addEventListener('change', refresh);
  showAll.addEventListener('click', fitAll);

  // ── Карточка ↔ метка ──
  let sel = null;

  function mark(id, cls) {
    cardsEl.querySelectorAll('.tk-vc.' + cls).forEach((el) => el.classList.remove(cls));
    const c = id && cardOf(id);
    if (c) c.el.classList.add(cls);
  }

  function select(id) {
    sel = id;
    mark(id, 'is-sel');
    if (map) map.mark(id, 'sel');
  }

  // «На карте» у карточки: к точке на уровень квартала — соседи остаются
  // видны, и список рядом не сжимается до одной карточки. Из вида «Список» — на
  // карту: на широком экране рядом со списком, на узком — во весь экран.
  function focus(id) {
    const c = cardOf(id);
    if (!c || !c.has) return;
    select(id);
    if (view() === 'list') setView(wide.matches ? 'split' : 'map', false);
    ensureMap().then((m) => {
      if (!m) return;
      m.flyTo(c.lng, c.lat, FOCUS_ZOOM);
      if (view() === 'map') scrollToCard(c);
    });
  }

  // Нажали метку — карточку на глаза: в списке прокруткой и вспышкой,
  // в виде «Карта» — лентой внизу.
  function pick(id) {
    const c = cardOf(id);
    if (!c) return;
    select(id);
    if (view() === 'map') return scrollToCard(c);
    c.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    c.el.classList.remove('is-flash');
    void c.el.offsetWidth; // вспышка заново, даже если та же карточка
    c.el.classList.add('is-flash');
  }

  // Лента в виде «Карта»: листнули — карта за карточкой; сами подвинули
  // ленту к метке — её прокрутку за выбор не считаем.
  let steering = false;
  let steerTimer = null;
  let swipeTimer = null;

  function scrollToCard(c) {
    steering = true;
    cardsEl.scrollTo({ left: c.el.offsetLeft - (cardsEl.clientWidth - c.el.offsetWidth) / 2, behavior: 'smooth' });
    clearTimeout(steerTimer);
    steerTimer = setTimeout(() => { steering = false; }, 700);
  }

  cardsEl.addEventListener('scroll', () => {
    if (view() !== 'map' || steering) return;
    clearTimeout(swipeTimer);
    swipeTimer = setTimeout(() => {
      const mid = cardsEl.scrollLeft + cardsEl.clientWidth / 2;
      let best = null, gap = Infinity;
      cards.forEach((c) => {
        const d = Math.abs(c.el.offsetLeft + c.el.offsetWidth / 2 - mid);
        if (d < gap) { gap = d; best = c; }
      });
      if (!best || best.id === sel) return;
      select(best.id);
      if (map && best.has) map.panTo(best.lng, best.lat);
    }, 150);
  }, { passive: true });

  cardsEl.addEventListener('click', (e) => {
    const show = e.target.closest('[data-show]');
    if (show) return focus(show.closest('.tk-vc').dataset.id);
    // В ленте карточка целиком — выбор; ссылки по-прежнему ведут на страницу.
    const el = view() === 'map' && !e.target.closest('a') && e.target.closest('.tk-vc');
    if (!el) return;
    const c = cardOf(el.dataset.id);
    select(c.id);
    scrollToCard(c);
    if (map && c.has) map.panTo(c.lng, c.lat);
  });

  cardsEl.addEventListener('mouseover', (e) => {
    const el = e.target.closest('.tk-vc');
    if (map) map.mark(el ? el.dataset.id : null, 'hot');
  });
  cardsEl.addEventListener('mouseleave', () => { if (map) map.mark(null, 'hot'); });

  // ── Поиск и фильтры ──
  // Карточки под новые фильтры рисует сервер — тем же шаблоном, что страницу.
  // Нажали три фильтра подряд — нужен ответ на последний, а не на тот, что
  // пришёл позже остальных.
  let loading = null;
  let typing = null;

  function params() {
    const p = new URLSearchParams();
    new FormData(form).forEach((value, key) => {
      if (value && !(key === 'sort' && value === 'live')) p.append(key, value);
    });
    return p.toString();
  }

  // refit — показать на карте всех найденных: после запроса и смены города.
  function apply(refit) {
    const qs = params();
    history.replaceState(null, '', '/venues' + (qs ? '?' + qs : ''));
    reset.hidden = !qs;
    clear.hidden = !query.value;
    if (loading) loading.abort();
    const ctrl = loading = new AbortController();
    root.classList.add('is-loading');
    tkFetch('/venues/cards' + (qs ? '?' + qs : ''), { signal: ctrl.signal, headers: { 'X-TK-Fragment': '1' } })
      .then((r) => {
        if (!r.ok) throw new Error(t('common.failedCode', { code: r.status }));
        return r.text();
      })
      .then((html) => {
        cardsEl.innerHTML = html;
        list.scrollTop = 0;
        readCards();
        select(sel && cardOf(sel) ? sel : null);
        if (refit) fitAll();
        refresh();
      })
      .catch((e) => { if (e.name !== 'AbortError') toast(e.message, 'error'); })
      .finally(() => { if (loading === ctrl) root.classList.remove('is-loading'); });
  }

  form.addEventListener('change', (e) => {
    if (e.target === query) return;
    if (morePanel.contains(e.target)) paintMore();
    apply(e.target.name === 'city' || e.target.name === 'country');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(typing);
    apply(true);
  });
  query.addEventListener('input', () => {
    clear.hidden = !query.value;
    clearTimeout(typing);
    typing = setTimeout(() => apply(true), 300);
  });
  query.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && query.value) {
      query.value = '';
      apply(true);
    }
  });
  clear.addEventListener('click', () => {
    query.value = '';
    apply(true);
    query.focus();
  });
  reset.addEventListener('click', (e) => {
    e.preventDefault();
    query.value = '';
    country.value = '';
    fillCities();
    form.elements.sort.value = 'live';
    form.querySelectorAll('input[type="checkbox"]').forEach((box) => { box.checked = false; });
    paintMore();
    apply(true);
  });

  // ── Начало ──
  // ?venue=<id> — ссылка «Показать на карте» со страницы заведения и камеры.
  readCards();
  setView(view() || storedView(), false, true);
  const wanted = new URLSearchParams(location.search).get('venue');
  if (wanted && cardOf(wanted)) focus(wanted);

  // Для зондов (temp/): карта и выбор без щелчков.
  window.TKVenues = { focus, setView, get map() { return map; } };
})();
