// Daily на клиенте: загрузка библиотеки и вход в комнату с переподключением.
//
// Общее для звонков (tk-app.js), веб-эфира (страницы эфира) и камеры
// заведения (карта). Раньше у каждого был свой вход в Daily, и ни один не
// переживал обрыва: связь пропала на полминуты — разговор молча умирал.
//
// Библиотека лежит у нас, в /vendor, а не на unpkg: минус сторонний CDN.
// Версию держим свежей — Daily поддерживает только релизы последних шести
// месяцев; прежняя 0.83.1 вышла в августе 2025 и из поддержки выпала.
// Движок звонка daily-js при входе всё равно подгружает с серверов Daily.
// Грузится лениво: 72 КБ сжатого скрипта нужны только в момент соединения.
(function () {
  var SRC = '/vendor/daily-0.92.2.js';
  // Паузы между попытками войти заново. Своё переподключение Daily держит
  // около 20 секунд; сюда доходит то, что он не вытянул.
  var RETRY_MS = [1000, 2000, 4000, 8000, 15000];
  var loading = null;
  function noop() {}

  // networkState — нынешнее поле Daily, threshold — прежнее ('very-low' вместо
  // 'bad'). Первое бывает 'unknown', пока статистики мало: тогда берём второе.
  function netState(s) {
    if (s.networkState && s.networkState !== 'unknown') return s.networkState;
    return s.threshold === 'very-low' ? 'bad' : (s.threshold || 'good');
  }

  function load() {
    if (window.Daily) return Promise.resolve(window.Daily);
    if (!loading) {
      loading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = SRC;
        s.onload = function () { resolve(window.Daily); };
        s.onerror = function () {
          loading = null;
          reject(new Error('Не загрузилась библиотека видеосвязи'));
        };
        document.head.appendChild(s);
      });
    }
    return loading;
  }

  // Токен с сервера. Отказ 4xx — окончательный: эфир кончился, камеру
  // выключили, доступа нет. 5xx и сеть — временные, пробуем ещё.
  function requestAccess(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.ok && d.token) return { url: d.url, token: d.token };
          var err = new Error(d.message || 'Нет доступа к видео');
          err.final = r.status >= 400 && r.status < 500;
          throw err;
        });
      });
  }

  // opts:
  //   access()   → Promise<{ url, token }> — свежий токен на каждый вход;
  //                ошибка с err.final прекращает попытки
  //   send       — отправлять свои звук и видео (зритель — нет)
  //   video      — включить камеру сразу
  //   onTrack(track, participant, on)  — дорожка появилась или ушла
  //   onState(state) — 'connecting' | 'live' | 'reconnecting' | 'ended'
  //   onNetwork(state) — 'good' | 'low' | 'bad', оценка самого Daily
  //   onPeers(n) — сколько видимых участников, кроме себя
  //   onMediaError(e) — камера или микрофон недоступны
  function connect(opts) {
    var call = null;
    var dying = Promise.resolve();
    var closed = false;
    var attempt = 0;
    var voiceOnly = false;
    // Выбор дорожек поштучно (setSubscribedTracks) Daily разрешает только при
    // ручной подписке, а при автоматической бросает исключение. Поэтому на
    // ручную переходим с первым включением «только голос» и дальше
    // подписываем каждого участника сами — и после повторного входа тоже.
    var manual = false;

    function emit(name, value) { if (opts[name]) opts[name](value); }

    function subscribe(c, sessionId) {
      c.updateParticipant(sessionId, {
        setSubscribedTracks: { audio: true, video: !voiceOnly, screenVideo: false }
      });
    }

    function applyVoiceOnly(c) {
      if (opts.send && opts.video) c.setLocalVideo(!voiceOnly);
      if (!manual) {
        manual = true;
        c.setSubscribeToTracksAutomatically(false);
      }
      var ps = c.participants();
      Object.keys(ps).forEach(function (k) { if (k !== 'local') subscribe(c, ps[k].session_id); });
    }

    function drop() {
      if (!call) return;
      var dead = call;
      call = null;
      dying = dead.destroy().catch(noop);
    }

    function fail(err) {
      if (closed) return;
      // Причина в консоль: иначе отказ Daily виден только как вечное «переподключаемся».
      if (err) console.warn('[daily]', err.errorMsg || err.message || err.action || err, err.error || '');
      drop();
      if ((err && err.final) || attempt >= RETRY_MS.length) {
        closed = true;
        emit('onState', 'ended');
        return;
      }
      emit('onState', 'reconnecting');
      setTimeout(run, RETRY_MS[attempt++]);
    }

    function start() {
      emit('onState', attempt ? 'reconnecting' : 'connecting');
      return Promise.all([load(), opts.access(), dying]).then(function (r) {
        if (closed) return;
        var Daily = r[0];
        var access = r[1];
        var c = Daily.createCallObject({
          // Речь, а не музыка: браузерные эхоподавление, шумоподавление
          // и автоусиление остаются включены.
          dailyConfig: { micAudioMode: 'speech' },
          subscribeToTracksAutomatically: !manual,
          startVideoOff: !(opts.send && opts.video && !voiceOnly),
          startAudioOff: !opts.send
        });
        call = c;
        // События мёртвого объекта сюда не доходят: c !== call.
        function mine(fn) { return function (e) { if (c === call) fn(e); }; }
        function peers() { emit('onPeers', Math.max(0, Object.keys(c.participants()).length - 1)); }

        c.on('track-started', mine(function (e) { if (opts.onTrack && e.participant) opts.onTrack(e.track, e.participant, true); }));
        c.on('track-stopped', mine(function (e) { if (opts.onTrack && e.participant) opts.onTrack(e.track, e.participant, false); }));
        c.on('participant-joined', mine(function (e) {
          if (manual) subscribe(c, e.participant.session_id);
          peers();
        }));
        c.on('participant-left', mine(peers));
        c.on('network-quality-change', mine(function (e) { emit('onNetwork', netState(e)); }));
        // Камеры или микрофона нет, либо доступ запрещён: во встречу Daily
        // всё равно пускает, но без картинки — сказать об этом должен сайт.
        c.on('camera-error', mine(function (e) { emit('onMediaError', e); }));
        // Сигнализация прервалась — Daily переподключается сам, мы только показываем.
        c.on('network-connection', mine(function (e) {
          if (e.type === 'signaling') emit('onState', e.event === 'interrupted' ? 'reconnecting' : 'live');
        }));
        // Встреча потеряна насовсем: входим заново со свежим токеном.
        c.on('left-meeting', mine(fail));
        c.on('error', mine(fail));

        return c.join({ url: access.url, token: access.token }).then(function () {
          if (c !== call) return;
          attempt = 0;
          if (manual) applyVoiceOnly(c);
          peers();
          emit('onState', 'live');
          // Событие о сети Daily шлёт только при смене оценки: при хорошей
          // сети с первой секунды его не будет вовсе. Начальную берём сами.
          c.getNetworkStats().then(mine(function (s) { emit('onNetwork', netState(s)); })).catch(noop);
        });
      });
    }

    function run() { if (!closed) start().catch(fail); }
    run();

    return {
      get call() { return call; },
      // Только голос: своя камера выключается, чужое видео не принимается —
      // на слабой сети это освобождает почти весь канал под звук.
      setVoiceOnly: function (on) {
        voiceOnly = !!on;
        if (call) applyVoiceOnly(call);
      },
      leave: function () {
        closed = true;
        var dead = call;
        call = null;
        if (!dead) return dying;
        dying = dead.leave().catch(noop).then(function () { return dead.destroy(); }).catch(noop);
        return dying;
      }
    };
  }

  // Картинку и звук участника — в элемент страницы. Отказ автозапуска
  // (Safari без жеста пользователя) снимается первым нажатием где угодно.
  function attach(el, track) {
    if (!el) return;
    el.srcObject = track ? new MediaStream([track]) : null;
    if (!track) return;
    el.play().catch(function () {
      document.addEventListener('click', function () { el.play().catch(noop); }, { once: true, capture: true });
    });
  }

  window.TKDaily = { load: load, connect: connect, requestAccess: requestAccess, attach: attach };
})();
