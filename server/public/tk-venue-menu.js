// Вкладка «Меню» заведения (views/venueMenu.ejs, 29.09, docs/VENUES.md п. 10).
//
// Всем: ролики без звука крутятся по кругу, пока карточка на экране, и
// встают, когда ушла, — чтобы не качать и не крутить всё меню разом. При
// «меньше движения» и экономии трафика сами не играют: нажатие на ролик —
// пуск и пауза.
//
// Владельцу: окно позиции (добавить, изменить, удалить), выше/ниже и ролик —
// выбрать файл, место начала, загрузка с полосой. Пока ролик пережимается,
// страница спрашивает позицию и обновляется, когда он готов.
(function () {
  'use strict';

  var t = function (k, v) { return window.t ? window.t(k, v) : ''; };

  // ── Ролики ──
  var clips = document.querySelectorAll('[data-menu-clip]');
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    !!(navigator.connection && navigator.connection.saveData);
  var play = function (v) { var p = v.play(); if (p && p.catch) p.catch(function () {}); };

  if (!still && 'IntersectionObserver' in window) {
    var seen = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) play(e.target);
        else e.target.pause();
      });
    }, { threshold: 0.5 });
    clips.forEach(function (v) { seen.observe(v); });
  }

  document.addEventListener('click', function (e) {
    var v = e.target.closest('[data-menu-clip]');
    if (v) { if (v.paused) play(v); else v.pause(); }
  });

  // ── Правка ──
  // Карточки с данными позиции есть только у владельца и администратора.
  var root = document.querySelector('.tk-vp[data-venue]');
  if (!root || !(root.querySelector('[data-menu-item]') || document.getElementById('menuModal'))) return;
  var ID = root.getAttribute('data-venue');
  var BASE = '/venue/' + encodeURIComponent(ID) + '/menu';

  var api = TKNet.json;
  var json = function (method, body) {
    return { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) };
  };
  var itemOf = function (el) {
    var card = el.closest('[data-menu-item]');
    return card ? JSON.parse(card.getAttribute('data-menu-item')) : null;
  };

  document.addEventListener('click', function (e) {
    var move = e.target.closest('[data-menu-move]');
    if (move) {
      move.disabled = true;
      api(BASE + '/' + itemOf(move).id + '/move', json('POST', { dir: Number(move.getAttribute('data-menu-move')) }))
        .then(function () { location.reload(); })
        .catch(function (err) { move.disabled = false; toast(err.message, 'error'); });
      return;
    }
    var del = e.target.closest('[data-menu-delete]');
    if (del) {
      // С карточки или из окна правки — тогда позиция та, что в окне.
      var item = itemOf(del) || editing;
      confirmDialog(t('venue.menu.deleteConfirm', { name: item.name }), { okText: t('common.delete') }).then(function (yes) {
        if (!yes) return;
        del.disabled = true;
        return api(BASE + '/' + item.id, { method: 'DELETE' }).then(function () { location.reload(); });
      }).catch(function (err) { del.disabled = false; toast(err.message, 'error'); });
      return;
    }
    if (e.target.closest('[data-menu-add]')) return openForm(null);
    var edit = e.target.closest('[data-menu-edit]');
    if (edit) openForm(itemOf(edit));
  });

  // Ролик пережимается — спрашиваем, пока не станет готов или не выйдет.
  var waiting = Array.prototype.filter.call(document.querySelectorAll('[data-menu-item]'), function (card) {
    return JSON.parse(card.getAttribute('data-menu-item')).status === 'processing';
  }).map(function (card) { return JSON.parse(card.getAttribute('data-menu-item')).id; });
  if (waiting.length) {
    var poll = function () {
      Promise.all(waiting.map(function (id) { return api(BASE + '/' + id).catch(function () { return null; }); })).then(function (list) {
        var done = list.some(function (r) { return !r || r.item.clip.status !== 'processing'; });
        if (done) location.reload();
        else setTimeout(poll, 4000);
      });
    };
    setTimeout(poll, 4000);
  }

  // ── Окно позиции ──
  var modal = document.getElementById('menuModal');
  if (!modal) return;
  var form = document.getElementById('menuForm');
  var title = document.getElementById('menuModalTitle');
  var input = document.getElementById('menuClipInput');
  var preview = document.getElementById('menuPreview');
  var startRow = document.getElementById('menuStartRow');
  var startOut = document.getElementById('menuStartOut');
  var progress = document.getElementById('menuProgress');
  var unclip = form.querySelector('[data-menu-unclip]');
  var SECONDS = Number(form.getAttribute('data-seconds')) || 15;
  var MB = Number(form.getAttribute('data-mb')) || 250;
  var editing = null, file = null, dropClip = false, busy = false;

  var mmss = function (s) { s = Math.floor(s); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); };

  function resetClip() {
    file = null;
    dropClip = false;
    if (input) input.value = '';
    if (preview) {
      if (preview.src) URL.revokeObjectURL(preview.src);
      preview.removeAttribute('src');
      preview.hidden = true;
    }
    if (startRow) { startRow.hidden = true; form.elements.start.value = 0; startOut.textContent = '0:00'; }
    if (progress) { progress.hidden = true; progress.value = 0; }
  }

  function openForm(item) {
    editing = item;
    resetClip();
    form.reset();
    ['name', 'section', 'price', 'description'].forEach(function (k) { form.elements[k].value = item ? item[k] : ''; });
    var key = item ? 'venue.menu.editTitle' : 'venue.menu.addTitle';
    title.setAttribute('data-i18n', key);
    title.textContent = t(key);
    if (unclip) unclip.hidden = !(item && item.clip);
    form.querySelector('[data-menu-delete]').hidden = !item;
    modal.classList.remove('hidden');
    form.elements.name.focus();
  }

  function close() {
    if (busy) return;
    modal.classList.add('hidden');
    resetClip();
  }

  modal.addEventListener('click', function (e) {
    if (e.target === modal || e.target.closest('[data-menu-close]')) return close();
    if (e.target.closest('[data-menu-pick]')) return input.click();
    if (e.target.closest('[data-menu-unclip]')) { dropClip = true; unclip.hidden = true; }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });

  // Выбранный файл — сразу в предпросмотр: видно, какой кусок уйдёт в меню.
  if (input) input.addEventListener('change', function () {
    var f = input.files && input.files[0];
    if (!f) return;
    if (f.size > MB * 1024 * 1024) { input.value = ''; return toast(t('venue.menu.clipBig', { mb: MB }), 'error'); }
    resetClip();
    file = f;
    preview.src = URL.createObjectURL(f);
    preview.hidden = false;
    play(preview);
  });

  if (preview) {
    preview.addEventListener('loadedmetadata', function () {
      var d = preview.duration;
      var longer = isFinite(d) && d > SECONDS + 0.5;
      startRow.hidden = !longer;
      form.elements.start.max = longer ? Math.max(0, d - 1).toFixed(1) : 0;
    });
    // Предпросмотр крутит только то, что уйдёт в меню.
    preview.addEventListener('timeupdate', function () {
      var from = Number(form.elements.start.value) || 0;
      if (preview.currentTime < from - 0.3 || preview.currentTime > from + SECONDS) preview.currentTime = from;
    });
    form.elements.start.addEventListener('input', function () {
      startOut.textContent = mmss(form.elements.start.value);
      preview.currentTime = Number(form.elements.start.value) || 0;
    });
  }

  // Ролик — отдельным запросом, с полосой: файл бывает в сотню мегабайт.
  // Попытка загрузки — как у остальных файлов (docs/TELEMETRY.md, kind upload).
  function sendClip(id) {
    var tr = window.TKTrace ? TKTrace.start('upload', BASE + '/' + id + '/clip') : null;
    var sentAt = Date.now();
    if (tr) { tr.set('what', 'menu'); tr.set('kb', Math.round(file.size / 1024)); tr.set('type', file.type || ''); }
    function done(outcome, reason) {
      if (!tr) return;
      var ms = Date.now() - sentAt;
      tr.set('ms', ms);
      tr.set('kbps', Math.round((file.size * 8) / Math.max(1, ms)));
      tr.end(outcome, reason);
    }
    return new Promise(function (resolve, reject) {
      var data = new FormData();
      data.append('start', form.elements.start.value || '0');
      data.append('clip', file);
      var xhr = new XMLHttpRequest();
      xhr.open('POST', BASE + '/' + id + '/clip');
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) progress.value = Math.round(e.loaded / e.total * 100); };
      xhr.onload = function () {
        var body = {};
        try { body = JSON.parse(xhr.responseText); } catch (err) { /* не JSON — ниже код */ }
        if (xhr.status >= 200 && xhr.status < 300) { done('ok'); resolve(body); }
        else { done('fail', xhr.status === 413 ? 'too_big' : 'http_' + xhr.status); reject(new Error(body.message || t('common.failedCode', { code: xhr.status }))); }
      };
      xhr.onerror = function () { done('fail', navigator.onLine === false ? 'offline' : 'no_server'); reject(new Error(t('common.noNetwork'))); };
      progress.hidden = false;
      progress.value = 0;
      toast(t('venue.menu.uploading'));
      xhr.send(data);
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var body = {};
    ['name', 'section', 'price', 'description'].forEach(function (k) { body[k] = form.elements[k].value.trim(); });
    if (!body.name) { toast(t('venue.menu.nameNeeded'), 'error'); return form.elements.name.focus(); }
    busy = true;
    var submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    api(editing ? BASE + '/' + editing.id : BASE, json(editing ? 'PUT' : 'POST', body))
      .then(function (r) {
        editing = r.item;
        if (file) return sendClip(r.item.id);
        if (dropClip) return api(BASE + '/' + r.item.id + '/clip', { method: 'DELETE' });
      })
      .then(function () { busy = false; location.reload(); })
      .catch(function (err) {
        // Позиция могла уже сохраниться — дальше правим её, а не заводим вторую.
        busy = false;
        submit.disabled = false;
        if (progress) progress.hidden = true;
        toast(err.message, 'error');
      });
  });
})();
