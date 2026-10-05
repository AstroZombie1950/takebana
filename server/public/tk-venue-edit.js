// Страница заведения и её настройки (views/venue.ejs, views/venueEdit.ejs, 29.09).
//
// На странице заведения — пульт владельца: отозвать правку, которая ещё
// ждёт проверки. На странице настроек — логотип, обложка камеры
// и выключатели разделов (видео-меню; сразу, отдельными запросами), поля,
// точка на карте (tk-point.js), фото и удаление (с 05.10 только здесь);
// «Сохранить» у одобренного заведения отправляет правку на проверку,
// у неодобренного — сразу в заведение.
// До 29.09 всё это жило окном поверх карты (tk-venues.js).
(function () {
  'use strict';

  var t = function (k, v) { return window.t ? window.t(k, v) : ''; };
  var root = document.querySelector('.tk-vp[data-venue]');
  if (!root) return;
  var ID = root.getAttribute('data-venue');
  var NAME = root.getAttribute('data-name') || '';
  var esc = function (s) { return escapeHtml(String(s == null ? '' : s)); };

  var api = TKNet.json;

  // ── Удаление (настройки) и отзыв правки (страница заведения) ──
  document.addEventListener('click', function (e) {
    var del = e.target.closest('[data-venue-delete]');
    if (del) {
      confirmDialog(t('venues.deleteConfirm', { name: NAME }), { okText: t('common.delete') }).then(function (yes) {
        if (!yes) return;
        del.disabled = true;
        return api('/establishment/' + encodeURIComponent(ID), { method: 'DELETE' }).then(function () {
          toast(t('venues.deleted'), 'ok');
          location.href = '/venues';
        });
      }).catch(function (err) { del.disabled = false; toast(err.message, 'error'); });
      return;
    }
    var back = e.target.closest('[data-venue-withdraw]');
    if (back) {
      back.disabled = true;
      api('/updateEstablishment/' + encodeURIComponent(ID), { method: 'DELETE' })
        .then(function () { location.reload(); })
        .catch(function (err) { back.disabled = false; toast(err.message, 'error'); });
    }
  });

  // ── Выключатели разделов (видео-меню) ──
  // Сохраняются сразу (PUT /venue/:id/settings); не сохранилось — возвращаем как было.
  document.addEventListener('change', function (e) {
    var box = e.target.closest('[data-venue-feature]');
    if (!box) return;
    var body = {};
    body[box.getAttribute('data-venue-feature')] = box.checked;
    box.disabled = true;
    api('/venue/' + encodeURIComponent(ID) + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function () { toast(t('venue.page.saved'), 'ok'); })
      .catch(function (err) { box.checked = !box.checked; toast(err.message, 'error'); })
      .then(function () {
        // Ссылка на то, что включает настройка, — «Открыть меню».
        var link = document.querySelector('[data-feature-link="' + box.getAttribute('data-venue-feature') + '"]');
        if (link) link.hidden = !box.checked;
      })
      .then(function () { box.disabled = false; });
  });

  var form = document.getElementById('venueEditForm');
  if (!form) return;

  // ── Логотип и обложка камеры: сразу, без проверки ──
  var imageInput = document.getElementById('venueImageInput');
  var picking = '';
  var BOX = { avatar: document.getElementById('venueAva'), cover: document.getElementById('venueCoverBox') };

  function paint(kind, url) {
    var box = BOX[kind];
    if (url) box.innerHTML = '<img src="' + esc(url) + '" alt="">';
    else box.textContent = kind === 'avatar' ? ((NAME.match(/[\p{L}\p{N}]/u) || ['•'])[0].toUpperCase()) : '';
    root.querySelector('[data-drop="' + kind + '"]').hidden = !url;
  }

  root.addEventListener('click', function (e) {
    var pick = e.target.closest('[data-pick]');
    if (pick) { picking = pick.getAttribute('data-pick'); imageInput.click(); return; }
    var drop = e.target.closest('[data-drop]');
    if (!drop) return;
    var kind = drop.getAttribute('data-drop');
    api('/api/venues/' + encodeURIComponent(ID) + '/' + kind, { method: 'DELETE' })
      .then(function () { paint(kind, ''); })
      .catch(function (err) { toast(err.message, 'error'); });
  });

  imageInput.addEventListener('change', function () {
    var file = imageInput.files[0];
    imageInput.value = '';
    if (!file || !picking) return;
    var bad = TKNet.image(file, 5); // логотип и обложка — до 5 МБ (routes/venueLive.js)
    if (bad) return toast(bad, 'error');
    var kind = picking;
    var data = new FormData();
    data.append(kind, file);
    api('/api/venues/' + encodeURIComponent(ID) + '/' + kind, { method: 'POST', body: data })
      .then(function (r) {
        paint(kind, r[kind]);
        toast(t(kind === 'avatar' ? 'venue.page.logoSaved' : 'vlive.coverSaved'), 'ok');
      })
      .catch(function (err) { toast(err.message, 'error'); });
  });

  // ── Поля ──
  var f = form.elements;
  f.address.value = form.getAttribute('data-address') || '';

  // Время: цифры и двоеточие после второй — как в заявке (tk-company.js).
  form.querySelectorAll('[data-time]').forEach(function (el) {
    el.addEventListener('input', function () {
      var d = el.value.replace(/\D/g, '').slice(0, 4);
      el.value = d.length > 2 ? d.slice(0, 2) + ':' + d.slice(2) : d;
    });
  });

  // Тип, страна и город — список или своё (public/tk-venue-place.js).
  var place = window.TKPlace.attach(form.querySelector('[data-place]'));

  // Точка на карте: метка и поиск по адресу (public/tk-point.js).
  var pointBox = form.querySelector('[data-point]');
  var point = pointBox && window.TKPoint ? window.TKPoint.attach(pointBox, { address: f.address, place: place }) : null;
  var lat = parseFloat(form.getAttribute('data-lat'));
  var lng = parseFloat(form.getAttribute('data-lng'));
  if (point) point.open(Number.isFinite(lat) ? lat : undefined, Number.isFinite(lng) ? lng : undefined);

  // ── Фото: уже загруженные { url } и новые { file, preview } ──
  var thumbs = document.getElementById('venueThumbs');
  var drop = document.getElementById('venueDrop');
  var photoInput = document.getElementById('venuePhotoInput');
  var MAX = Number(thumbs.getAttribute('data-max')) || 6;
  var photos = JSON.parse(thumbs.getAttribute('data-photos') || '[]').map(function (url) { return { url: url }; });

  function renderThumbs() {
    thumbs.innerHTML = photos.map(function (p, i) {
      return '<div class="tk-thumb"><img src="' + esc(p.url || p.preview) + '" alt="">' +
        '<button type="button" class="tk-thumb__del" data-del="' + i + '" aria-label="' + esc(t('venues.removePhoto')) + '">' +
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"></path></svg>' +
        '</button></div>';
    }).join('');
    drop.hidden = photos.length >= MAX;
  }

  function addFiles(files) {
    var room = MAX - photos.length;
    // Фото заведения — до 10 МБ (establishmentsRouter.js); негодные — сразу,
    // а не отказом всей формы при сохранении.
    var bad = '';
    var images = Array.prototype.filter.call(files, function (x) {
      var why = TKNet.image(x, 10);
      if (why && !bad) bad = why;
      return !why;
    });
    if (bad) toast(bad, 'error');
    if (images.length > room) toast(t('venues.photoLimit', { n: room }));
    images.slice(0, room).forEach(function (file) { photos.push({ file: file, preview: URL.createObjectURL(file) }); });
    renderThumbs();
  }

  photoInput.addEventListener('change', function () { addFiles(photoInput.files); photoInput.value = ''; });
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', function () { drop.classList.remove('is-over'); });
  drop.addEventListener('drop', function (e) {
    e.preventDefault();
    drop.classList.remove('is-over');
    addFiles(e.dataTransfer.files);
  });
  thumbs.addEventListener('click', function (e) {
    var del = e.target.closest('[data-del]');
    if (!del) return;
    var gone = photos.splice(Number(del.getAttribute('data-del')), 1)[0];
    if (gone.preview) URL.revokeObjectURL(gone.preview);
    renderThumbs();
  });
  renderThumbs();

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var where = place.value();
    if (!where) { toast(t('company.fillAll')); return; }
    var data = new FormData();
    ['name', 'address', 'about'].forEach(function (k) { data.append(k, f[k].value); });
    Object.keys(where).forEach(function (k) { data.append(k, where[k]); });
    data.append('weekdayHours', JSON.stringify({ open: f.weekdayOpen.value, close: f.weekdayClose.value }));
    data.append('weekendHours', JSON.stringify({ open: f.weekendOpen.value, close: f.weekendClose.value }));
    data.append('uploadedPhotos', JSON.stringify(photos.filter(function (p) { return p.url; }).map(function (p) { return p.url; })));
    // Точки может не быть: у заведений, заведённых до этой формы, координат
    // нет, и пустое поле сервер пропускает, а не стирает старое значение.
    var spot = point && point.value();
    if (spot) data.append('location', JSON.stringify(spot));
    photos.filter(function (p) { return p.file; }).forEach(function (p) { data.append('newPhotos', p.file); });

    var button = form.querySelector('[type="submit"]');
    button.disabled = true;
    api('/updateEstablishment/' + encodeURIComponent(ID), { method: 'PUT', body: data })
      .then(function (r) {
        toast(t(r.pending ? 'venue.page.sentReview' : 'venue.page.saved'), 'ok');
        location.href = '/venue/' + encodeURIComponent(ID);
      })
      .catch(function (err) { button.disabled = false; toast(err.message, 'error'); });
  });
})();
