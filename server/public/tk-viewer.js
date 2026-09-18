/* Страница зрителя: плеер эфира, подписка на ведущего, перезагрузка на смене
 * состояния эфира. Чат, метки и полный экран — /tk-stream.js.
 * Разметка — views/streamPageViewer.ejs.
 */
(function () {
  var data = document.body.dataset;
  var active = data.streamActive === '1';

  // Старт, пауза, конец эфира и смена его типа меняют сам плеер — на месте
  // он не перестраивается, страница перезагружается. Эфира больше нет —
  // перезагрузка покажет «эфир завершён».
  TKStream.onUpdate(function (u) {
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
    fetch(subscribe ? '/subscribe' : '/unsubscribe', {
      method: subscribe ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: data.streamerId }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) {
          toast(t('app.errorShort', { message: b.message || 'HTTP ' + r.status }), 'error');
          return;
        }
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
  if (!playerRoot) {
    // Старт эфира пришлёт stream:update, и страница перезагрузится. Событие
    // могло проскочить между отрисовкой страницы и входом в комнату сокета —
    // одна сверка вдогонку.
    if (!active) {
      setTimeout(function () {
        fetch('/stream-status/' + data.streamId)
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
  var player = TKPlayer.mount(playerRoot);
  var hlsUrl = data.hlsBase + '/live/' + data.streamKey + '/index.m3u8';
  TKHls.play(player.video, hlsUrl, {
    attempts: 30,
    onHls: player.attachHls,
    onGiveUp: function () { console.error('[hls] плейлист не появился за минуту:', hlsUrl); },
  });
})();
