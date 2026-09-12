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
    var label = subscribeButton.querySelector('span[lng]');

    async function toggleSubscription() {
      var off = subscribeButton.classList.contains('unsubscribe');
      try {
        var response = await fetch(off ? '/unsubscribe' : '/subscribe', {
          method: off ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: P.userId })
        });

        if (response.ok) {
          subscribeButton.classList.toggle('unsubscribe', !off);
          // Ключ словаря меняем вместе с текстом: иначе следующее
          // переключение языка вернёт прежнюю подпись.
          label.setAttribute('lng', off ? '91' : '130');
          label.textContent = off
            ? pt('stream.subscribe')
            : pt('stream.unsubscribe');
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

  // ── Просмотр фотографии ─────────────────────────────────────────────────
  var box = document.getElementById('lightbox');
  if (!box) return;

  var img = document.getElementById('lightboxImg');
  var prev = document.getElementById('lightboxPrev');
  var next = document.getElementById('lightboxNext');
  var counter = document.getElementById('lightboxCounter');

  var photos = Array.prototype.map.call(
    document.querySelectorAll('img[data-photo-url]'),
    function (el) { return el.getAttribute('data-photo-url'); }
  );
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
