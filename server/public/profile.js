/* Страница пользователя: сообщение, подписка, звонки, просмотр фотографий.
 *
 * Раньше жил инлайном в userPage.ejs. Из EJS сюда приходили три значения,
 * они переехали в window.TK_PROFILE.
 *
 * Закомментированный блок «Социальные сети» (40 строк разметки-заглушки)
 * при переверстке удалён: история есть в git.
 */

var P = window.TK_PROFILE || { userId: '', displayName: '', avatarUrl: '' };

// Подписи — из общего словаря (public/tk-i18n.js): свой переводчик
// с запасными строками здесь стоял, пока у кабинета был отдельный словарь.
var pt = function (key) { return window.t ? window.t(key) : ''; };

document.addEventListener('DOMContentLoaded', function () {

  // ── Написать сообщение ──────────────────────────────────────────────────
  var messageButton = document.getElementById('message-button');
  if (messageButton) {
    messageButton.addEventListener('click', function () {
      fetch('/start-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientId: P.userId })
      })
        .then(function (r) {
          if (!r.ok) throw new Error('Network response was not ok');
          return r.json();
        })
        .then(function (data) {
          if (data.success) {
            // ?peer=<id собеседника>, а не conversationId: список диалогов
            // помечен идентификатором собеседника, и chats.js открывает
            // нужный сразу. Прежний conversationId не читал никто.
            window.location.href = '/chatsPage?peer=' + encodeURIComponent(P.userId);
          }
        })
        .catch(function (e) { console.error('start-conversation:', e); });
    });
  }

  // ── Подписка ────────────────────────────────────────────────────────────
  var subscribeButton = document.querySelector('.subscribe__button');
  if (subscribeButton) {
    var label = subscribeButton.querySelector('[data-i18n]');

    async function toggleSubscription() {
      var off = subscribeButton.classList.contains('unsubscribe');
      try {
        var response = await fetch(off ? '/unsubscribe' : '/subscribe', {
          method: off ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: P.userId })
        });

        if (response.ok) {
          var body = await response.json().catch(function () { return {}; });
          if (window.tkSubscriptions) {
            if (off) window.tkSubscriptions.remove(P.userId);
            else window.tkSubscriptions.add(body.user);
          }
          subscribeButton.classList.toggle('unsubscribe', !off);
          // Число подписчиков — сразу, без перезагрузки: сервер вернул свежее.
          var followers = document.getElementById('followersCount');
          if (followers && typeof body.followers === 'number') followers.textContent = body.followers;
          // Ключ словаря меняем вместе с текстом: иначе следующее
          // переключение языка вернёт прежнюю подпись.
          window.tkText(label, off ? 'stream.subscribe' : 'stream.unsubscribe');
          return;
        }

        var result = await response.json().catch(function () { return {}; });
        toast(result.message || (off
          ? pt('stream.unsubscribeFailed')
          : pt('stream.subscribeFailed')), 'error');
      } catch (e) {
        console.error('subscribe:', e);
      }
    }

    subscribeButton.addEventListener('click', toggleSubscription);
  }

  // ── Звонки ──────────────────────────────────────────────────────────────
  function call(type) {
    if (!window.showOutgoingCall) return;
    window._lastCallType = type;
    window.showOutgoingCall({
      userId: P.userId,
      displayName: P.displayName,
      avatarUrl: P.avatarUrl,
      callType: type
    });
    if (type === 'audio' && window.startAudioCall) window.startAudioCall(P.userId);
    if (type === 'video' && window.startVideoCall) window.startVideoCall(P.userId);
  }

  var videoBtn = document.getElementById('video-call-button');
  var audioBtn = document.getElementById('audio-call-button');
  if (videoBtn) videoBtn.addEventListener('click', function () { call('video'); });
  if (audioBtn) audioBtn.addEventListener('click', function () { call('audio'); });

  // ── Своя галерея: загрузка и удаление ──────────────────────────────────
  // Раньше это жило в настройках, а здесь было видно только результат.
  // Выбрал файлы — они сразу уходят на сервер (сжатие и подгонка размера —
  // utils/image.js); без промежуточного «Загрузить (N)».
  var gallery = document.getElementById('gallery');
  if (gallery && gallery.hasAttribute('data-own')) {
    var shots = document.getElementById('galleryShots');
    var input = document.getElementById('galleryInput');
    var hint = document.getElementById('galleryHint');
    var countEl = document.getElementById('galleryCount');
    var empty = document.getElementById('galleryEmpty');
    var CROSS = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"></path></svg>';

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
    // пережимаются или не вышли.
    var recount = function () {
      countEl.textContent = String(shots.querySelectorAll('.tk-shots__item:not(.is-uploading):not(.is-processing):not(.is-failed)').length);
      empty.hidden = shots.children.length > 0;
    };

    var say = function (key, vars) { if (hint) window.tkText(hint, key, vars); };

    var shotHtml = function (url) {
      var name = url.split('/').pop();
      return '<div class="tk-shots__item"><button type="button" class="tk-shot" aria-label="' + escapeHtml(pt('user.gallery')) + '">' +
        '<img src="' + escapeHtml(url) + '" alt="" loading="lazy" decoding="async" data-photo-url="' + escapeHtml(url) + '"></button>' +
        '<button type="button" class="tk-thumb__del" data-name="' + escapeHtml(name) + '" aria-label="' + escapeHtml(pt('common.delete')) + '" data-i18n-aria="common.delete">' + CROSS + '</button></div>';
    };

    // ── Видео: загрузка с процентами, потом ожидание пережатия ──
    var VIDEO_MAX = 300 * 1024 * 1024;
    var PLAY = '<span class="tk-shot__play" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5.5v13L20 12z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></span>';
    var clock = function (s) { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

    var videoInner = function (v) {
      if (v.status === 'ready') {
        return '<button type="button" class="tk-shot tk-shot--video" data-video-url="' + escapeHtml(v.url) + '" data-video-poster="' + escapeHtml(v.thumb) + '" aria-label="' + escapeHtml(pt('user.videoPlay')) + '">' +
          (v.thumb ? '<img src="' + escapeHtml(v.thumb) + '" alt="" loading="lazy" decoding="async">' : '') + PLAY +
          '<span class="tk-shot__len">' + clock(v.duration) + '</span></button>';
      }
      var key = v.status === 'failed' ? (v.error === 'long' ? 'user.videoLong' : 'user.videoFailed') : 'user.videoProcessing';
      return '<div class="tk-shot tk-shot--state"><span data-i18n="' + key + '">' + escapeHtml(pt(key)) + '</span></div>';
    };

    var videoTile = function (v) {
      var el = document.createElement('div');
      el.className = 'tk-shots__item' + (v.status !== 'ready' ? ' is-' + v.status : '');
      if (v.id) el.setAttribute('data-video-id', v.id);
      el.innerHTML = videoInner(v) +
        '<button type="button" class="tk-thumb__del" data-video-del aria-label="' + escapeHtml(pt('common.delete')) + '" data-i18n-aria="common.delete">' + CROSS + '</button>';
      return el;
    };

    var paintVideo = function (el, v) {
      el.className = 'tk-shots__item' + (v.status !== 'ready' ? ' is-' + v.status : '');
      el.firstElementChild.outerHTML = videoInner(v);
      recount();
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

    // XHR, а не fetch: у fetch нет прогресса отправки, а ролик на сотни
    // мегабайт без процентов выглядит зависшим.
    var uploadVideo = function (file) {
      var el = videoTile({ status: 'uploading' });
      el.firstElementChild.innerHTML = '<span></span>';
      var label = el.firstElementChild.firstChild;
      window.tkText(label, 'user.videoUploading', { p: 0 });
      shots.insertBefore(el, shots.firstChild);
      recount();
      var form = new FormData();
      form.append('video', file);
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/profile/gallery/video');
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) window.tkText(label, 'user.videoUploading', { p: Math.floor(e.loaded / e.total * 100) });
      };
      xhr.onload = function () {
        var d = {};
        try { d = JSON.parse(xhr.responseText); } catch (_) {}
        if (xhr.status !== 200 || !d.video) {
          el.remove();
          recount();
          return toast(window.t('app.errorShort', { message: d.message || 'HTTP ' + xhr.status }), 'error');
        }
        el.setAttribute('data-video-id', d.video.id);
        paintVideo(el, d.video);
        watch(el, d.video.id);
      };
      xhr.onerror = function () {
        el.remove();
        recount();
        toast(window.t('common.noNetwork'), 'error');
      };
      xhr.send(form);
    };

    var upload = function (list) {
      var all = Array.prototype.slice.call(list || []);
      var videos = all.filter(function (f) { return /^video\//.test(f.type) && f.size <= VIDEO_MAX; });
      var files = all.filter(function (f) {
        return /^image\/(png|jpeg|webp)$/.test(f.type) && f.size <= 10 * 1024 * 1024;
      });
      if (!files.length && !videos.length) return say('user.galleryBadFiles');
      videos.forEach(uploadVideo);
      if (!files.length) return;
      var form = new FormData();
      files.forEach(function (f) { form.append('photos', f); });
      say('app.uploading');
      json('/profile/gallery', { method: 'POST', body: form })
        .then(function (d) {
          shots.insertAdjacentHTML('beforeend', (d.urls || []).map(shotHtml).join(''));
          recount();
          say('app.galleryDone', { total: d.total });
        })
        .catch(function (err) { say('user.galleryLimit'); toast(window.t('app.errorShort', { message: err.message }), 'error'); });
    };

    document.getElementById('galleryAdd').addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { upload(input.files); input.value = ''; });

    // Файлы можно бросить на всю секцию галереи.
    gallery.addEventListener('dragover', function (e) { e.preventDefault(); gallery.classList.add('is-over'); });
    gallery.addEventListener('dragleave', function (e) { if (!gallery.contains(e.relatedTarget)) gallery.classList.remove('is-over'); });
    gallery.addEventListener('drop', function (e) {
      e.preventDefault();
      gallery.classList.remove('is-over');
      upload(e.dataTransfer.files);
    });

    shots.addEventListener('click', function (e) {
      var vdel = e.target.closest('[data-video-del]');
      if (vdel) {
        var tile = vdel.closest('.tk-shots__item');
        var vid = tile.getAttribute('data-video-id');
        if (!vid) return; // ещё грузится — удалить нечего
        confirmDialog(pt('user.videoDeleteQ'), { okText: pt('common.delete') }).then(function (yes) {
          if (!yes) return;
          tile.classList.add('is-busy');
          return json('/profile/gallery/video/' + encodeURIComponent(vid), { method: 'DELETE' })
            .then(function () { tile.remove(); recount(); })
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
          .then(function () { item.remove(); recount(); })
          .catch(function (err) {
            item.classList.remove('is-busy');
            toast(window.t('app.deleteError', { message: err.message }), 'error');
          });
      });
    });
  }

  // ── Просмотр видео: плеер Takebana в окне ──────────────────────────────
  // Плеер один на все ролики: при открытии — новый источник, при закрытии —
  // остановка и отпущенный файл, чтобы звук не играл за закрытым окном.
  var videoBox = document.getElementById('videoBox');
  if (videoBox && window.TKPlayer) {
    var vplayer = null;
    var closeVideo = function () {
      if (videoBox.classList.contains('hidden')) return;
      videoBox.classList.add('hidden');
      if (vplayer) vplayer.stop();
    };
    document.addEventListener('click', function (e) {
      var v = e.target.closest('[data-video-url]');
      if (!v) return;
      if (!vplayer) vplayer = TKPlayer.mount(videoBox.querySelector('.tk-player'));
      videoBox.classList.remove('hidden');
      vplayer.load(v.getAttribute('data-video-url'), v.getAttribute('data-video-poster'));
    });
    document.getElementById('videoBoxClose').addEventListener('click', closeVideo);
    videoBox.addEventListener('click', function (e) { if (e.target === videoBox) closeVideo(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeVideo(); });
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
