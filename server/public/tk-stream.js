// Общее у страниц эфира — пульта ведущего и страницы зрителя: комната эфира
// в сокете, счётчик зрителей, чат, таймер «Онлайн», выдвижной чат и полный
// экран. Раньше у каждой страницы была своя копия, и копии расходились.
//
// Данные — из data-атрибутов <body>: stream-id, stream-key, user-id,
// started-at. Своё страницы делают сами, а сюда подключаются через
// TKStream.onUpdate, TKStream.timer и TKStream.fullscreen. Скрипт стоит в
// конце <body>, до скриптов страницы: разметка к этому моменту разобрана.
(function () {
  // Подписи — из общего словаря (public/tk-i18n.js).
  var t = function (key, arg) { return window.t ? window.t(key, arg) : ''; };
  var data = document.body.dataset;
  var streamId = data.streamId;
  var streamKey = data.streamKey;

  // ── Чат ──
  var box = document.querySelector('.messeg-box');
  var input = document.querySelector('.input__messeng');
  var lastMessageTime = '';

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
        new Date(m.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) +
      '</time>';
    box.appendChild(el);
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    if (m.createdAt > lastMessageTime) lastMessageTime = m.createdAt;
  }

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

  document.querySelector('.starting__buttone').addEventListener('click', send);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  // ── Выдвижной чат: ниже 1100px он уезжает в панель (stream.css) ──
  var chat = document.querySelector('.chat-container');
  var overlay = document.getElementById('chatOverlay');

  function drawer(open) {
    chat.classList.toggle('open', open);
    overlay.style.display = open ? 'block' : '';
    document.body.style.overflow = open ? 'hidden' : '';
  }

  document.getElementById('chatTab').addEventListener('click', function () { drawer(true); });
  document.querySelector('.close-chat-btn').addEventListener('click', function () { drawer(false); });
  overlay.addEventListener('click', function () { drawer(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && chat.classList.contains('open')) drawer(false);
  });

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
  // в комнату и добор чата повторяются сами. Событие 'reconnect' у сокета,
  // на которое рассчитывали прежние копии, в v4 не срабатывает вовсе.
  socket.on('connect', function () {
    socket.emit('join-stream-room', streamKey, fetchMissed);
  });
  socket.on('chat:message', render);
  socket.on('viewers-count-updated', function (d) {
    if (d.streamKey !== streamKey) return;
    viewersNum.textContent = d.count;
    // Через tkText: ключ остаётся на элементе, и слово переводится
    // при переключении языка, а не только при следующем обновлении счётчика.
    if (window.tkText) window.tkText(viewersText, viewersKey(d.count));
    else viewersText.textContent = t(viewersKey(d.count));
  });
  socket.on('stream:update', function (u) {
    if (!u || u.streamKey !== streamKey) return;
    updateHandlers.forEach(function (fn) { fn(u); });
  });

  // Страховка на случай, если сокет не поднялся: история придёт и без него.
  fetchMissed();
  if (data.startedAt) startTimer(data.startedAt);

  // ── Полный экран: плеер целиком, с метками и кнопками. iPhone умеет
  //    только само видео — там полноэкранный режим <video> ──
  function fullscreen(container, video) {
    var d = document;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    } else if (container.requestFullscreen) {
      container.requestFullscreen();
    } else if (container.webkitRequestFullscreen) {
      container.webkitRequestFullscreen();
    } else if (video && video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    }
  }

  window.TKStream = {
    onUpdate: function (fn) { updateHandlers.push(fn); },
    timer: { start: startTimer, stop: stopTimer },
    fullscreen: fullscreen,
  };
})();
