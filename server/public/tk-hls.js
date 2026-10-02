// HLS на клиенте: плеер эфира у зрителя и предпросмотр OBS у ведущего.
//
// Safari — и весь iOS — играет HLS сам, библиотека ему не нужна вовсе.
// Остальным поток собирает hls.js через Media Source Extensions.
//
// Библиотека лежит у нас, в /vendor, а не на jsdelivr: минус сторонний CDN.
// Сборка light — без субтитров, DRM и альтернативных дорожек: звук у эфира
// лежит в каждом качестве свой (utils/hls.js), отдельной дорожки нет.
// Качеств с 25.09 три — 720p, 480p, 360p; выбирает hls.js сам. Грузится лениво: 117 КБ сжатого скрипта нужны
// только браузерам без своего HLS и только когда плейлист уже есть.
(function () {
  // Safari (и любой браузер на айфоне — там всё на WebKit): свой HLS надёжен.
  var SAFARI = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Android|Edg\//.test(navigator.userAgent);

  // Подписи — из общего словаря (public/tk-i18n.js).
  var t = function (key, arg) { return window.t ? window.t(key, arg) : ''; };
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
          reject(new Error(t('stream.playerFailed')));
        };
        document.head.appendChild(s);
      });
    }
    return loading;
  }

  // Есть ли плейлист. { ok, status } — ответ пришёл; { net: true } — не
  // пришёл вовсе: сеть, обрыв или CDN, до которого из этой сети не достать.
  // Без своего тайм-аута запрос к заблокированному CDN висит минутами,
  // и всё это время зритель смотрит на кружок.
  var HEAD_MS = 8000;
  function playlistReady(url) {
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl && setTimeout(function () { ctl.abort(); }, HEAD_MS);
    return fetch(url, { method: 'HEAD', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return { ok: r.ok, status: r.status }; }, function () { return { ok: false, net: true }; })
      .then(function (res) { clearTimeout(timer); return res; });
  }
  // play(video, url, opts) → { stop() }
  //   opts.attempts — сколько раз ждать плейлист, по POLL_MS; по умолчанию
  //                   без конца. ffmpeg пишет index.m3u8 только после первых
  //                   сегментов — через несколько секунд после начала эфира.
  //   opts.onGiveUp — плейлист так и не появился.
  //   opts.slowAfter, opts.onSlow — плейлиста нет slowAfter попыток подряд:
  //                   сказать зрителю, что ждём, а не молчать (ждать дальше).
  //   opts.fallback — тот же плейлист своим адресом (/lf/, utils/mediaFallback.js).
  //                   CDN дважды подряд не ответил вовсе — переходим туда.
  //   opts.onEvent(name, data) — для телеметрии (tk-viewer.js): manifest,
  //                   player, error, reset, fallback, busy.
  //   opts.onHls    — получает созданный hls.js: плеер (tk-player.js) берёт
  //                   у него качества и живой край. Своему плееру Safari не зовётся.
  // Поток пропал посреди просмотра (эфир прервался, OBS переподключился) —
  // плеер пересоздаётся и снова ждёт плейлист. Свой плеер Safari сам этого
  // не умеет: после перезапуска конвейера он вставал кружком навсегда
  // (тесты 01.10) — его ведёт сторож подвисаний ниже.
  var NET_FAILS = 2;
  var STALL_MS = 12000;
  function play(video, url, opts) {
    opts = opts || {};
    var attempts = opts.attempts || Infinity;
    var stopped = false;
    var timer = null;
    var stall = null;
    var hls = null;
    var netFails = 0;
    var missing = 0;
    var native = false;
    function event(name, data) { if (opts.onEvent) opts.onEvent(name, data || {}); }
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
    // Начать заново: плейлист пропал или картинка встала. Сначала ждём,
    // когда плейлист снова есть, — сразу грузить пустое место незачем.
    function reset(why) {
      if (stopped) return;
      clearTimeout(stall);
      event('reset', { why: why });
      destroy();
      if (native) {
        native = false;
        video.removeAttribute('src');
        video.load();
      }
      wait(Infinity);
    }
    // Сторож: «жду данных» дольше STALL_MS — поток умер, а плеер этого не
    // понял (свой Safari не понимает никогда). Любое движение снимает его.
    function watch() {
      clearTimeout(stall);
      stall = setTimeout(function () { reset('stall'); }, STALL_MS);
    }
    video.addEventListener('waiting', function () { if (!stopped && (hls || native)) watch(); });
    ['playing', 'timeupdate', 'pause'].forEach(function (ev) {
      video.addEventListener(ev, function () { clearTimeout(stall); });
    });
    video.addEventListener('ended', function () { if (native) reset('ended'); });
    function attach(Hls) {
      if (stopped) return;
      if (!Hls.isSupported()) {
        console.error('[hls] браузер не умеет HLS ни сам, ни через hls.js');
        event('error', { details: 'unsupported' });
        return;
      }
      event('player', { kind: 'hlsjs' });
      hls = new Hls({
        lowLatencyMode: true,
        liveSyncDurationCount: 3,  // держимся у живого края, а не у начала окна
        backBufferLength: 30,      // не копим прошлое: эфир, а не запись
        // Не выше, чем помещается в окно плеера, — как у записей
        // (tk-player.js): маленькое окно не тянет 720p, и CDN не возит лишнее.
        capLevelToPlayerSize: true,
      });
      hls.on(Hls.Events.MANIFEST_PARSED, autoplay);
      hls.on(Hls.Events.ERROR, function (_e, data) {
        if (!data.fatal) return;
        event('error', { details: data.details, code: data.response && data.response.code });
        // Сбой декодера чинится на месте. Сетевой фатальный — это когда hls.js
        // уже исчерпал свои повторы: плейлиста нет, эфир прервался.
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
        console.warn('[hls] поток пропал, ждём снова:', data.details);
        reset('fatal');
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      if (opts.onHls) opts.onHls(hls);
    }
    function wait(left) {
      if (stopped) return;
      playlistReady(url).then(function (res) {
        if (stopped) return;
        if (!res.ok) {
          netFails = res.net ? netFails + 1 : 0;
          if (res.status === 429) event('busy', {});
          // CDN молчит — из этой сети до него не достать. Тот же плейлист
          // нашим адресом; запоминаем, чтобы и другие страницы пришли с ним.
          if (netFails >= NET_FAILS && opts.fallback && url !== opts.fallback) {
            url = opts.fallback;
            netFails = 0;
            event('fallback', {});
            if (window.TKMedia && TKMedia.remember) TKMedia.remember();
            return wait(left);
          }
          if (++missing === opts.slowAfter && opts.onSlow) opts.onSlow(res);
          if (--left > 0) timer = setTimeout(function () { wait(left); }, POLL_MS);
          else if (opts.onGiveUp) opts.onGiveUp();
          return;
        }
        missing = 0;
        netFails = 0;
        event('manifest', {});
        // Порядок важен: Safari умеет и то и другое, но свой плеер экономнее.
        // Свой HLS с недавних пор заявляет и Chrome — и падает на том же
        // потоке с MEDIA_ERR_SRC_NOT_SUPPORTED. Поэтому ошибка своего плеера —
        // повод перейти на hls.js, если в браузере есть MSE. Заодно Safari с MSE
        // получает восстановление после обрыва, которого у своего плеера нет.
        //
        // С 21.09 Chrome (Android, у него MSE есть) идёт в hls.js сразу:
        // его провал своим плеером всякий раз попадал в журнал ошибок
        // как «не загрузился video с live.takebana.com» — ложная тревога,
        // эфир при этом играл через hls.js. Свой плеер — только Safari
        // и браузерам без MSE.
        if (video.canPlayType('application/vnd.apple.mpegurl') && (SAFARI || !(window.MediaSource || window.ManagedMediaSource))) {
          native = true;
          event('player', { kind: 'native' });
          video.addEventListener('error', function onError() {
            video.removeEventListener('error', onError);
            if (stopped || !native) return;
            event('error', { details: 'native', code: video.error && video.error.code });
            native = false;
            video.removeAttribute('src');
            video.load();
            if (!(window.MediaSource || window.ManagedMediaSource)) return wait(Infinity);
            console.warn('[hls] свой плеер браузера не справился, переходим на hls.js');
            load().then(attach, function (e) { console.error('[hls]', e.message); });
          });
          video.src = url;
          autoplay();
        } else {
          load().then(attach, function (e) { console.error('[hls]', e.message); event('error', { details: 'lib' }); });
        }
      });
    }
    wait(attempts);
    return {
      stop: function () {
        stopped = true;
        clearTimeout(timer);
        clearTimeout(stall);
        destroy();
      },
    };
  }
  window.TKHls = { play: play, load: load };
})();
