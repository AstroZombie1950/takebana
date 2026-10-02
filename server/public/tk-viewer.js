/* Страница зрителя: плеер эфира, подписка на ведущего, перезагрузка на смене
 * состояния эфира. Чат, метки и полный экран — /tk-stream.js.
 * Разметка — views/streamPageViewer.ejs.
 */
(function () {
  var data = document.body.dataset;
  var active = data.streamActive === '1';
  // Только для подписчиков, а зритель не подписан: чата и плеера на
  // странице нет, TKStream не подключён. Подписался — перезагрузка
  // откроет эфир.
  var locked = !!data.locked;

  // Старт, пауза, конец эфира и смена его типа меняют сам плеер — на месте
  // он не перестраивается, страница перезагружается. Эфира больше нет —
  // перезагрузка покажет «эфир завершён».
  //
  // Заставка поверх плеера одна, причин у неё несколько — показывается
  // самая важная: ведущий отошёл; связь с ним потеряна или восстанавливается
  // (выход Daily оборвался, utils/webLive.js); в этой сети эфир не идёт;
  // видео долго нет. До 02.10 из них была только первая, а в остальных
  // случаях зритель смотрел на чёрное без единого слова (тесты 01.10).
  var awayBox = document.getElementById('hostAway');
  var awayTitle = awayBox && awayBox.querySelector('.tk-live__hint-title');
  var NOTICES = [['away', 'viewer.awayTitle'], ['lost', 'viewer.lostTitle'], ['reconnecting', 'viewer.reconnectTitle'],
    ['blocked', 'viewer.blockedTitle'], ['slow', 'viewer.slowTitle']];
  var notice = { away: !!awayBox && !awayBox.hidden };
  function showNotice(changes) {
    for (var k in changes) notice[k] = changes[k];
    if (!awayBox) return;
    var on = NOTICES.filter(function (n) { return notice[n[0]]; })[0];
    awayBox.hidden = !on;
    if (on && awayTitle) window.tkText(awayTitle, on[1]);
  }
  if (window.TKStream) TKStream.onUpdate(function (u) {
    if (typeof u.away === 'boolean') showNotice({ away: u.away });
    if (typeof u.reconnecting === 'boolean') showNotice({ reconnecting: u.reconnecting, lost: false });
    if (u.lost) showNotice({ lost: true });
    if (u.ended || (u.streamType && u.streamType !== data.streamType) ||
        (typeof u.isActive === 'boolean' && u.isActive !== active)) {
      location.reload();
    }
  });

  // Подписка на ведущего: одна кнопка, состояние — в её классе. У гостя
  // вместо кнопки ссылка на вход (streamInfo.ejs).
  var subBtn = document.querySelector('.js-subscribe, .js-unsubscribe');
  if (subBtn) subBtn.addEventListener('click', function () {
    var subscribe = subBtn.classList.contains('js-subscribe');
    tkFetch(subscribe ? '/subscribe' : '/unsubscribe', {
      method: subscribe ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: data.streamerId }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) {
          toast(t('app.errorShort', { message: b.message || TKNet.explain(r) }), 'error');
          return;
        }
        if (subscribe && locked) return location.reload();
        if (subscribe) window.tkSubscriptions.add(b.user);
        else window.tkSubscriptions.remove(data.streamerId);
        toast(t(subscribe ? 'stream.subscribed' : 'stream.unsubscribed'), 'ok');
        subBtn.classList.toggle('js-subscribe', !subscribe);
        subBtn.classList.toggle('js-unsubscribe', subscribe);
        subBtn.classList.toggle('tk-btn--primary', !subscribe);
        subBtn.classList.toggle('tk-btn--outline', subscribe);
        tkText(subBtn, subscribe ? 'stream.unsubscribe' : 'stream.subscribe');
      });
    }, function () {
      toast(t('common.noNetwork'), 'error');
    });
  });

  var playerRoot = document.querySelector('.tk-player');
  if (locked) return;
  if (!playerRoot) {
    // Старт эфира пришлёт stream:update, и страница перезагрузится. Событие
    // могло проскочить между отрисовкой страницы и входом в комнату сокета —
    // одна сверка вдогонку.
    if (!active) {
      setTimeout(function () {
        tkFetch('/stream-status/' + data.streamId)
          .then(function (r) { return r.json(); })
          .then(function (b) { if (b.isActive) location.reload(); })
          .catch(function () {});
      }, 3000);
    }
    return;
  }

  // HLS — тот же плеер, что у предпросмотра ведущего. Зритель берёт поток
  // с CDN, если он задан (HLS_BASE_URL); ведущий — всегда со своего домена.
  // У веб-эфира плейлист появляется не сразу: Daily сначала поднимает RTMP-выход.
  // Кнопки и меню — плеер Takebana (/tk-player.js), поток ему подаёт TKHls.
  //
  // Запасной путь — тот же плейлист нашим адресом (/lf/, utils/mediaFallback.js):
  // CDN из этой сети не отвечает вовсе — плеер уходит туда сам. Только когда
  // эфир идёт через CDN: base '/lf' значит, что сервер уже отдал страницу
  // с запасным путём, а пустой — что CDN нет (стенд).
  var player = TKPlayer.mount(playerRoot);
  var video = player.video;
  var base = data.hlsBase;
  var hlsUrl = base + '/live/' + data.streamKey + '/index.m3u8';
  var fallback = /^https?:/.test(base) ? '/lf/live/' + data.streamKey + '/index.m3u8' : '';

  // Телеметрия просмотра (docs/TELEMETRY.md): за сколько пришёл плейлист
  // и первый кадр, сколько раз и как долго вставало, каким путём и каким
  // плеером. Исход считается в момент ухода: картинки так и не было —
  // gave_up с причиной, была и есть — ok, была и пропала — partial.
  var tr = window.TKTrace ? TKTrace.start('live.view', data.streamKey) : null;
  var played = false, playing = false, gotManifest = false;
  var stalls = 0, stallMs = 0, stallAt = 0, resets = 0;
  var busy = false, lastErr = '';
  if (tr) {
    tr.route = base === '/lf' ? 'fallback' : base ? 'cdn' : '';
    tr.onLeave = function () {
      tr.outcome = !played ? 'gave_up' : playing ? 'ok' : 'partial';
      tr.reason = played ? '' : busy ? 'fallback_busy' : !gotManifest ? 'no_manifest' : lastErr ? 'error' : 'no_frame';
    };
  }
  video.addEventListener('playing', function () {
    played = true;
    playing = true;
    if (stallAt) { stallMs += Date.now() - stallAt; stallAt = 0; }
    if (tr) { tr.step('frame'); tr.set('stallMs', stallMs); }
    showNotice({ slow: false, blocked: false, reconnecting: false, lost: false });
  });
  video.addEventListener('waiting', function () {
    if (!played || stallAt) return;
    playing = false;
    stallAt = Date.now();
    if (tr) tr.set('stalls', ++stalls);
  });

  TKHls.play(video, hlsUrl, {
    fallback: fallback,
    // Полминуты без плейлиста — говорим, что ждём, и ждём дальше: веб-эфир
    // поднимается через Daily, а ведущий мог переподключаться.
    slowAfter: 15,
    onSlow: function () { showNotice({ slow: true }); },
    onEvent: function (name, d) {
      if (name === 'manifest') { gotManifest = true; if (tr) tr.step('manifest'); }
      else if (name === 'player' && tr) tr.set('player', d.kind);
      else if (name === 'fallback' && tr) { tr.route = 'fallback'; tr.mark('fallback'); }
      else if (name === 'busy') { busy = true; showNotice({ blocked: true }); if (tr) tr.step('busy'); }
      else if (name === 'reset') { playing = false; if (tr) { tr.mark('reset'); tr.set('resets', ++resets); } }
      else if (name === 'error') { lastErr = String(d.details || ''); if (tr) tr.set('lastErr', lastErr + (d.code ? ' ' + d.code : '')); }
    },
    onHls: function (h) {
      player.attachHls(h);
      // Какое качество играет — по нему видно, тянет ли сеть зрителя.
      if (tr) h.on('hlsLevelSwitched', function (_e, d) { var l = h.levels[d.level]; if (l) tr.set('height', l.height); });
    },
  });
})();
