/* Страница камеры заведения (views/venueLive.ejs, с 24.09).
 *
 * Владелец: включает и выключает камеру, видит свою картинку, выключает
 * микрофон, меняет камеру. Гость: смотрит; камеру включили или выключили —
 * плеер подключается или гаснет сам (событие venue:state). У обоих чат
 * и счётчик зрителей — сокетом, комната venue:<id> (sockets/index.js).
 *
 * Движок называет сервер (routes/venueLive.js). Свой приём (engine
 * whip/hls, с 25.09): владелец вещает по WHIP (public/tk-whip.js), но
 * только пока камеру смотрят — сервер просит об этом событием venue:demand;
 * гость смотрит HLS через Bunny (public/tk-hls.js), знак уже в кадре.
 * Без engine — комната Daily (public/tk-daily.js).
 */
(function () {
  var t = function (k, v) { return window.t ? window.t(k, v) : ''; };
  var $ = function (id) { return document.getElementById(id); };
  var data = document.body.dataset;
  var ID = data.venueId;
  var ME = data.userId;
  var OWNER = !!data.owner;
  var RESTRICTED = !!data.restricted;
  var LOGIN_TO_WATCH = !!data.loginToWatch;
  var online = !!data.online;

  var video = $('venueVideo');
  var hint = $('venueHint');
  var hintTitle = $('venueHintTitle');
  var hintText = $('venueHintText');
  var badge = $('stateBadge');
  var viewersBadge = $('viewersBadge');
  var narrow = matchMedia('(max-width: 1023px)');

  function json(url, method, body) {
    return TKNet.json(url, { method: method || 'GET', body: body });
  }

  // ── Картинка и заставка ────────────────────────────────────────────────
  // Заставка: короткий заголовок и объяснение; без обоих — её нет.
  var HINTS = {
    off: ['vlive.offBadge', 'vlive.off'],
    ownerOff: ['vlive.offBadge', 'vlive.ownerOff'],
    login: ['stream.hintLive', 'vlive.login'],
    restricted: ['', 'restricted.text'],
    connecting: ['studio.connecting', ''],
    // Камера вещает, только пока её смотрят (utils/venueCam.js): первые
    // секунды зритель ждёт, пока она проснётся, — говорим это, а не «подключаемся».
    waking: ['vlive.wakingTitle', 'vlive.waking'],
    slow: ['vlive.slowTitle', 'vlive.slow'],
    blocked: ['', 'vlive.blocked'],
    lost: ['vlive.lostTitle', 'vlive.lost'],
    elsewhere: ['stream.hintLive', 'vlive.elsewhere'],
  };
  function say(name) {
    var h = HINTS[name] || ['', ''];
    hint.hidden = !name;
    var login = $('venueLogin');
    if (login) login.hidden = name !== 'login';
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

  // Зритель: смотреть — с 28.09 и без входа. Доступ закрыт владельцем —
  // плеера нет вовсе (движки страница не грузит, views/venueLive.ejs).
  // Без входа в комнату Daily не пускают: страница знает это сразу
  // (data-login-to-watch) и просит войти, а на случай 401 — то же самое.
  var canWatch = !OWNER && !RESTRICTED && !LOGIN_TO_WATCH && !!window.TKHls;
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

  // Телеметрия просмотра (docs/TELEMETRY.md, venue.view) — как у эфира:
  // путь, плейлист, первый кадр, подвисания, почему ушёл. Камера выключена,
  // нужен вход, закрыто владельцем — попытки не было, не пишем.
  function watch() {
    if (!canWatch || session) return;
    say('connecting');
    var tr = window.TKTrace ? TKTrace.start('venue.view', ID) : null;
    json('/api/venues/' + ID + '/watch', 'POST', {}).then(function (first) {
      if (tr) tr.step('watch');
      if (first.engine === 'hls') return watchHls(first.url, tr);
      if (tr) { tr.route = 'daily'; tr.onLeave = function () { tr.outcome = session ? 'ok' : 'gave_up'; }; }
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
      if (tr) { if ([401, 403, 409].indexOf(e.status) >= 0) tr.drop(); else tr.end('fail', 'watch_' + (e.status || e.reason || 'net')); }
      if (e.status === 409) { markOnline(false); say('off'); }
      else if (e.status === 401) say('login');
      else if (e.status === 403) say('restricted');
      else say('lost');
    });
  }

  // HLS через CDN. Плейлиста ещё нет — камеру только что попросили, первые
  // секунды видео будут через ~5–10 с: tk-hls.js ждёт его сам. Знак —
  // поверх картинки, как у эфиров (решение 05.10): в кадр его сервер
  // больше не кладёт (utils/hls.js, профили venue и venueCopy).
  //
  // CDN из сети зрителя не отвечает — плеер сам уходит на запасной путь /lf/
  // (utils/mediaFallback.js), как у эфира. Адрес уже /lf — сервер подменил его
  // сам (cookie запасного пути).
  function watchHls(url, tr) {
    var started = false, playing = false, gotManifest = false, busy = false;
    var stalls = 0, stallMs = 0, stallAt = 0;
    var cdn = /^https?:/.test(url) && url.indexOf('/live/') > 0;
    if (tr) {
      tr.route = /^\/lf\//.test(url) ? 'fallback' : cdn ? 'cdn' : '';
      tr.onLeave = function () {
        tr.outcome = !started ? 'gave_up' : playing ? 'ok' : 'partial';
        tr.reason = started ? '' : busy ? 'fallback_busy' : gotManifest ? 'no_frame' : 'no_manifest';
      };
    }
    say('waking');
    var hls = TKHls.play(video, url, {
      fallback: cdn ? '/lf' + url.slice(url.indexOf('/live/')) : '',
      // ~20 с без плейлиста: камера не проснулась — у заведения, скорее
      // всего, плохая связь. Ждём дальше, но говорим это словами.
      slowAfter: 10,
      onSlow: function () {
        if (started) return;
        say('slow');
        if (tr) tr.mark('notice_slow');
      },
      onEvent: function (name, d) {
        if (!tr && name !== 'busy' && name !== 'reset') return;
        if (name === 'manifest') { gotManifest = true; tr.step('manifest'); }
        else if (name === 'player') tr.set('player', d.kind);
        else if (name === 'fallback') { tr.route = 'fallback'; tr.mark('fallback'); }
        else if (name === 'busy') { busy = true; if (!started) say('blocked'); if (tr) tr.step('busy'); }
        else if (name === 'reset') {
          // Поток пропал посреди просмотра (камера ушла, конвейер встал) —
          // плеер ждёт его заново. Без слов зритель смотрел бы на застывший кадр.
          playing = false;
          say('slow');
          if (tr) { tr.mark('reset'); tr.mark('notice_slow'); }
        }
        else if (name === 'error') tr.set('lastErr', String(d.details || '') + (d.code ? ' ' + d.code : ''));
      },
    });
    var onPlaying = function () {
      playing = true;
      if (stallAt) { stallMs += Date.now() - stallAt; stallAt = 0; if (tr) tr.set('stallMs', stallMs); }
      if (tr) tr.step('frame');
      say('');
      if (started) return;
      started = true;
      video.hidden = false;
      if ($('venueWm')) $('venueWm').hidden = false;
      play();
    };
    var onWaiting = function () {
      if (!started || stallAt) return;
      playing = false;
      stallAt = Date.now();
      if (tr) tr.set('stalls', ++stalls);
    };
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    session = {
      leave: function () {
        // Камеру выключили или связь с ней пропала — итог сразу.
        if (tr) { tr.onLeave(); tr.onLeave = null; tr.end(tr.outcome, tr.reason); }
        video.removeEventListener('playing', onPlaying);
        video.removeEventListener('waiting', onWaiting);
        hls.stop();
        video.removeAttribute('src');
        video.load();
        video.hidden = true;
        if ($('venueWm')) $('venueWm').hidden = true;
      },
    };
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
    micBtn.disabled = cameraBtn.disabled = state !== 'live' || !(session || local);
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

  // ── Свой приём: камера на странице, вещание — по просьбе сервера ──
  // local — камера и микрофон этой вкладки: живут, пока камера включена,
  // и дают владельцу свою картинку. pub — публикация на сервер: есть, только
  // пока камеру смотрят (venue:demand, utils/venueCam.js).
  var local = null;
  var pub = null;
  var wanted = false;
  var retry = null;
  // Запрос на включение ушёл, камера ещё не открылась: эхо своего же
  // venue:state в это время — не «включили с другой вкладки».
  var starting = false;
  // 480p и 15 кадров: вид зала, а не эфир. Больше сервер всё равно не отдаст.
  var CAMERA = { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 15 } };

  function badgeText(key) { tkText(badge.lastElementChild, key); }

  // Телеметрия владельца (docs/TELEMETRY.md, venue.host): от «включить» до
  // «выключить» — камера, публикации по WHIP, путь ICE, сбои. Публикация
  // NO_ROUTE раз подряд не дошла до сервера — владельцу словами: раньше
  // страница переспрашивала молча, а он видел «Ждём зрителей», пока зрители
  // ждали картинку (NOTICES.md, «Камеры заведений»).
  var NO_ROUTE = 3;
  var htr = null, pubs = 0, fails = 0, streak = 0, everLive = false, noRoute = false;
  function hostTrace(route) {
    if (htr || !window.TKTrace) return;
    var tr = htr = TKTrace.start('venue.host', ID);
    tr.route = route;
    pubs = fails = streak = 0;
    everLive = noRoute = false;
    tr.onLeave = function () {
      tr.outcome = fails && !everLive ? 'fail' : 'ok';
      tr.reason = fails && !everLive ? 'no_publish' : '';
    };
  }
  function hostEnd(outcome, reason) {
    if (!htr) return;
    var tr = htr;
    htr = null;
    if (!outcome) { tr.onLeave(); outcome = tr.outcome; reason = tr.reason; }
    tr.onLeave = null;
    tr.end(outcome, reason);
  }
  function pubFailed(e) {
    if (!htr) return;
    htr.set('fails', ++fails);
    // Этапов у попытки не больше 40, а страница переспрашивает часами:
    // отмечаем первые сбои подряд, остальное — в счёте.
    if (streak < NO_ROUTE) htr.mark('pub_fail');
    if (e) htr.set('lastErr', ((e.status ? e.status + ' ' : '') + (e.message || '')).slice(0, 80));
    if (++streak < NO_ROUTE || noRoute) return;
    noRoute = true;
    htr.mark('notice_no_route');
    htr.send(); // страница владельца открыта часами — важное не ждёт минуты
    badgeText('vlive.noRouteBadge');
    toast(t('vlive.noRoute'), 'error');
  }

  // H.264 сервер берёт копией — дешевле в разы (tk-whip.js). Не пошёл на
  // этом устройстве — дальше VP8, и это помним: не проверять заново при
  // каждом зрителе.
  var VP8_KEY = 'tk:whip:vp8';
  var h264 = true;
  try { h264 = !localStorage.getItem(VP8_KEY); } catch (e) { /* без хранилища — пробуем H.264 */ }

  // Кадры не пошли у браузера (tk-whip.js) или до сервера дошёл один звук
  // (venue:codec, utils/venueCam.js) — дальше VP8.
  function noH264() {
    if (!h264) return;
    h264 = false;
    try { localStorage.setItem(VP8_KEY, '1'); } catch (e) { /* только на эту страницу */ }
    if (htr) htr.mark('vp8_fallback');
  }

  function publishNow() {
    if (!local || pub) return;
    clearTimeout(retry);
    json('/api/venues/' + ID + '/watch', 'POST', {}).then(function (r) {
      if (!local || pub || !wanted || r.engine !== 'whip') return;
      var reached = false, failure = null;
      if (htr) { htr.set('pubs', ++pubs); if (streak < NO_ROUTE) htr.mark('publish'); }
      var mine = pub = TKWhip.publish(r.url, local, {
        h264: h264,
        onState: function (s) {
          if (s === 'live' && pub === mine) {
            reached = everLive = true;
            streak = 0;
            if (noRoute) { noRoute = false; toast(t('vlive.resumed'), 'ok'); }
            badgeText('stream.hintLive');
            if (htr) htr.mark('live');
          }
          if (s === 'ended' && pub === mine) {
            pub = null;
            badgeText('vlive.waitingBadge');
            // H.264 не пошёл — это не сбой связи: сразу заново на VP8.
            if (failure && failure.codec) {
              if (wanted) publishNow();
              return;
            }
            if (!reached) pubFailed(failure);
            // Оборвалось, а камеру всё ещё смотрят, — просим снова.
            if (wanted) retry = setTimeout(publishNow, 3000);
          }
        },
        // Путь известен чуть позже «в эфире» — с ним и отправляем: страница
        // владельца открыта часами, первая публикация не должна ждать минуты.
        onRoute: function (route) { if (htr) { htr.set('ice', route); htr.send(); } },
        onError: function (e) { failure = e; if (e.codec) noH264(); },
      });
    }).catch(function (e) {
      // 409 — камера на сервере уже выключена: просить снова бесполезно,
      // об этом скажет venue:state или сверка после обрыва сокета.
      if (wanted && e.status !== 409) { pubFailed(e); retry = setTimeout(publishNow, 5000); }
    });
  }

  function unpublish() {
    clearTimeout(retry);
    if (pub) { var p = pub; pub = null; p.leave(); }
    if (local) badgeText('vlive.waitingBadge');
  }

  function demand(on) {
    wanted = !!on;
    if (wanted) publishNow(); else unpublish();
  }

  function startOwn(first) {
    markOnline(true);
    paintOwner('live');
    badgeText('vlive.waitingBadge');
    demand(first.demand);
  }

  function start() {
    starting = true;
    paintOwner('connecting');
    say('connecting');
    json('/api/venues/' + ID + '/live', 'POST', {}).then(function (first) {
      hostTrace(first.engine === 'whip' ? 'whip' : 'daily');
      if (first.engine !== 'whip') { starting = false; return startDaily(first); }
      // Свой приём: камеру открываем сами. Движок узнаём до этого —
      // в Daily камеру открывает он, а телефон две разом не даёт.
      return navigator.mediaDevices.getUserMedia({ video: CAMERA, audio: true }).then(function (stream) {
        starting = false;
        if (htr) htr.step('camera');
        local = stream;
        show(stream);
        video.play().catch(function () {});
        startOwn(first);
      }, function () {
        starting = false;
        hostEnd('fail', 'camera_denied');
        toast(t('venues.mediaDenied'), 'error');
        stop();
      });
    }).catch(function (e) {
      starting = false;
      paintOwner('off');
      say('ownerOff');
      toast(e.message, 'error');
    });
  }

  // Сервер снял камеру, не дождавшись этой страницы: айфон свернули или
  // заблокировали, сменилась сеть (utils/venueCam.js, ownerLeft). Владелец
  // её не выключал — включаем снова, с той же камерой телефона. Раньше пульт
  // об этом не узнавал вовсе: «Ждём зрителей», а у зрителей «Камера
  // выключена» (правки 29.09).
  function resume() {
    if (starting) return;
    starting = true;
    wanted = false;
    unpublish();
    paintOwner('connecting');
    json('/api/venues/' + ID + '/live', 'POST', {}).then(function (first) {
      starting = false;
      if (!local) return;
      if (first.engine !== 'whip') return stop();
      return freshTracks().then(function () {
        startOwn(first);
        toast(t('vlive.resumed'), 'ok');
      }, function () {
        toast(t('venues.mediaDenied'), 'error');
        stop();
      });
    }).catch(function (e) {
      starting = false;
      halt();
      toast(e.message, 'error');
    });
  }

  // iOS гасит камеру и микрофон свёрнутой страницы: вернулись — дорожки
  // могли кончиться, и зрителю уходил бы чёрный кадр. Берём новые с той же
  // стороны; в идущей публикации они встают на место прежних.
  // Возврат на страницу и сверка сокета приходят почти разом — камеру
  // открываем один раз.
  var refreshing = null;
  function freshTracks() {
    if (refreshing) return refreshing;
    if (!local || !local.getTracks().some(function (tr) { return tr.readyState === 'ended'; })) return Promise.resolve();
    var cur = local.getVideoTracks()[0];
    var facing = cur && cur.getSettings().facingMode;
    var want = Object.assign({}, CAMERA, facing ? { facingMode: facing } : {});
    refreshing = navigator.mediaDevices.getUserMedia({ video: want, audio: true }).then(function (ns) {
      refreshing = null;
      if (!local) return ns.getTracks().forEach(function (tr) { tr.stop(); });
      local.getTracks().forEach(function (tr) { tr.stop(); local.removeTrack(tr); });
      ns.getTracks().forEach(function (tr) {
        if (tr.kind === 'audio') tr.enabled = micOn;
        local.addTrack(tr);
        if (pub) pub.replaceTrack(tr);
      });
      show(local);
      video.play().catch(function () {});
    }, function (e) {
      refreshing = null;
      throw e;
    });
    return refreshing;
  }

  function startDaily(first) {
    var lost = function () { toast(t('venues.liveLost'), 'error'); stop(); };
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
        if (s === 'live') { markOnline(true); paintOwner('live'); everLive = true; if (htr) htr.step('live'); }
        if (s === 'ended' && session) lost();
      },
    });
  }

  function stopLocal() {
    wanted = false;
    unpublish();
    if (local) { local.getTracks().forEach(function (tr) { tr.stop(); }); local = null; }
  }

  // Погасить камеру у себя — пульт снова «Запустить трансляцию».
  function halt() {
    hostEnd();
    var s = session;
    session = null;
    if (s) s.leave();
    stopLocal();
    show(null);
    markOnline(false);
    paintOwner('off');
    say('ownerOff');
  }

  function stop() {
    halt();
    return fetch('/api/venues/' + ID + '/live', { method: 'DELETE', keepalive: true }).catch(function () {});
  }

  // Камеру выключили не отсюда: другой вкладкой или устройством владельца,
  // модерацией. На сервере она уже выключена — гасим свою и говорим почему.
  function droppedElsewhere(reason) {
    halt();
    toast(t(reason === 'moderation' ? 'vlive.stoppedModeration' : 'vlive.stoppedElsewhere'), 'error');
  }

  // Другая камера: телефон — по стороне (фронтальная ↔ задняя), компьютер —
  // по кругу устройств. Прежнюю гасим до запроса: телефон двух камер
  // разом не открывает. В идущей публикации дорожка меняется на месте.
  function switchLocalCamera() {
    var cur = local.getVideoTracks()[0];
    if (!cur) return Promise.resolve();
    var set = cur.getSettings();
    return navigator.mediaDevices.enumerateDevices().then(function (list) {
      var cams = list.filter(function (d) { return d.kind === 'videoinput'; });
      var want = Object.assign({}, CAMERA);
      if (set.facingMode) want.facingMode = { exact: set.facingMode === 'environment' ? 'user' : 'environment' };
      else if (cams.length > 1) {
        var i = cams.map(function (d) { return d.deviceId; }).indexOf(set.deviceId);
        want.deviceId = { exact: cams[(i + 1) % cams.length].deviceId };
      } else return;
      cur.stop();
      return navigator.mediaDevices.getUserMedia({ video: want }).then(function (ns) {
        var next = ns.getVideoTracks()[0];
        local.removeTrack(cur);
        local.addTrack(next);
        show(local);
        if (pub) return pub.replaceTrack(next);
      });
    });
  }

  if (OWNER) {
    liveBtn.addEventListener('click', function () {
      if (session || local || online) stop(); else start();
    });
    micBtn.addEventListener('click', function () {
      if (!session && !local) return;
      micOn = !micOn;
      paintMic();
      if (local) local.getAudioTracks().forEach(function (tr) { tr.enabled = micOn; });
      else session.setMic(micOn);
    });
    cameraBtn.addEventListener('click', function () {
      if (!session && !local) return;
      cameraBtn.disabled = true;
      var p = local ? switchLocalCamera() : session.call ? session.call.cycleCamera() : Promise.resolve();
      Promise.resolve(p).catch(function () { toast(t('venues.mediaDenied'), 'error'); })
        .then(function () { cameraBtn.disabled = !session && !local; });
    });
    // Ушли со страницы с включённой камерой — гасим её на сервере, иначе
    // заведение висело бы «в эфире» без картинки. keepalive доносит
    // запрос и из закрывающейся вкладки.
    window.addEventListener('pagehide', function () {
      if (session || local) fetch('/api/venues/' + ID + '/live', { method: 'DELETE', keepalive: true });
    });
    // Камера уже включена — с другой вкладки или устройства. Не гасим её
    // молча: говорим об этом, и кнопка её выключает.
    if (online) { paintOwner('elsewhere'); say('elsewhere'); }
  }

  // ── Обложка камеры (28.09) ─────────────────────────────────────────────
  // Заставка страницы, пока картинки нет. Кадр 16:9 выбирает владелец
  // (public/tk-crop.js), на сервер уходит сразу (routes/venueLive.js).
  var coverImg = $('venueCover');
  function showCover(src) {
    var url = src || coverImg.dataset.photo;
    coverImg.hidden = !url;
    if (url) coverImg.src = url; else coverImg.removeAttribute('src');
    $('coverClear').hidden = !src;
  }
  if (OWNER) {
    $('coverBtn').addEventListener('click', function () { $('coverInput').click(); });
    $('coverInput').addEventListener('change', function (e) {
      var picked = e.target.files[0];
      e.target.value = '';
      if (!picked) return;
      tkCrop(picked, { aspect: 16 / 9, max: 1920 }).then(function (file) {
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) return toast(t('studio.coverHeavy'), 'error');
        var body = new FormData();
        body.append('cover', file);
        return tkFetch('/api/venues/' + ID + '/cover', { method: 'POST', headers: { Accept: 'application/json' }, body: body })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.message || TKNet.explain(r)); return d; }); })
          .then(function (d) { showCover(d.cover); toast(t('vlive.coverSaved'), 'ok'); });
      }).catch(function (err) { toast(err.message, 'error'); });
    });
    $('coverClear').addEventListener('click', function () {
      json('/api/venues/' + ID + '/cover', 'DELETE')
        .then(function () { showCover(''); })
        .catch(function (e) { toast(e.message, 'error'); });
    });
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
  // Камеру включили или выключили. Владелец со своей камерой: включение —
  // эхо своего же запроса; выключение — не его: другой вкладкой, модерацией
  // или сервером, не дождавшимся этой страницы (reason: lapsed). Прежде
  // пульт с камерой такие события пропускал целиком и так и показывал
  // «Остановить трансляцию» у выключенной камеры (правки 29.09).
  function applyState(on, reason) {
    if (OWNER) {
      if (session || local || starting) {
        if (on || starting) return;
        return reason === 'lapsed' && local ? resume() : droppedElsewhere(reason);
      }
      markOnline(on);
      paintOwner(on ? 'elsewhere' : 'off');
      return say(on ? 'elsewhere' : 'ownerOff');
    }
    markOnline(on);
    if (!canWatch) return say(RESTRICTED ? 'restricted' : on ? 'login' : 'off');
    if (on) watch(); else unwatch();
  }

  socket.on('connect', function () {
    socket.emit('venue:join', ID, function (r) {
      if (!r || r.error) return;
      if (typeof r.count === 'number') viewers(r.count);
      // Сверка после обрыва сокета: события, пришедшие без него, прошли
      // мимо. У владельца с камерой — ещё и просят ли её сейчас.
      if (OWNER && (session || local)) {
        if (!r.online) return applyState(false, r.lapsed ? 'lapsed' : '');
        if (local) demand(r.demand);
        return;
      }
      if (r.online !== online || (r.online && canWatch && !session)) applyState(r.online);
    });
    fetchMissed();
  });
  socket.on('venue:demand', function (d) { if (OWNER && local && d.venueId === ID) demand(d.on); });
  // Сервер закрывает такую публикацию сам — следующая пойдёт на VP8.
  socket.on('venue:codec', function (d) { if (OWNER && d.venueId === ID) noH264(); });
  socket.on('venue:chat', function (m) { if (m.venueId === ID) render(m); });
  socket.on('venue:viewers', function (d) { if (d.venueId === ID) viewers(d.count); });
  socket.on('venue:state', function (d) { if (d.venueId === ID) applyState(d.online, d.reason); });

  // Вернулись на страницу. Владелец: iOS мог погасить камеру свёрнутой
  // страницы — берём новую. Зритель: айфон после блокировки экрана
  // оставлял застывший кадр до перезагрузки — родной плеер Safari после
  // обрыва потока сам не оживает (tk-hls.js). Картинка за несколько секунд
  // не сдвинулась — подключаемся заново.
  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (OWNER) {
      if (local && !starting) freshTracks().catch(function () { toast(t('venues.mediaDenied'), 'error'); });
      return;
    }
    if (!session || !online || Date.now() - hiddenAt < 20000) return;
    var at = video.currentTime;
    setTimeout(function () {
      if (!session || !online || document.hidden || video.currentTime !== at) return;
      session.leave();
      session = null;
      watch();
    }, 4000);
  });

  if (!OWNER && online) watch();
})();
