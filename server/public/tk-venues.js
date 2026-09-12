// Карта заведений (/main): фильтры, список, поиск, карточка, оценка, камера
// заведения, кабинет владельца. Разметка — views/map.ejs, карта — tk-map.js.
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

  // Ответ с ошибкой — исключение с текстом сервера: его и показываем.
  function api(url, opts) {
    return fetch(url, opts).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.message || 'HTTP ' + r.status);
      return body;
    });
  }

  // ── Окна ──
  const modals = ['venueLiveModal', 'venuePhotoModal', 'myVenuesModal', 'venueSettingsModal'].map($).filter(Boolean);
  const onClose = new Map(); // окно → что сделать при закрытии

  function openModal(m) { m.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
  function closeModal(m) {
    if (m.classList.contains('hidden')) return;
    m.classList.add('hidden');
    if (!modals.some((x) => !x.classList.contains('hidden'))) document.body.style.overflow = '';
    const fn = onClose.get(m);
    if (fn) fn();
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
    history.replaceState(null, '', '/main' + (p.toString() ? '?' + p : ''));
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
    if (navigator.geolocation) {
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

  function fillCard(v) {
    cardPhotos = v.photos || [];
    $('venueCardPhotos').innerHTML = cardPhotos.length
      ? cardPhotos.map((src, i) => `<button type="button" data-i="${i}" aria-label="${esc(t('venues.photoN', { n: i + 1 }))}"><img src="${esc(src)}" alt=""></button>`).join('')
      : `<span class="tk-vcard__nophoto" aria-hidden="true">${esc(initial(v.name))}</span>`;

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
    watch.dataset.name = v.name;
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
    if (!b || !cardId) return;
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

  // ── Камера заведения: гость ──
  const liveModal = $('venueLiveModal');
  const liveVideo = $('venueLiveVideo');
  let watching = null;

  function stopWatching() {
    if (watching) { watching.leave(); watching = null; }
    liveVideo.srcObject = null;
  }
  onClose.set(liveModal, stopWatching);

  function watch(id, name) {
    stopWatching();
    const media = new MediaStream();
    liveVideo.srcObject = media;
    // Название заведения — не словарная строка, поэтому ключ снимаем;
    // без названия остаётся «Трансляция» из словаря.
    if (name) {
      $('venueLiveTitle').removeAttribute('data-i18n');
      $('venueLiveTitle').textContent = name;
    } else {
      tkText($('venueLiveTitle'), 'venues.live');
    }
    openModal(liveModal);
    watching = TKDaily.connect({
      send: false,
      access: () => TKDaily.requestAccess('/api/venues/' + id + '/watch'),
      onTrack: (track, p, on) => {
        if (p.local) return;
        if (on) media.addTrack(track); else media.removeTrack(track);
        liveVideo.srcObject = media;
        liveVideo.play().catch(() => {});
      },
      onState: (s) => {
        if (s !== 'ended') return;
        closeModal(liveModal);
        toast(t('venues.noCamera'));
      },
    });
  }
  $('venueWatch').addEventListener('click', function () { watch(this.dataset.id, this.dataset.name); });

  // ── Кабинет владельца: камера и настройки ──
  const mineModal = $('myVenuesModal');
  const mineList = $('myVenuesList');
  const live = {};      // id заведения → сессия Daily, пока камера включена
  const starting = {};  // id → подключаемся
  let mine = [];

  function loadMine() {
    return api('/user-establishments').then((items) => { mine = items; renderMine(); });
  }

  function renderMine() {
    if (!mineList) return;
    mineList.innerHTML = mine.map((v) => {
      const on = !!live[v._id];
      const busy = !!starting[v._id];
      const approved = v.status === true;
      const state = on ? ['is-live', t('venues.onAir')]
        : approved ? ['', t('venues.offlineState')]
        : ['is-pending', t('venues.pending')];
      return `
        <li class="tk-mine__item">
          <div class="tk-mine__top">
            <span class="tk-vrow__pic">${pic(v)}</span>
            <span class="tk-vrow__body">
              <span class="tk-vrow__name">${esc(v.name)}</span>
              <span class="tk-vrow__meta">${esc(typeCity(v) || v.address)}</span>
            </span>
            <span class="tk-mine__state ${state[0]}">${state[1]}</span>
          </div>
          <div class="tk-mine__actions">
            <button type="button" class="tk-btn ${on ? 'tk-btn--outline' : 'tk-btn--primary'} tk-btn--sm" data-live="${esc(v._id)}"${busy || !approved ? ' disabled' : ''}>
              ${esc(busy ? t('venues.connecting') : on ? t('venues.stopLive') : t('venues.startLive'))}
            </button>
            <button type="button" class="tk-btn tk-btn--ghost tk-btn--sm" data-settings="${esc(v._id)}">${esc(t('venues.settingsBtn'))}</button>
            <button type="button" class="tk-btn tk-btn--ghost tk-btn--sm tk-mine__del" data-remove="${esc(v._id)}">${esc(t('common.delete'))}</button>
          </div>
          ${approved ? '' : `<p class="tk-form__note">${esc(t('venues.pendingNote'))}</p>`}
        </li>`;
    }).join('');
  }

  function startLive(id) {
    if (live[id] || starting[id]) return;
    starting[id] = true;
    renderMine();
    TKDaily.requestAccess('/api/venues/' + id + '/live').then((first) => {
      let firstAccess = first;
      live[id] = TKDaily.connect({
        send: true,
        video: true,
        // Повторный вход после обрыва — через /watch: комнату не пересоздаём,
        // иначе обрыв у владельца выкидывал бы всех гостей.
        access: () => {
          if (!firstAccess) return TKDaily.requestAccess('/api/venues/' + id + '/watch');
          const a = firstAccess;
          firstAccess = null;
          return Promise.resolve(a);
        },
        onMediaError: () => toast(t('venues.mediaDenied'), 'error'),
        onState: (s) => {
          if (s === 'live') { delete starting[id]; renderMine(); loadVenues(); }
          if (s === 'ended') {
            toast(t('venues.liveLost'), 'error');
            stopLive(id);
          }
        },
      });
    }).catch((err) => {
      delete starting[id];
      renderMine();
      toast(err.message, 'error');
    });
  }

  function stopLive(id) {
    const session = live[id];
    delete live[id];
    delete starting[id];
    if (session) session.leave();
    renderMine();
    fetch('/api/venues/' + id + '/live', { method: 'DELETE' }).catch(() => {}).then(loadVenues);
  }

  // Ушли со страницы с включённой камерой — гасим её на сервере, иначе
  // заведение висело бы «в эфире» с пустой комнатой.
  window.addEventListener('pagehide', () => {
    if (Object.keys(live).length) navigator.sendBeacon('/updateEstablishmentsOnlineStatus');
  });

  if (mineModal) {
    $('myVenuesButton').addEventListener('click', () => {
      openModal(mineModal);
      loadMine().catch((e) => toast(e.message, 'error'));
    });
    mineList.addEventListener('click', (e) => {
      const liveBtn = e.target.closest('[data-live]');
      if (liveBtn) {
        const id = liveBtn.dataset.live;
        if (live[id]) stopLive(id); else startLive(id);
        return;
      }
      const setBtn = e.target.closest('[data-settings]');
      if (setBtn) {
        openSettings(setBtn.dataset.settings);
        return;
      }
      const delBtn = e.target.closest('[data-remove]');
      if (delBtn) removeVenue(delBtn.dataset.remove, delBtn);
    });
  }

  // Удаление необратимо, и вместе с заведением уходят его фотографии
  // и оценки, — поэтому спрашиваем, а не удаляем по щелчку.
  function removeVenue(id, button) {
    const v = mine.find((x) => x._id === id);
    if (!v) return;

    confirmDialog(t('venues.deleteConfirm', { name: v.name }), { okText: t('common.delete') })
      .then((yes) => {
        if (!yes) return;
        button.disabled = true;
        return api('/establishment/' + encodeURIComponent(id), { method: 'DELETE' })
          .then(() => {
            delete live[id];
            toast(t('venues.deleted'), 'ok');
            return Promise.all([loadMine(), loadVenues()]);
          })
          .catch((err) => {
            button.disabled = false;
            toast(err.message, 'error');
          });
      });
  }

  // ── Настройки заведения ──
  const settingsModal = $('venueSettingsModal');
  const settingsForm = $('venueSettingsForm');
  const thumbs = $('venueThumbs');
  const photoInput = $('venuePhotoInput');
  const drop = $('venueDrop');
  const MAX_PHOTOS = 6;
  // Точка на карте: метка и поиск по адресу (public/tk-point.js). Карта
  // внутри окна поднимается при первом открытии настроек, не раньше.
  const pointBox = settingsForm && settingsForm.querySelector('[data-point]');
  const point = pointBox && window.TKPoint
    ? window.TKPoint.attach(pointBox, {
        address: settingsForm.elements.address,
        cityField: settingsForm.elements.city,
      })
    : null;
  let editing = null;
  let photos = []; // { url } — уже загруженное, { file, preview } — новое

  function renderThumbs() {
    thumbs.replaceChildren(...photos.map((p, i) => {
      const div = document.createElement('div');
      div.className = 'tk-thumb';
      div.innerHTML = `<img src="${esc(p.url || p.preview)}" alt="">
        <button type="button" class="tk-thumb__del" data-del="${i}" aria-label="Убрать фото">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"></path></svg>
        </button>`;
      return div;
    }));
    drop.hidden = photos.length >= MAX_PHOTOS;
  }

  function addFiles(files) {
    const room = MAX_PHOTOS - photos.length;
    const images = [...files].filter((f) => /^image\//.test(f.type));
    if (images.length > room) toast(t('venues.photoLimit', { n: room }));
    images.slice(0, room).forEach((file) => photos.push({ file, preview: URL.createObjectURL(file) }));
    renderThumbs();
  }

  // Время: цифры и двоеточие после второй — как в заявке (tk-company.js).
  function timeMask() {
    const digits = this.value.replace(/\D/g, '').slice(0, 4);
    this.value = digits.length > 2 ? digits.slice(0, 2) + ':' + digits.slice(2) : digits;
  }

  function openSettings(id) {
    const v = mine.find((x) => x._id === id);
    if (!v) return;
    editing = id;
    const f = settingsForm.elements;
    f.name.value = v.name || '';
    f.type.value = dict.types[v.type] ? v.type : '';
    f.city.value = dict.cities[v.city] ? v.city : '';
    f.country.value = v.country || '';
    f.address.value = v.address || '';
    f.weekdayOpen.value = (v.weekdayHours && v.weekdayHours.open) || '';
    f.weekdayClose.value = (v.weekdayHours && v.weekdayHours.close) || '';
    f.weekendOpen.value = (v.weekendHours && v.weekendHours.open) || '';
    f.weekendClose.value = (v.weekendHours && v.weekendHours.close) || '';
    photos = (v.photos || []).map((url) => ({ url }));
    renderThumbs();
    openModal(settingsModal);
    // После openModal: скрытой карте MapLibre мерит нулевой размер.
    if (point) point.open(v.location && v.location.lat, v.location && v.location.lng);
  }

  if (settingsForm) {
    settingsForm.querySelectorAll('[data-time]').forEach((el) => el.addEventListener('input', timeMask));
    photoInput.addEventListener('change', () => { addFiles(photoInput.files); photoInput.value = ''; });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      addFiles(e.dataTransfer.files);
    });
    thumbs.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (!del) return;
      const [gone] = photos.splice(Number(del.dataset.del), 1);
      if (gone.preview) URL.revokeObjectURL(gone.preview);
      renderThumbs();
    });

    settingsForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = settingsForm.elements;
      const data = new FormData();
      ['name', 'type', 'city', 'country', 'address'].forEach((k) => data.append(k, f[k].value));
      data.append('weekdayHours', JSON.stringify({ open: f.weekdayOpen.value, close: f.weekdayClose.value }));
      data.append('weekendHours', JSON.stringify({ open: f.weekendOpen.value, close: f.weekendClose.value }));
      data.append('uploadedPhotos', JSON.stringify(photos.filter((p) => p.url).map((p) => p.url)));
      // Точки может не быть: у заведений, заведённых до этой формы, координат
      // нет, и пустое поле сервер пропускает, а не стирает старое значение.
      const spot = point && point.value();
      if (spot) data.append('location', JSON.stringify(spot));
      photos.filter((p) => p.file).forEach((p) => data.append('newPhotos', p.file));

      const button = settingsForm.querySelector('[type="submit"]');
      button.disabled = true;
      api('/updateEstablishment/' + editing, { method: 'PUT', body: data })
        .then(() => {
          toast(t('venues.saved'), 'ok');
          closeModal(settingsModal);
          loadMine();
          loadVenues();
        })
        .catch((err) => toast(err.message, 'error'))
        .finally(() => { button.disabled = false; });
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

  // Для сквозного теста и зонда (temp/): камера без щелчков по кнопкам и карта.
  window.TKVenues = { live, startLive, stopLive, watch, openCard, get map() { return map; } };
})();
