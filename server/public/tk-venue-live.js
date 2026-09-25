/* Страница камеры заведения (views/venueLive.ejs, с 24.09).
 *
 * Владелец: включает и выключает камеру, видит свою картинку, выключает
 * микрофон, меняет камеру. Гость: смотрит; камеру включили или выключили —
 * плеер подключается или гаснет сам (событие venue:state). У обоих чат
 * и счётчик зрителей — сокетом, комната venue:<id> (sockets/index.js).
 *
 * Движок называет сервер (routes/venueLive.js): whip/whep — свой приём
 * (public/tk-whip.js), без engine — комната Daily (public/tk-daily.js).
 * Раньше то же жило на карте без интерфейса: владелец включал камеру
 * кнопкой в списке заведений и не видел ничего.
 */
(function () {
  var t = function (k, v) { return window.t ? window.t(k, v) : ''; };
  var $ = function (id) { return document.getElementById(id); };
  var data = document.body.dataset;
  var ID = data.venueId;
  var ME = data.userId;
  var OWNER = !!data.owner;
  var online = !!data.online;

  var video = $('venueVideo');
  var hint = $('venueHint');
  var hintTitle = $('venueHintTitle');
  var hintText = $('venueHintText');
  var badge = $('stateBadge');
  var viewersBadge = $('viewersBadge');
  var narrow = matchMedia('(max-width: 1023px)');

  function json(url, method, body) {
    return fetch(url, {
      method: method || 'GET',
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.message || 'HTTP ' + r.status); e.status = r.status; throw e; }
        return d;
      });
    });
  }

  // ── Картинка и заставка ────────────────────────────────────────────────
  // Заставка: короткий заголовок и объяснение; без обоих — её нет.
  var HINTS = {
    off: ['vlive.offBadge', 'vlive.off'],
    ownerOff: ['vlive.offBadge', 'vlive.ownerOff'],
    login: ['stream.hintLive', 'vlive.login'],
    restricted: ['', 'restricted.text'],
    connecting: ['studio.connecting', ''],
    lost: ['vlive.lostTitle', 'vlive.lost'],
    elsewhere: ['stream.hintLive', 'vlive.elsewhere'],
  };
  function say(name) {
    var h = HINTS[name] || ['', ''];
    hint.hidden = !name;
    [[hintTitle, h[0]], [hintText, h[1]]].forEach(function (p) {
      p[0].hidden = !p[1];
      if (p[1]) tkText(p[0], p[1]);
    });
  }

  function show(stream) {
    video.srcObject = stream;
    video.hidden = !stream;
    var wm = $('venueWm');
    if (wm) wm.hidden = !stream;
    if (stream) say('');
  }

  function markOnline(on) {
    online = on;
    badge.classList.toggle('tk-live__badge--live', on);
    tkText(badge.lastElementChild, on ? 'stream.hintLive' : 'vlive.offBadge');
    viewersBadge.hidden = !on;
  }

  // Формы слова «зритель» — те же правила, что у эфира (tk-stream.js).
  function viewersKey(n) {
    var d10 = n % 10, d100 = n % 100;
    if (d10 === 1 && d100 !== 11) return 'stream.viewerOne';
    if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return 'stream.viewerFew';
    return 'stream.viewerMany';
  }

  function viewers(n) {
    $('viewersNum').textContent = String(n);
    tkText($('viewersText'), viewersKey(n));
  }

  // ── Чат ────────────────────────────────────────────────────────────────
  // Порядок как у эфира: на широком экране новые снизу, на узком — сверху,
  // под полем ввода (stream.css).
  var box = $('chatBox');
  var last = '';

  function toNewest() { box.scrollTop = narrow.matches ? 0 : box.scrollHeight; }

  function render(m) {
    if (m._id && box.querySelector('[data-message-id="' + m._id + '"]')) return;
    var el = document.createElement('div');
    el.className = 'chat-message' + (String(m.userId) === ME ? ' chat-message--own' : '');
    if (m._id) el.dataset.messageId = m._id;
    el.innerHTML = '<p class="chat-message__line"><span class="chat-message__who">' + escapeHtml(m.username) + '</span> ' +
      '<span class="chat-message__text">' + escapeHtml(m.message) + '</span></p>' +
      '<time class="chat-message__time">' + tkDate(m.createdAt, { hour: '2-digit', minute: '2-digit' }) + '</time>';
    if (narrow.matches) box.prepend(el); else box.appendChild(el);
    toNewest();
    if (m.createdAt > last) last = m.createdAt;
  }

  narrow.addEventListener('change', function () {
    Array.prototype.slice.call(box.children).reverse().forEach(function (el) { box.appendChild(el); });
    toNewest();
  });

  function fetchMissed() {
    json('/api/venues/' + ID + '/chat?since=' + encodeURIComponent(last))
      .then(function (list) { list.forEach(render); })
      .catch(function () {});
  }

  var form = $('chatForm');
  if (form) {
    var input = form.querySelector('textarea');
    var send = function () {
      var text = input.value.trim();
      if (!text) return;
      json('/api/venues/' + ID + '/chat', 'POST', { message: text })
        .then(function () { input.value = ''; })
        .catch(function (e) { toast(e.message || t('chat.sendFailed'), 'error'); });
    };
    form.addEventListener('submit', function (e) { e.preventDefault(); send(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
  }

  // ── Показ: подключение к камере ────────────────────────────────────────
  var session = null;

  // Гость: смотреть. Нет входа или доступ закрыт — плеера нет вовсе
  // (движки страница не грузит, views/venueLive.ejs).
  var canWatch = !OWNER && !!ME && !!window.TKWhip;
  var closedHint = OWNER || canWatch ? '' : ME ? 'restricted' : 'login';
  var soundBtn = $('soundBtn');

  // Со звуком браузер запускает видео не всегда: не вышло — без звука
  // и кнопка «Включить звук».
  function play() {
    video.muted = false;
    video.play().then(function () { if ($('viewerBar')) $('viewerBar').hidden = true; }).catch(function () {
      video.muted = true;
      video.play().catch(function () {});
      if ($('viewerBar')) $('viewerBar').hidden = false;
    });
  }
  if (soundBtn) soundBtn.addEventListener('click', function () { play(); });

  function watch() {
    if (!canWatch || session) return;
    say('connecting');
    json('/api/venues/' + ID + '/watch', 'POST', {}).then(function (first) {
      if (first.engine === 'whep') {
        session = TKWhip.view(first.url, {
          onStream: function (stream) { show(stream); play(); },
          onState: function (s) { if (s === 'ended') unwatch(); },
        });
        return;
      }
      var media = new MediaStream();
      var firstAccess = first;
      session = TKDaily.connect({
        send: false,
        access: function () {
          if (!firstAccess) return TKDaily.requestAccess('/api/venues/' + ID + '/watch');
          var a = firstAccess; firstAccess = null; return Promise.resolve(a);
        },
        onTrack: function (track, p, on) {
          if (p.local) return;
          if (on) media.addTrack(track); else media.removeTrack(track);
          show(media.getTracks().length ? media : null);
          if (on) play();
        },
        onState: function (s) { if (s === 'ended') unwatch(); },
      });
    }).catch(function (e) {
      session = null;
      if (e.status === 409) { markOnline(false); say('off'); }
      else say('lost');
    });
  }

  function unwatch() {
    if (session) { session.leave(); session = null; }
    show(null);
    if ($('viewerBar')) $('viewerBar').hidden = true;
    say(online ? 'lost' : 'off');
  }

  // ── Пульт владельца ────────────────────────────────────────────────────
  var liveBtn = $('liveBtn');
  var micBtn = $('micBtn');
  var cameraBtn = $('cameraBtn');
  var micOn = true;

  var approved = !!liveBtn && !liveBtn.disabled;

  function paintOwner(state) {
    // state: off | connecting | live | elsewhere (включена не с этой вкладки)
    liveBtn.disabled = state === 'connecting' || !approved;
    liveBtn.classList.toggle('tk-btn--primary', state === 'off');
    liveBtn.classList.toggle('tk-btn--danger', state !== 'off');
    tkText(liveBtn, state === 'off' ? 'venues.startLive' : state === 'connecting' ? 'venues.connecting' : 'venues.stopLive');
    micBtn.disabled = cameraBtn.disabled = state !== 'live' || !session;
    if (state === 'off') { micOn = true; paintMic(); }
  }

  function paintMic() {
    var key = micOn ? 'stream.micOff' : 'stream.micOn';
    micBtn.setAttribute('aria-pressed', String(!micOn));
    micBtn.setAttribute('aria-label', t(key));
    micBtn.title = t(key);
    micBtn.setAttribute('data-i18n-aria', key);
    micBtn.setAttribute('data-i18n-title', key);
  }

  function start() {
    paintOwner('connecting');
    say('connecting');
    json('/api/venues/' + ID + '/live', 'POST', {}).then(function (first) {
      var lost = function () { toast(t('venues.liveLost'), 'error'); stop(); };
      if (first.engine === 'whip') {
        session = TKWhip.publish(first.url, {
          onLocal: function (stream) { show(stream); video.play().catch(function () {}); },
          onMediaError: function () { toast(t('venues.mediaDenied'), 'error'); },
          onError: lost,
          onState: function (s) {
            if (s === 'live') { markOnline(true); paintOwner('live'); }
            if (s === 'ended' && session) lost();
          },
        });
        return;
      }
      var firstAccess = first;
      session = TKDaily.connect({
        send: true,
        video: true,
        // Повторный вход после обрыва — через /watch: комнату не
        // пересоздаём, иначе обрыв у владельца выкидывал бы всех гостей.
        access: function () {
          if (!firstAccess) return TKDaily.requestAccess('/api/venues/' + ID + '/watch');
          var a = firstAccess; firstAccess = null; return Promise.resolve(a);
        },
        onTrack: function (track, p, on) {
          if (!p.local || track.kind !== 'video') return;
          show(on ? new MediaStream([track]) : null);
          if (on) video.play().catch(function () {});
        },
        onMediaError: function () { toast(t('venues.mediaDenied'), 'error'); },
        onState: function (s) {
          if (s === 'live') { markOnline(true); paintOwner('live'); }
          if (s === 'ended' && session) lost();
        },
      });
    }).catch(function (e) {
      session = null;
      paintOwner('off');
      say('ownerOff');
      toast(e.message, 'error');
    });
  }

  function stop() {
    var s = session;
    session = null;
    if (s) s.leave();
    show(null);
    markOnline(false);
    paintOwner('off');
    say('ownerOff');
    return fetch('/api/venues/' + ID + '/live', { method: 'DELETE', keepalive: true }).catch(function () {});
  }

  if (OWNER) {
    liveBtn.addEventListener('click', function () {
      if (session || online) stop(); else start();
    });
    micBtn.addEventListener('click', function () {
      if (!session) return;
      micOn = !micOn;
      paintMic();
      session.setMic(micOn);
    });
    cameraBtn.addEventListener('click', function () {
      if (!session) return;
      cameraBtn.disabled = true;
      var p = session.switchCamera ? session.switchCamera()
        : session.call ? session.call.cycleCamera() : Promise.resolve();
      Promise.resolve(p).catch(function () { toast(t('venues.mediaDenied'), 'error'); })
        .then(function () { cameraBtn.disabled = !session; });
    });
    // Ушли со страницы с включённой камерой — гасим её на сервере, иначе
    // заведение висело бы «в эфире» без картинки. keepalive доносит
    // запрос и из закрывающейся вкладки.
    window.addEventListener('pagehide', function () {
      if (session) fetch('/api/venues/' + ID + '/live', { method: 'DELETE', keepalive: true });
    });
    // Камера уже включена — с другой вкладки или устройства. Не гасим её
    // молча: говорим об этом, и кнопка её выключает.
    if (online) { paintOwner('elsewhere'); say('elsewhere'); }
  }

  // ── Весь экран: картинка ───────────────────────────────────────────────
  // Где браузер даёт полноэкранный режим элементу — берём плеер целиком
  // (со знаком и метками). iPhone даёт его только самому <video>.
  var player = $('player');
  var fsBtn = document.querySelector('[data-fullscreen]');
  function fsEl() { return document.fullscreenElement || document.webkitFullscreenElement; }
  fsBtn.addEventListener('click', function () {
    if (fsEl()) return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    var req = player.requestFullscreen || player.webkitRequestFullscreen;
    if (req) { var r = req.call(player); if (r && r.catch) r.catch(function () {}); }
    else if (video.webkitEnterFullscreen && !video.hidden) video.webkitEnterFullscreen();
  });
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
    document.addEventListener(ev, function () {
      var on = !!fsEl();
      var key = on ? 'stream.exitFullscreen' : 'stream.fullscreen';
      fsBtn.setAttribute('aria-pressed', String(on));
      fsBtn.setAttribute('aria-label', t(key));
      fsBtn.title = t(key);
    });
  });

  // ── Сокет ──────────────────────────────────────────────────────────────
  var socket = io(window.location.origin, { transports: ['websocket', 'polling'], tryAllTransports: true });
  socket.on('connect', function () {
    socket.emit('venue:join', ID, function (r) { if (r && typeof r.count === 'number') viewers(r.count); });
    fetchMissed();
  });
  socket.on('venue:chat', function (m) { if (m.venueId === ID) render(m); });
  socket.on('venue:viewers', function (d) { if (d.venueId === ID) viewers(d.count); });
  socket.on('venue:state', function (d) {
    if (d.venueId !== ID) return;
    // Владелец: включили или выключили с другой вкладки.
    if (OWNER) {
      if (session) return;
      markOnline(d.online);
      paintOwner(d.online ? 'elsewhere' : 'off');
      return say(d.online ? 'elsewhere' : 'ownerOff');
    }
    markOnline(d.online);
    if (!canWatch) return say(closedHint === 'restricted' || d.online ? closedHint : 'off');
    if (d.online) watch(); else unwatch();
  });

  if (!OWNER && online) watch();
})();
