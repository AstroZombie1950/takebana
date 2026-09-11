// HLS на клиенте: плеер эфира у зрителя и предпросмотр OBS у ведущего.
//
// Safari — и весь iOS — играет HLS сам, библиотека ему не нужна вовсе.
// Остальным поток собирает hls.js через Media Source Extensions.
//
// Библиотека лежит у нас, в /vendor, а не на jsdelivr: минус сторонний CDN.
// Сборка light — без субтитров, DRM и альтернативных дорожек: у эфира одно
// качество и одна дорожка. Грузится лениво: 117 КБ сжатого скрипта нужны
// только браузерам без своего HLS и только когда плейлист уже есть.
(function () {
  var SRC = '/vendor/hls-1.7.2.light.min.js';
  var POLL_MS = 2000;
  var loading = null;

  function load() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (!loading) {
      loading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = SRC;
        s.onload = function () { resolve(window.Hls); };
        s.onerror = function () {
          loading = null;
          reject(new Error('Не загрузился плеер'));
        };
        document.head.appendChild(s);
      });
    }
    return loading;
  }

  function playlistReady(url) {
    return fetch(url, { method: 'HEAD', cache: 'no-store' })
      .then(function (r) { return r.ok; }, function () { return false; });
  }

  // play(video, url, opts) → { stop() }
  //   opts.attempts — сколько раз ждать плейлист, по POLL_MS; по умолчанию
  //                   без конца. ffmpeg пишет index.m3u8 только после первых
  //                   сегментов — через несколько секунд после начала эфира.
  //   opts.onGiveUp — плейлист так и не появился.
  // Поток пропал посреди просмотра (эфир прервался, OBS переподключился) —
  // плеер пересоздаётся и снова ждёт плейлист.
  function play(video, url, opts) {
    opts = opts || {};
    var attempts = opts.attempts || Infinity;
    var stopped = false;
    var timer = null;
    var hls = null;

    // Оба атрибута обязательны на iOS: без muted браузер не даст автозапуск,
    // без playsinline видео уходит в полноэкранный плеер.
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');

    function autoplay() {
      video.play().catch(function (e) { console.warn('[hls] автозапуск заблокирован:', e); });
    }

    function destroy() {
      if (!hls) return;
      try { hls.destroy(); } catch (_) {}
      hls = null;
    }

    function attach(Hls) {
      if (stopped) return;
      if (!Hls.isSupported()) {
        console.error('[hls] браузер не умеет HLS ни сам, ни через hls.js');
        return;
      }
      hls = new Hls({
        lowLatencyMode: true,
        liveSyncDurationCount: 3,  // держимся у живого края, а не у начала окна
        backBufferLength: 30,      // не копим прошлое: эфир, а не запись
      });
      hls.on(Hls.Events.MANIFEST_PARSED, autoplay);
      hls.on(Hls.Events.ERROR, function (_e, data) {
        if (!data.fatal) return;
        // Сбой декодера чинится на месте. Сетевой фатальный — это когда hls.js
        // уже исчерпал свои повторы: плейлиста нет, эфир прервался.
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
        console.warn('[hls] поток пропал, ждём снова:', data.details);
        destroy();
        wait(Infinity);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    }

    function wait(left) {
      if (stopped) return;
      playlistReady(url).then(function (ready) {
        if (stopped) return;
        if (!ready) {
          if (--left > 0) timer = setTimeout(function () { wait(left); }, POLL_MS);
          else if (opts.onGiveUp) opts.onGiveUp();
          return;
        }
        // Порядок важен: Safari умеет и то и другое, но свой плеер экономнее.
        // Свой HLS с недавних пор заявляет и Chrome — и падает на том же
        // потоке с MEDIA_ERR_SRC_NOT_SUPPORTED. Поэтому ошибка своего плеера —
        // повод перейти на hls.js, если в браузере есть MSE. Заодно Safari с MSE
        // получает восстановление после обрыва, которого у своего плеера нет.
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.addEventListener('error', function onError() {
            video.removeEventListener('error', onError);
            if (stopped || !(window.MediaSource || window.ManagedMediaSource)) return;
            console.warn('[hls] свой плеер браузера не справился, переходим на hls.js');
            video.removeAttribute('src');
            video.load();
            load().then(attach, function (e) { console.error('[hls]', e.message); });
          });
          video.src = url;
          autoplay();
        } else {
          load().then(attach, function (e) { console.error('[hls]', e.message); });
        }
      });
    }

    wait(attempts);

    return {
      stop: function () {
        stopped = true;
        clearTimeout(timer);
        destroy();
      },
    };
  }

  window.TKHls = { play: play };
})();
