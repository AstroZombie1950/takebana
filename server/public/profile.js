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
var pt = function (key, vars) { return window.t ? window.t(key, vars) : ''; };

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
          return r.json().catch(function () { return {}; }).then(function (data) {
            // Ограничение доступа (utils/restrict.js) — отказ с объяснением.
            if (!r.ok) throw new Error(data.message || 'HTTP ' + r.status);
            return data;
          });
        })
        .then(function (data) {
          if (data.success) {
            // ?peer=<id собеседника>, а не conversationId: список диалогов
            // помечен идентификатором собеседника, и chats.js открывает
            // нужный сразу. Прежний conversationId не читал никто.
            window.location.href = '/chatsPage?peer=' + encodeURIComponent(P.userId);
          }
        })
        .catch(function (e) { toast(e.message, 'error'); });
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

    // Подписка поменялась не здесь: в другой вкладке или автор убрал меня
    // из подписчиков (utils/profileSignal.js). Новую строку в левую панель
    // добавит клик в той вкладке — здесь только кнопка.
    document.addEventListener('tk:follow:changed', function (e) {
      if (e.detail.peerId !== P.userId) return;
      var on = !!e.detail.subscribed;
      if (subscribeButton.classList.contains('unsubscribe') === on) return;
      subscribeButton.classList.toggle('unsubscribe', on);
      window.tkText(label, on ? 'stream.unsubscribe' : 'stream.subscribe');
    });
  }

  // ── Меню «⋯»: жалоба и ограничение ─────────────────────────────────────
  // Закрывается кликом мимо, Esc и выбором пункта (окно жалобы и вопрос
  // об ограничении открываются уже без него).
  var moreBtn = document.getElementById('profMore');
  var menu = document.getElementById('profMenu');
  if (moreBtn && menu) {
    // keyboard — открыли с клавиатуры: фокус переезжает на первый пункт.
    var setMenu = function (open, keyboard) {
      menu.hidden = !open;
      moreBtn.setAttribute('aria-expanded', String(open));
      if (open && keyboard) menu.querySelector('button').focus();
    };
    moreBtn.addEventListener('click', function (e) { e.stopPropagation(); setMenu(menu.hidden, e.detail === 0); });
    menu.addEventListener('click', function () { setMenu(false); });
    document.addEventListener('click', function (e) { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.hidden) { setMenu(false); moreBtn.focus(); }
    });
  }

  // ── Ограничить доступ к каналу (utils/restrict.js) ──────────────────────
  var restrictButton = document.getElementById('restrictButton');
  if (restrictButton) {
    restrictButton.addEventListener('click', function () {
      var on = !restrictButton.getAttribute('data-on');
      var ask = on ? confirmDialog(pt('user.restrictQ', { name: P.displayName }), { okText: pt('user.restrict') }) : Promise.resolve(true);
      // Метка доступа страницы — до запроса: событие access:changed этой же
      // вкладке может прийти раньше ответа, и она перезагрузилась бы зря.
      var owner = document.querySelector('meta[name="tk-owner"]');
      var was = owner ? owner.dataset.access : '';
      ask.then(function (yes) {
        if (!yes) return;
        if (owner) owner.dataset.access = on ? 'me' : '';
        return fetch('/restrict', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: P.userId, on: on })
        }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (data) {
            if (!r.ok) throw new Error(data.message || 'HTTP ' + r.status);
            restrictButton.setAttribute('data-on', on ? '1' : '');
            // Ограничение закрывает и общение — кнопки «Написать» и звонков
            // уходят вместе с ним и возвращаются, когда доступ вернули.
            var talk = document.getElementById('talkActions');
            if (talk) talk.hidden = on;
            window.tkText(restrictButton.querySelector('[data-i18n]'), on ? 'user.unrestrict' : 'user.restrict');
            toast(pt(on ? 'user.restricted' : 'user.unrestricted', { name: P.displayName }), 'ok');
          });
        });
      }).catch(function (e) {
        if (owner) owner.dataset.access = was;
        toast(e.message, 'error');
      });
    });
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
    // пережимаются или не вышли.
    var recount = function () {
      countEl.textContent = String(shots.querySelectorAll('.tk-shots__item:not([class*=" is-"])').length);
      empty.hidden = shots.children.length > 0;
    };

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

// ── Запись эфира: готова или не склеилась ────────────────────────────────
// Склейка идёт минуты и в стороне от запроса. До 20.09.2026 автор не узнавал
// о её конце вовсе: карточка держала «обрабатывается», пока страницу не
// обновят руками, а про неудачу не говорил никто — запись просто пропадала.
// Событие шлёт utils/recording.js, проброс — tk-app.js.
document.addEventListener('tk:recording:status', function (e) {
  var d = e.detail || {};
  var card = document.querySelector('.tk-recard[data-rec-id="' + CSS.escape(String(d.id || '')) + '"]');
  if (!card) return;

  card.classList.remove('is-processing', 'is-failed');
  var state = card.querySelector('.tk-recard__state');
  var thumbBox = card.querySelector('.tk-recard__thumb');

  if (d.status === 'ready') {
    if (d.thumb && thumbBox && !thumbBox.querySelector('img')) {
      var img = document.createElement('img');
      img.src = d.thumb;
      img.alt = '';
      img.loading = 'lazy';
      thumbBox.insertBefore(img, thumbBox.firstChild);
    }
    if (state) {
      // Подпись «обрабатывается» уступает место длительности — так же,
      // как её рисует сервер у готовой записи (views/userPage.ejs).
      var sec = Math.round(d.duration || 0);
      state.className = 'tk-recard__len';
      state.removeAttribute('data-i18n');
      state.textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    }
    if (window.toast && window.t) window.toast(window.t('rec.readyToast'), 'ok');
    return;
  }

  card.classList.add('is-failed');
  if (state && window.tkText) window.tkText(state, 'rec.failed');
  if (window.toast && window.t) window.toast(window.t('rec.failedToast'), 'error');
});
