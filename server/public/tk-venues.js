// Карта заведений (/map): фильтры, список, поиск, карточка, оценка, камера
// заведения, список своих заведений. Разметка — views/map.ejs, карта —
// tk-map.js. Правка и пульт владельца — на странице заведения
// (/venue/:id, public/tk-venue-edit.js, с 29.09).
//
// Заменяет main.js и service.js (900 и 500 строк на jQuery с тремя плагинами):
// карточка заведения заполнялась там двумя копиями кода — по щелчку на карте
// и из поиска, — а данные собирались тремя запросами.
(function () {
  const dict = window.TKVenueDict || { types: {}, cities: {} };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => escapeHtml(s == null ? '' : String(s));
  // Подписи — из общего словаря (public/tk-i18n.js); он подключён шапкой
  // кабинета, то есть до этого файла.
  const t = (key, arg) => (window.t ? window.t(key, arg) : '');
  const tkText = (el, key, vars) => (window.tkText ? window.tkText(el, key, vars) : undefined);

  const label = (kind, code, fallback) => (code ? t(kind + '.' + code, fallback || '') : '');
  const typeCity = (v) => [label('venue', v.type, dict.types[v.type]),
                           label('city', v.city, dict.cities[v.city])].filter(Boolean).join(' · ');

  function initial(name) {
    const m = String(name || '').match(/[\p{L}\p{N}]/u);
    return m ? m[0].toUpperCase() : '•';
  }

  function plural(n, one, few, many) {
    const d10 = n % 10, d100 = n % 100;
    if (d10 === 1 && d100 !== 11) return one;
    if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return few;
    return many;
  }

  // Гость смотрит карту и камеры (с 28.09), а оценку ставит после входа:
  // туда и отправляем, с возвратом на эту же карту. true — ушли на вход.
  function needLogin() {
    if (window.TK && window.TK.userId) return false;
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    return true;
  }

  // Ответ с ошибкой — исключение с текстом сервера: его и показываем.
  function api(url, opts) {
    return fetch(url, opts).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.message || 'HTTP ' + r.status);
      return body;
    });
  }

  // ── Окна ──
  const modals = ['venuePhotoModal', 'myVenuesModal'].map($).filter(Boolean);

  function openModal(m) { m.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
  function closeModal(m) {
    if (m.classList.contains('hidden')) return;
    m.classList.add('hidden');
    if (!modals.some((x) => !x.classList.contains('hidden'))) document.body.style.overflow = '';
  }

  modals.forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) closeModal(m);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = modals.filter((m) => !m.classList.contains('hidden')).pop();
    if (open) closeModal(open);
    else hideCard();
  });

  // ── Фильтры ──
  const form = $('venueFilters');
  const reset = form.querySelector('[data-reset]');
  form.querySelector('[type="submit"]').remove();

  function filterParams() {
    const p = new URLSearchParams();
    new FormData(form).forEach((value, key) => { if (value) p.append(key, value); });
    return p;
  }

  function applyFilters() {
    const p = filterParams();
    history.replaceState(null, '', '/map' + (p.toString() ? '?' + p : ''));
    reset.hidden = !p.toString();
    loadVenues();
  }

  form.addEventListener('change', applyFilters);
  form.addEventListener('submit', (e) => { e.preventDefault(); applyFilters(); });
  reset.addEventListener('click', (e) => {
    e.preventDefault();
    form.elements.city.value = '';
    form.querySelectorAll('input[type="checkbox"]').forEach((box) => { box.checked = false; });
    applyFilters();
  });

  // ── Карта и точки ──
  const mapEl = $('venueMap');
  let map = null;
  let bounds = null;
  let venues = [];
  let pending = null;

  const venueParam = new URLSearchParams(location.search).get('venue') || '';

  const tip = document.createElement('div');
  tip.className = 'tk-venues__tip';
  tip.hidden = true;
  mapEl.append(tip);

  TKMap.mount(mapEl).then((m) => {
    map = m;
    m.on('move', (b) => { bounds = b; loadVenues(); });
    m.on('click', openCard);
    m.on('hover', (id, at) => {
      const v = id && venues.find((x) => x._id === id);
      tip.hidden = !v;
      if (!v) return;
      tip.textContent = v.name;
      tip.style.left = at.x + 'px';
      tip.style.top = at.y + 'px';
    });
    // Ссылка на конкретное заведение — /map?venue=<id>: так на карту ведут
    // результаты поиска по сайту. Тогда карта летит к нему, а не к посетителю.
    const wanted = /^[a-f\d]{24}$/i.test(venueParam) ? venueParam : '';
    if (wanted) {
      api('/api/venues/' + wanted).then((v) => {
        if (v.location && Number.isFinite(v.location.lat)) focusVenue(v);
        openCard(wanted);
      }).catch(() => {});
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((p) => m.flyTo(p.coords.longitude, p.coords.latitude, 12));
    }
  }).catch((e) => {
    console.error('Карта не загрузилась:', e);
    toast(t('venues.mapFailed'), 'error');
  });

  // Точки — по видимой части карты и фильтрам. Щёлкнули три тега подряд —
  // нужен ответ на последний, а не на тот, что пришёл позже остальных.
  function loadVenues() {
    if (!map || !bounds) return;
    const p = filterParams();
    p.set('bl_lat', bounds.south);
    p.set('bl_lng', bounds.west);
    p.set('tr_lat', bounds.north);
    p.set('tr_lng', bounds.east);
    if (pending) pending.abort();
    const ctrl = pending = new AbortController();
    fetch('/establishmentsLocation?' + p, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((list) => {
        venues = list;
        map.setPoints(list.map((v) => ({
          id: v._id, lng: v.location.lng, lat: v.location.lat, name: v.name, photo: v.photos[0], online: v.online,
        })));
        renderList(list);
      })
      .catch((e) => { if (e.name !== 'AbortError') console.error('Заведения не загрузились:', e); });
  }

  // Точка — в середину свободной части карты: на десктопе справа её
  // закрывает карточка, на телефоне карточка выезжает снизу.
  function focusVenue(v) {
    const padding = innerWidth >= 1024 ? { right: 412 } : { bottom: Math.round(innerHeight * 0.55) };
    map.flyTo(v.location.lng, v.location.lat, 15, padding);
  }

  // ── Список в панели ──
  const list = $('venueList');

  function pic(v) {
    return v.photos && v.photos[0]
      ? `<img src="${esc(v.photos[0])}" alt="" loading="lazy">`
      : esc(initial(v.name));
  }

  function renderList(items) {
    // Сначала те, где идёт камера, — ради них на карту и заходят.
    const sorted = items.slice().sort((a, b) => (b.online === true) - (a.online === true));
    list.replaceChildren(...sorted.map((v) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <button type="button" class="tk-vrow${v.online ? ' is-live' : ''}">
          <span class="tk-vrow__pic">${pic(v)}</span>
          <span class="tk-vrow__body">
            <span class="tk-vrow__name">${esc(v.name)}</span>
            <span class="tk-vrow__meta">${esc(typeCity(v))}</span>
          </span>
          ${v.online ? `<span class="tk-vrow__live"><i class="tk-venues__dot"></i>${esc(t('venues.onAir'))}</span>` : ''}
        </button>`;
      li.firstElementChild.addEventListener('click', () => {
        focusVenue(v);
        openCard(v._id);
        panel.classList.remove('is-open');
      });
      return li;
    }));
    $('venueEmpty').hidden = items.length > 0;
    $('venueCount').textContent = items.length || '';
    $('venueOpenCount').textContent = items.length || '';
  }

  // ── Панель на телефоне ──
  const panel = $('venuePanel');
  $('venuePanelOpen').addEventListener('click', () => panel.classList.add('is-open'));
  $('venuePanelClose').addEventListener('click', () => panel.classList.remove('is-open'));

  // ── Поиск ──
  const search = $('venueSearch');
  const found = $('venueFound');
  let searchTimer = null;
  let searchCtrl = null;

  function hideFound() {
    found.classList.add('hidden');
    found.replaceChildren();
  }

  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = search.value.trim();
    if (!q) return hideFound();
    searchTimer = setTimeout(() => {
      if (searchCtrl) searchCtrl.abort();
      const ctrl = searchCtrl = new AbortController();
      api('/searchEstablishments/' + encodeURIComponent(q), { signal: ctrl.signal }).then((items) => {
        found.innerHTML = items.length
          ? items.map((v) => `
              <button type="button" class="tk-venues__hit" data-id="${esc(v._id)}">
                <span class="tk-vrow__name">${esc(v.name)}</span>
                <span class="tk-vrow__meta">${esc([typeCity(v), v.address].filter(Boolean).join(' · '))}</span>
              </button>`).join('')
          : `<p class="tk-venues__miss">${esc(t('venues.nothingFound'))}</p>`;
        found.classList.remove('hidden');
        found.querySelectorAll('[data-id]').forEach((b, i) => {
          b.addEventListener('click', () => {
            const v = items[i];
            if (map && v.location && Number.isFinite(v.location.lat)) focusVenue(v);
            openCard(v._id);
            hideFound();
            panel.classList.remove('is-open');
          });
        });
      }).catch((e) => { if (e.name !== 'AbortError') hideFound(); });
    }, 200);
  });
  // mousedown, а не click: иначе поле теряет фокус и список прячется раньше щелчка.
  found.addEventListener('mousedown', (e) => e.preventDefault());
  search.addEventListener('blur', () => setTimeout(hideFound, 150));
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; hideFound(); } });

  // ── Карточка заведения ──
  const card = $('venueCard');
  const rate = $('venueRate');
  let cardId = null;
  let cardPhotos = [];

  function hideCard() {
    cardId = null;
    card.classList.add('hidden');
  }
  $('venueCardClose').addEventListener('click', hideCard);

  function openCard(id) {
    cardId = id;
    api('/api/venues/' + id).then((v) => {
      if (cardId !== id) return;
      fillCard(v);
      card.classList.remove('hidden');
    }).catch((e) => toast(e.message, 'error'));
  }

  // Картинка карточки: идёт камера — обложка камеры первой (правки 29.09:
  // обложку поставили, а карточка показывала букву); дальше фото; без
  // них — логотип, и только потом буква.
  function fillCard(v) {
    cardPhotos = (v.online && v.cover ? [v.cover] : []).concat(v.photos || []);
    if (!cardPhotos.length && v.avatar) cardPhotos = [v.avatar];
    $('venueCardPhotos').innerHTML = cardPhotos.length
      ? cardPhotos.map((src, i) => `<button type="button" data-i="${i}" aria-label="${esc(t('venues.photoN', { n: i + 1 }))}"><img src="${esc(src)}" alt=""></button>`).join('')
      : `<span class="tk-vcard__nophoto" aria-hidden="true">${esc(initial(v.name))}</span>`;
    $('venuePage').href = '/venue/' + encodeURIComponent(v._id);

    $('venueCardMeta').textContent = typeCity(v);
    $('venueCardName').textContent = v.name;
    $('venueCardAddr').textContent = v.address || '';

    // Часы — на сегодня: в субботу и воскресенье выходные.
    const day = new Date().getDay();
    const hours = day === 0 || day === 6 ? v.weekendHours : v.weekdayHours;
    $('venueCardHours').textContent = hours && hours.open && hours.close
      ? t('venues.today', { from: hours.open, to: hours.close })
      : '';

    const watch = $('venueWatch');
    watch.hidden = !v.online;
    watch.dataset.id = v._id;
    watch.href = '/venue/' + encodeURIComponent(v._id) + '/live';
    $('venueOffline').hidden = !!v.online;

    const r = v.rating;
    $('venueScore').textContent = r.average.toFixed(1);
    $('venueStars').style.setProperty('--v', r.average);
    // Формы слова подбирает plural: по-английски «few» и «many» совпадают,
    // поэтому те же правила годятся для обоих языков.
    $('venueVotes').textContent = `${r.count} ${plural(r.count, t('venues.votesOne'), t('venues.votesFew'), t('venues.votesMany'))}`;
    rate.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('is-on', Number(b.dataset.value) === r.mine);
    });
  }

  rate.addEventListener('click', (e) => {
    const b = e.target.closest('[data-value]');
    if (!b || !cardId || needLogin()) return;
    const id = cardId;
    api('/rateEstablishment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ establishmentId: id, rating: Number(b.dataset.value) }),
    }).then(() => {
      toast(t('venues.rateThanks'), 'ok');
      openCard(id);
    }).catch((err) => toast(err.message, 'error'));
  });

  // ── Фото во весь экран ──
  const photoModal = $('venuePhotoModal');
  const photoFull = $('venuePhotoFull');
  let photoAt = 0;

  function showPhoto(i) {
    photoAt = (i + cardPhotos.length) % cardPhotos.length;
    photoFull.src = cardPhotos[photoAt];
    $('venuePhotoPrev').hidden = $('venuePhotoNext').hidden = cardPhotos.length < 2;
  }

  $('venueCardPhotos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    showPhoto(Number(b.dataset.i));
    openModal(photoModal);
  });
  $('venuePhotoPrev').addEventListener('click', () => showPhoto(photoAt - 1));
  $('venuePhotoNext').addEventListener('click', () => showPhoto(photoAt + 1));
  document.addEventListener('keydown', (e) => {
    if (photoModal.classList.contains('hidden') || cardPhotos.length < 2) return;
    if (e.key === 'ArrowLeft') showPhoto(photoAt - 1);
    if (e.key === 'ArrowRight') showPhoto(photoAt + 1);
  });

  // ── Свои заведения ──
  // Список со ссылками на страницы заведений: камера, правка и удаление —
  // там (/venue/:id, с 29.09). Прежде всё это было здесь, окнами поверх
  // карты, и найти, как запустить камеру, было непросто.
  const mineModal = $('myVenuesModal');
  const mineList = $('myVenuesList');
  let mine = [];

  function loadMine() {
    return api('/user-establishments').then((items) => { mine = items; renderMine(); });
  }

  function renderMine() {
    if (!mineList) return;
    mineList.innerHTML = mine.map((v) => {
      const on = !!v.online;
      const approved = v.status === true;
      const state = on ? ['is-live', t('venues.onAir')]
        : !approved ? ['is-pending', t('venues.pending')]
        : v.pending ? ['is-pending', t('venue.page.draft')]
        : ['', t('venues.offlineState')];
      const id = esc(v._id);
      return `
        <li class="tk-mine__item">
          <a class="tk-mine__top" href="/venue/${id}">
            <span class="tk-vrow__pic">${v.avatar ? `<img src="${esc(v.avatar)}" alt="">` : pic(v)}</span>
            <span class="tk-vrow__body">
              <span class="tk-vrow__name">${esc(v.name)}</span>
              <span class="tk-vrow__meta">${esc(typeCity(v) || v.address)}</span>
            </span>
            <span class="tk-mine__state ${state[0]}">${state[1]}</span>
          </a>
          <div class="tk-mine__actions">
            <a href="/venue/${id}" class="tk-btn tk-btn--primary tk-btn--sm">${esc(t('venue.page.open'))}</a>
            ${approved ? `<a href="/venue/${id}/live" class="tk-btn tk-btn--outline tk-btn--sm">${esc(t(on ? 'vlive.open' : 'venues.startLive'))}</a>` : ''}
            <a href="/venue/${id}/edit" class="tk-btn tk-btn--ghost tk-btn--sm">${esc(t('venue.page.edit'))}</a>
          </div>
          ${approved ? '' : `<p class="tk-form__note">${esc(t('venues.pendingNote'))}</p>`}
        </li>`;
    }).join('');
  }

  if (mineModal) {
    $('myVenuesButton').addEventListener('click', () => {
      openModal(mineModal);
      loadMine().catch((e) => toast(e.message, 'error'));
    });
  }

  // Список, карточка и «Мои заведения» собираются скриптом, а переключатель
  // языка перерисовывает только разметку с ключами — поэтому пересобираем.
  document.addEventListener('tk:lang', () => {
    loadVenues();
    if (mine.length) loadMine().catch(() => {});
    const openId = $('venueCard') && !$('venueCard').classList.contains('hidden') && $('venueWatch').dataset.id;
    if (openId) openCard(openId);
  });

  // Для зондов (temp/): карточка и карта без щелчков.
  window.TKVenues = { openCard, get map() { return map; } };
})();
