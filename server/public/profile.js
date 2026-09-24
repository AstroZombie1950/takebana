/* Страница пользователя: сообщение, подписка, звонки. Галерея и просмотр
 * фото — public/gallery.js, общий со страницей галереи.
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

  // ── Контакты ────────────────────────────────────────────────────────────
  // Записная книжка (models/Contact.js): пункт в меню «⋯» переключает
  // «В контакты» ↔ «Убрать из контактов». Связь односторонняя, собеседнику
  // ничего не уходит, поэтому и подтверждения при добавлении нет.
  var contactButton = document.getElementById('contactButton');
  if (contactButton) {
    contactButton.addEventListener('click', function () {
      var on = !contactButton.getAttribute('data-on');
      var ask = on ? Promise.resolve(true)
        : confirmDialog(pt('contacts.removeQ', { name: P.displayName }), { okText: pt('contacts.remove') });
      ask.then(function (yes) {
        if (!yes) return;
        return fetch(on ? '/api/contacts/add' : '/api/contacts/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(on ? { peerId: P.userId, source: 'profile' } : { peerId: P.userId })
        }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (data) {
            if (!r.ok) throw new Error(data.message || 'HTTP ' + r.status);
            contactButton.setAttribute('data-on', on ? '1' : '');
            window.tkText(contactButton.querySelector('[data-i18n]'), on ? 'contacts.remove' : 'contacts.add');
            if (on) toast(pt('contacts.added', { name: P.displayName }), 'ok');
          });
        });
      }).catch(function (e) { toast(e.message, 'error'); });
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
