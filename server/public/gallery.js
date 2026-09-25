/* Галерея: вкладки «Фото» и «Видео» в профиле (userPage.ejs) и страницы
 * /@ник/photos и /@ник/videos (gallery.ejs). Разметка — partials/galleryPhoto
 * и partials/galleryVideo. Здесь — переключение вкладок профиля, ролики
 * владельца в работе и окно просмотра аватара.
 *
 * С 25.09.2026 фото открывается своей страницей /photo/:id (подпись,
 * «нравится», комментарии, листание), а удаляют фото и видео на их
 * страницах — крестиков на плитках больше нет.
 */

document.addEventListener('DOMContentLoaded', function () {
  // ── Вкладки профиля ─────────────────────────────────────────────────────
  // Обе вкладки уже на странице. Открытая — в адресе (#photos, #videos):
  // «назад» со страницы видео возвращает на ту же вкладку.
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-gal-tab]'));
  var pick = function (name, remember) {
    tabs.forEach(function (b) {
      var on = b.getAttribute('data-gal-tab') === name;
      b.classList.toggle('tk-tabs__item--on', on);
      b.setAttribute('aria-selected', String(on));
      document.getElementById(b.getAttribute('aria-controls')).hidden = !on;
    });
    if (remember) history.replaceState(null, '', '#' + name);
  };
  if (tabs.length) {
    tabs.forEach(function (b) {
      b.addEventListener('click', function () { pick(b.getAttribute('data-gal-tab'), true); });
    });
    if (location.hash === '#videos' || location.hash === '#photos') {
      pick(location.hash.slice(1), false);
      document.getElementById('gallery').scrollIntoView();
    }
  }

  // ── Свои ролики в работе ────────────────────────────────────────────────
  // Грузится (проценты приходят от фоновой загрузки, public/tk-upload.js),
  // ждёт публикации, пережимается.
  var gallery = document.getElementById('gallery');
  if (gallery && gallery.hasAttribute('data-own')) {
    var card = function (id) { return gallery.querySelector('.tk-recard[data-video-id="' + CSS.escape(id) + '"]'); };
    var state = function (el) { return el.querySelector('.tk-recard__state'); };

    // Ролик готов или не вышел — карточка без перезагрузки страницы.
    var paint = function (el, v) {
      el.className = 'tk-recard' + (v.status !== 'ready' ? ' is-' + v.status : '');
      el.href = '/video/' + encodeURIComponent(v.id);
      var thumb = el.querySelector('.tk-recard__thumb');
      if (v.status === 'ready') {
        if (v.thumb && !thumb.querySelector('img')) thumb.insertAdjacentHTML('afterbegin', '<img src="' + escapeHtml(v.thumb) + '" alt="">');
        var s = Math.round(v.duration || 0);
        state(el).outerHTML = '<span class="tk-recard__len">' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + '</span>';
        return;
      }
      window.tkText(state(el), v.status === 'failed' ? (v.error === 'long' ? 'user.videoLong' : 'user.videoFailed') : 'user.videoProcessing');
    };

    // Пока ролик пережимается — спрашиваем раз в 4 секунды.
    var watch = function (el, id) {
      setTimeout(function () {
        if (!el.isConnected) return;
        fetch('/profile/gallery/video/' + encodeURIComponent(id), { headers: { Accept: 'application/json' } })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
          .then(function (d) {
            if (d.video.status === 'processing') return watch(el, id);
            paint(el, d.video);
          })
          .catch(function () { watch(el, id); });
      }, 4000);
    };
    gallery.querySelectorAll('.tk-recard.is-processing[data-video-id]').forEach(function (el) {
      watch(el, el.getAttribute('data-video-id'));
    });

    document.addEventListener('tk:upload', function (e) {
      var d = e.detail;
      var el = card(d.id);
      if (!el) return;
      var label = el.querySelector('[data-upload-pct]');
      if (d.status === 'uploading' && label) {
        window.tkText(label, 'user.videoUploading', { p: Math.floor(d.received / d.size * 100) });
      } else if (d.status === 'processing' && !el.classList.contains('is-processing')) {
        if (label) label.removeAttribute('data-upload-pct');
        paint(el, { id: d.id, status: 'processing' });
        watch(el, d.id);
      } else if (d.status === 'draft' && el.classList.contains('is-uploading')) {
        location.reload(); // карточка черновика рисуется сервером
      }
    });
  }

  // ── Просмотр аватара ────────────────────────────────────────────────────
  var box = document.getElementById('lightbox');
  if (!box) return;
  var img = document.getElementById('lightboxImg');
  var close = function () { box.classList.add('hidden'); };

  document.addEventListener('click', function (e) {
    var avatar = e.target.closest('img[data-avatar-url]');
    if (!avatar) return;
    img.src = avatar.getAttribute('data-avatar-url');
    box.classList.remove('hidden');
  });
  document.getElementById('lightboxClose').addEventListener('click', close);
  box.addEventListener('click', function (e) {
    if (e.target === box || e.target === img) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !box.classList.contains('hidden')) close();
  });
});
