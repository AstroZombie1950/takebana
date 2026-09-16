// Общее у пульта ведущего и страницы зрителя: чат, время в эфире, счётчик
// зрителей, сокет комнаты эфира, метка состояния, полноэкранная сцена
// и раскрывающаяся шапка эфира на телефоне.
//
// Раньше это жило двумя копиями в инлайн-скриптах обоих шаблонов. Страницам
// наружу отдаются TKStream.onUpdate, TKStream.timer и TKStream.state. Скрипт
// стоит в конце <body>, до скриптов страницы: разметка к этому моменту разобрана.
(function () {
  // Подписи — из общего словаря (public/tk-i18n.js).
  var t = function (key, arg) { return window.t ? window.t(key, arg) : ''; };
  var data = document.body.dataset;
  var streamId = data.streamId;
  var streamKey = data.streamKey;

  // Телефон и планшет — та же граница, что у левой панели кабинета (app.css).
  var narrow = matchMedia('(max-width: 1023px)');

  // ── Чат ──
  // На широком экране новые сообщения снизу, поле ввода под ними. На узком
  // поле ввода над чатом (stream.css), и новые сообщения — сразу под полем:
  // палец и глаз остаются у верхнего края чата, а не прыгают к клавиатуре.
  var box = document.querySelector('.messeg-box');
  var input = document.querySelector('.input__messeng');
  var lastMessageTime = '';

  function toNewest() {
    box.scrollTop = narrow.matches ? 0 : box.scrollHeight;
  }

  function render(m) {
    if (m._id && box.querySelector('[data-message-id="' + m._id + '"]')) return;
    var el = document.createElement('div');
    // Своё сообщение отмечается классом: цвет решает stream.css.
    el.className = 'chat-message' + (String(m.userId) === data.userId ? ' chat-message--own' : '');
    if (m._id) el.dataset.messageId = m._id;
    el.innerHTML =
      '<p class="chat-message__line">' +
        '<span class="chat-message__who">' + escapeHtml(m.username) + '</span> ' +
        '<span class="chat-message__text">' + escapeHtml(m.message) + '</span>' +
      '</p>' +
      '<time class="chat-message__time">' +
        tkDate(m.createdAt, { hour: '2-digit', minute: '2-digit' }) +
      '</time>';
    if (narrow.matches) box.prepend(el); else box.appendChild(el);
    toNewest();
    if (m.createdAt > lastMessageTime) lastMessageTime = m.createdAt;
  }

  // Повернули планшет или растянули окно через границу — порядок наоборот.
  narrow.addEventListener('change', function () {
    Array.prototype.slice.call(box.children).reverse().forEach(function (el) { box.appendChild(el); });
    toNewest();
  });

  // Новые сообщения приходят сокетом. Запросом — только добор: при открытии
  // и после каждого входа в комнату, то есть и после обрыва. Повторы
  // отсекаются по data-message-id.
  function fetchMissed() {
    fetch('/api/chat/messages/new?streamId=' + streamId + '&lastMessageTime=' + encodeURIComponent(lastMessageTime))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) { list.forEach(render); })
      .catch(function (e) { console.error('[stream] чат не догрузился:', e); });
  }

  // Автора сервер берёт из сессии, поэтому уходят только эфир и текст.
  function send() {
    var text = input.value.trim();
    if (!text) return;
    fetch('/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamId: streamId, message: text }),
    }).then(function (r) {
      if (r.ok) { input.value = ''; return; }
      return r.json().catch(function () { return {}; }).then(function (b) {
        toast(b.message || t('chat.sendFailed'), 'error');
      });
    }, function () {
      toast(t('chat.offline'), 'error');
    });
  }

  // Гость чат читает, а поля ввода у него нет — ссылка на вход (streamChat.ejs).
  var chatForm = document.getElementById('chatForm');
  if (chatForm) {
    chatForm.addEventListener('submit', function (e) {
      e.preventDefault();
      send();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
  }

  // ── Время в эфире — с выхода в эфир, а не с создания записи ──
  var durationEl = document.getElementById('streamDuration');
  var timerId = null;

  function pad(n) { return String(n).padStart(2, '0'); }

  function stopTimer() {
    clearInterval(timerId);
    timerId = null;
    durationEl.textContent = '00:00:00';
  }

  function startTimer(since) {
    stopTimer();
    var t0 = new Date(since).getTime();
    function tick() {
      var s = Math.max(0, Math.floor((Date.now() - t0) / 1000));
      durationEl.textContent = pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60);
    }
    tick();
    timerId = setInterval(tick, 1000);
  }

  // ── Метка состояния: в эфире, пауза, ждём сигнал OBS ──
  var badge = document.getElementById('stateBadge');
  var STATE_KEYS = { live: 'stream.hintLive', paused: 'stream.pausedBadge', wait: 'stream.waitObs' };

  function setState(state) {
    badge.dataset.state = state;
    badge.classList.toggle('tk-live__badge--live', state === 'live');
    tkText(badge.querySelector('span'), STATE_KEYS[state]);
  }

  // ── Счётчик зрителей. Ведущего сервер не считает (sockets/index.js) ──
  var viewersNum = document.querySelector('.viewers-number');
  var viewersText = document.querySelector('.viewers-text');

  // Формы слова — из словаря: по-английски «few» и «many» совпадают,
  // поэтому те же правила годятся для обоих языков.
  function viewersKey(n) {
    var d10 = n % 10, d100 = n % 100;
    if (d10 === 1 && d100 !== 11) return 'stream.viewerOne';
    if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return 'stream.viewerFew';
    return 'stream.viewerMany';
  }

  // ── Сокет ──
  var updateHandlers = [];
  var socket = io(window.location.origin, { transports: ['websocket'] });

  // В socket.io 4 'connect' приходит и после каждого переподключения: вход
  // в комнату и добор чата повторяются сами.
  socket.on('connect', function () {
    socket.emit('join-stream-room', streamKey, fetchMissed);
  });
  socket.on('chat:message', render);
  socket.on('viewers-count-updated', function (d) {
    if (d.streamKey !== streamKey) return;
    viewersNum.textContent = d.count;
    // Через tkText: ключ остаётся на элементе, и слово переводится
    // при переключении языка, а не только при следующем обновлении счётчика.
    tkText(viewersText, viewersKey(d.count));
  });
  socket.on('stream:update', function (u) {
    if (!u || u.streamKey !== streamKey) return;
    updateHandlers.forEach(function (fn) { fn(u); });
  });

  // Страховка на случай, если сокет не поднялся: история придёт и без него.
  fetchMissed();
  if (data.startedAt) startTimer(data.startedAt);

  // ── Сцена на весь экран: картинка и чат, больше ничего ──
  // Разворачивается вся сцена, а не видео: иначе чат пропадает. Где браузер
  // даёт полноэкранный режим элементу — берём его; iPhone даёт его только
  // самому <video>, со своим плеером и без чата, — там сцена просто
  // растягивается на окно (класс is-full, stream.css).
  var stage = document.getElementById('stage');
  var fsButtons = document.querySelectorAll('[data-fullscreen]');
  var chatButtons = document.querySelectorAll('[data-chat-toggle]');

  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement; }

  // Подпись кнопки по состоянию: ключи словаря для «вкл» и «выкл».
  function label(b, on, keyOn, keyOff) {
    var key = on ? keyOn : keyOff;
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('data-i18n-aria', key);
    b.setAttribute('data-i18n-title', key);
    b.setAttribute('aria-label', t(key));
    b.title = t(key);
  }

  // Чат поверх картинки во весь экран — на телефоне по кнопке: картинка
  // должна быть видна целиком, а чат закрывал бы и её, и кнопки плеера.
  function markChat(on) {
    stage.classList.toggle('chat-open', on);
    chatButtons.forEach(function (b) { label(b, on, 'stream.chatHide', 'stream.chatShow'); });
    if (on) toNewest();
  }

  function markFull(on) {
    stage.classList.toggle('is-full', on);
    if (!on) markChat(false);
    document.documentElement.classList.toggle('tk-stage-open', on);
    fsButtons.forEach(function (b) { label(b, on, 'stream.exitFullscreen', 'stream.fullscreen'); });
    toNewest();
  }

  function toggleFull() {
    var on = !stage.classList.contains('is-full');
    if (on) {
      var request = stage.requestFullscreen || stage.webkitRequestFullscreen;
      if (request) {
        var p = request.call(stage);
        if (p && p.catch) p.catch(function () {});
      }
    } else if (fsElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    }
    markFull(on);
  }

  fsButtons.forEach(function (b) { b.addEventListener('click', toggleFull); });
  chatButtons.forEach(function (b) {
    b.addEventListener('click', function () { markChat(!stage.classList.contains('chat-open')); });
  });
  // Вышли клавишей Esc или жестом системы — сцена возвращается на место.
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
    document.addEventListener(ev, function () {
      if (!fsElement() && stage.classList.contains('is-full')) markFull(false);
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && stage.classList.contains('is-full') && !fsElement()) markFull(false);
  });

  // ── Шапка эфира на телефоне: автор, подписка, описание — по кнопке ──
  var infoToggle = document.getElementById('infoToggle');
  infoToggle.addEventListener('click', function () {
    var open = infoToggle.getAttribute('aria-expanded') !== 'true';
    infoToggle.setAttribute('aria-expanded', String(open));
    document.getElementById('streamInfo').classList.toggle('is-open', open);
  });

  window.TKStream = {
    onUpdate: function (fn) { updateHandlers.push(fn); },
    timer: { start: startTimer, stop: stopTimer },
    state: setState,
  };
})();
