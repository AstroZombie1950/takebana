/* Галерея: превью в профиле (userPage.ejs) и страница /userPage/:id/gallery
 * (gallery.ejs). Плитки — partials/galleryTile.ejs. Здесь — крестик
 * владельца, ролики в работе и окно просмотра фото (и аватара в профиле).
 * До 23.09.2026 жило в profile.js; видео тогда открывалось в окне, теперь
 * у него своя страница /video/:id.
 */

document.addEventListener('DOMContentLoaded', function () {
  // Подписи — из общего словаря (public/tk-i18n.js).
  var pt = function (key, vars) { return window.t ? window.t(key, vars) : ''; };

  // ── Своя галерея: удаление и ролики в работе ───────────────────────────
  // Добавляют со страницы загрузки (/upload, public/upload.js): «Добавить»
  // ведёт туда. Здесь — удаление и то, что ещё в работе: загружается
  // (проценты приходят от фоновой загрузки, public/tk-upload.js),
  // ждёт публикации, пережимается.
  var gallery = document.getElementById('gallery');
  if (gallery && gallery.hasAttribute('data-own')) {
    var shots = document.getElementById('galleryShots');
    var countEl = document.getElementById('galleryCount');
    var empty = document.getElementById('galleryEmpty');

    var json = function (url, options) {
      options.headers = { Accept: 'application/json' };
      return fetch(url, options).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok || d.success === false) throw new Error(d.message || 'HTTP ' + r.status);
          return d;
        });
      });
    };

    // Счётчик — то, что можно смотреть: без роликов, которые ещё грузятся,
    // пережимаются или не вышли. Плиток на экране меньше (превью, страница
    // ленты), поэтому число не пересчитывается, а сдвигается.
    var ready = function (el) { return !/ is-/.test(' ' + el.className); };
    var bump = function (d) {
      countEl.textContent = String(Math.max(0, (Number(countEl.textContent) || 0) + d));
      empty.hidden = shots.children.length > 0;
    };

    var PLAY = '<span class="tk-shot__play" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5.5v13L20 12z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></span>';
    var clock = function (s) { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

    var videoInner = function (v) {
      if (v.status === 'ready') {
        return '<a class="tk-shot tk-shot--video" href="/video/' + encodeURIComponent(v.id) + '" aria-label="' + escapeHtml(pt('user.videoPlay')) + '">' +
          (v.thumb ? '<img src="' + escapeHtml(v.thumb) + '" alt="" loading="lazy" decoding="async">' : '') + PLAY +
          '<span class="tk-shot__len">' + clock(v.duration) + '</span></a>';
      }
      var key = v.status === 'failed' ? (v.error === 'long' ? 'user.videoLong' : 'user.videoFailed') : 'user.videoProcessing';
      return '<div class="tk-shot tk-shot--state"><span data-i18n="' + key + '">' + escapeHtml(pt(key)) + '</span></div>';
    };

    var paintVideo = function (el, v) {
      var was = ready(el);
      el.className = 'tk-shots__item' + (v.status !== 'ready' ? ' is-' + v.status : '');
      el.firstElementChild.outerHTML = videoInner(v);
      bump(ready(el) - was);
    };

    // Пока ролик пережимается — спрашиваем раз в 4 секунды.
    var watch = function (el, id) {
      setTimeout(function () {
        if (!el.isConnected) return;
        json('/profile/gallery/video/' + encodeURIComponent(id), { method: 'GET' })
          .then(function (d) {
            if (d.video.status === 'processing') return watch(el, id);
            paintVideo(el, d.video);
          })
          .catch(function () { watch(el, id); });
      }, 4000);
    };
    shots.querySelectorAll('.tk-shots__item.is-processing[data-video-id]').forEach(function (el) {
      watch(el, el.getAttribute('data-video-id'));
    });

    // Фоновая загрузка сообщает проценты с любой страницы (tk-upload.js).
    // Доехало и опубликовано — дальше плитка ждёт пережатия, как обычно.
    document.addEventListener('tk:upload', function (e) {
      var d = e.detail;
      var el = shots.querySelector('.tk-shots__item[data-video-id="' + CSS.escape(d.id) + '"]');
      if (!el) return;
      var label = el.querySelector('[data-upload-pct]');
      if (d.status === 'uploading' && label) {
        window.tkText(label, 'user.videoUploading', { p: Math.floor(d.received / d.size * 100) });
      } else if (d.status === 'processing' && !el.classList.contains('is-processing')) {
        paintVideo(el, { status: 'processing' });
        watch(el, d.id);
      } else if (d.status === 'draft' && el.classList.contains('is-uploading')) {
        location.reload(); // плитка черновика рисуется сервером
      }
    });

    shots.addEventListener('click', function (e) {
      var vdel = e.target.closest('[data-video-del]');
      if (vdel) {
        var tile = vdel.closest('.tk-shots__item');
        var vid = tile.getAttribute('data-video-id');
        if (!vid) return; // ещё грузится — удалить нечего
        var d = -ready(tile);
        confirmDialog(pt('user.videoDeleteQ'), { okText: pt('common.delete') }).then(function (yes) {
          if (!yes) return;
          tile.classList.add('is-busy');
          return json('/video/' + encodeURIComponent(vid), { method: 'DELETE' })
            .then(function () { tile.remove(); bump(d); })
            .catch(function (err) {
              tile.classList.remove('is-busy');
              toast(window.t('app.deleteError', { message: err.message }), 'error');
            });
        });
        return;
      }
      var del = e.target.closest('[data-name]');
      if (!del) return;
      var item = del.closest('.tk-shots__item');
      confirmDialog(pt('user.galleryDeleteQ'), { okText: pt('common.delete') }).then(function (yes) {
        if (!yes) return;
        item.classList.add('is-busy');
        return json('/profile/gallery/' + encodeURIComponent(del.getAttribute('data-name')), { method: 'DELETE' })
          .then(function () { item.remove(); bump(-1); })
          .catch(function (err) {
            item.classList.remove('is-busy');
            toast(window.t('app.deleteError', { message: err.message }), 'error');
          });
      });
    });
  }

  // ── Просмотр фотографии ─────────────────────────────────────────────────
  var box = document.getElementById('lightbox');
  if (!box) return;

  var img = document.getElementById('lightboxImg');
  var prev = document.getElementById('lightboxPrev');
  var next = document.getElementById('lightboxNext');
  var counter = document.getElementById('lightboxCounter');

  // Список снимков собирается при открытии, а не один раз при загрузке:
  // владелец добавляет и удаляет фото, не уходя со страницы.
  var photos = [];
  var collect = function () {
    photos = Array.prototype.map.call(
      document.querySelectorAll('img[data-photo-url]'),
      function (el) { return el.getAttribute('data-photo-url'); }
    );
  };
  var index = 0;

  function isOpen() { return !box.classList.contains('hidden'); }

  function show(i) {
    if (i < 0 || i >= photos.length) return;
    index = i;
    img.src = photos[index];
    counter.textContent = (index + 1) + ' / ' + photos.length;
    var many = photos.length > 1;
    prev.classList.toggle('hidden', !many);
    next.classList.toggle('hidden', !many);
    counter.classList.remove('hidden');
  }

  function open(i) {
    show(i);
    box.classList.remove('hidden');
  }

  function close() {
    box.classList.add('hidden');
    // src не сбрасываем: снимок остаётся в кэше и открывается мгновенно
  }

  document.addEventListener('click', function (e) {
    var photo = e.target.closest('img[data-photo-url]');
    if (photo) {
      collect();
      var i = photos.indexOf(photo.getAttribute('data-photo-url'));
      if (i !== -1) open(i);
      return;
    }

    // Аватар открывается тем же окном, но без перелистывания
    var avatar = e.target.closest('img[data-avatar-url]');
    if (avatar) {
      img.src = avatar.getAttribute('data-avatar-url');
      counter.classList.add('hidden');
      prev.classList.add('hidden');
      next.classList.add('hidden');
      box.classList.remove('hidden');
    }
  });

  document.getElementById('lightboxClose').addEventListener('click', close);

  prev.addEventListener('click', function (e) {
    e.stopPropagation();
    show(index > 0 ? index - 1 : photos.length - 1);
  });

  next.addEventListener('click', function (e) {
    e.stopPropagation();
    show(index < photos.length - 1 ? index + 1 : 0);
  });

  box.addEventListener('click', function (e) {
    if (e.target === box || e.target === img) close();
  });

  document.addEventListener('keydown', function (e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(index > 0 ? index - 1 : photos.length - 1);
    else if (e.key === 'ArrowRight') show(index < photos.length - 1 ? index + 1 : 0);
  });
});
