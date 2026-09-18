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

    var recount = function () {
      var n = shots.children.length;
      countEl.textContent = String(n);
      empty.hidden = n > 0;
    };

    var say = function (key, vars) { if (hint) window.tkText(hint, key, vars); };

    var shotHtml = function (url) {
      var name = url.split('/').pop();
      return '<div class="tk-shots__item"><button type="button" class="tk-shot" aria-label="' + escapeHtml(pt('user.gallery')) + '">' +
        '<img src="' + escapeHtml(url) + '" alt="" loading="lazy" decoding="async" data-photo-url="' + escapeHtml(url) + '"></button>' +
        '<button type="button" class="tk-thumb__del" data-name="' + escapeHtml(name) + '" aria-label="' + escapeHtml(pt('common.delete')) + '" data-i18n-aria="common.delete">' + CROSS + '</button></div>';
    };

    var upload = function (list) {
      var files = Array.prototype.filter.call(list || [], function (f) {
        return /^image\/(png|jpeg|webp)$/.test(f.type) && f.size <= 10 * 1024 * 1024;
      });
      if (!files.length) return say('user.galleryBadFiles');
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
