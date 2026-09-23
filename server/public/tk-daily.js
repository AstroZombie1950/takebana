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
  // Подписи — из общего словаря (public/tk-i18n.js).
  var t = function (key, arg) { return window.t ? window.t(key, arg) : ''; };
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
          reject(new Error(t('stream.libFailed')));
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
          var err = new Error(d.message || t('stream.noVideoAccess'));
          err.final = r.status >= 400 && r.status < 500;
          throw err;
        });
      });
  }

  // opts:
  //   access()   → Promise<{ url, token }> — свежий токен на каждый вход;
  //                ошибка с err.final прекращает попытки
  //   send       — отправлять свои звук и видео (зритель — нет)
  //   video      — включить камеру сразу (дальше — setVideo)
  //   videoSource — id камеры, с которой входить; без него — камера по умолчанию
  //   onTrack(track, participant, on)  — дорожка появилась или ушла
  //   onState(state) — 'connecting' | 'live' | 'reconnecting' | 'ended'
  //   onNetwork(state) — 'good' | 'low' | 'bad', оценка самого Daily
  //   onPeers(n) — сколько видимых участников, кроме себя
  //   onMediaError(e) — камера или микрофон недоступны
  //   diag       — подпись для отчёта о несоединившемся звонке (см. ниже)
  //   onStuck(reason) — Daily не соединился: звонок уходит на свой сервер
  //                (tk-app.js). Только вместе с diag; пороги — joinMs,
  //                mediaMs и reachMs (ответ от домена Daily, см. probe)
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
    // Видео переключили до входа в комнату — применить при входе.
    var pending = false;

    function emit(name, value) { if (opts[name]) opts[name](value); }

    // ── Отчёт о звонке, который не соединился ──
    // У части людей из России звонок без VPN висит на «Подключаемся…», а
    // у нас всё работает — гадать, что режет провайдер, бесполезно. Если
    // не вошли в комнату, или собеседник в комнате, а звука от него нет,
    // или связь с Daily не вернулась, или звонок оборвался, — в журнал
    // ошибок панели (/api/client-error) уходят хронология событий Daily и
    // его же проверка соединения с серверами. Один отчёт каждого вида за
    // звонок; об обрыве и брошенной трубке — только если других не было.
    //
    // Те же три случая — повод уйти на свой сервер (onStuck). Пороги у
    // звонка жёсткие: обычный вход в Daily — 2–4 секунды, а ложный уход
    // стоит недорого — свой путь работает у всех.
    var diag = opts.diag ? { t0: Date.now(), log: [], sent: {}, joined: false, remote: false, stuck: false, lost: null } : null;
    var JOIN_MS = opts.joinMs || 15000;
    var MEDIA_MS = opts.mediaMs || 15000;
    // Сколько ждать ответа от самого домена Daily (см. probe ниже).
    var REACH_MS = opts.reachMs || 4000;
    var reached = false;
    // Собеседник в комнате, но сам ничего не шлёт (микрофон запрещён, окно
    // разрешения ещё открыто): это не сеть — ждём ещё, но не вечно.
    var MEDIA_ROUNDS = 3;

    function note(what) {
      if (diag && diag.log.length < 100) diag.log.push(((Date.now() - diag.t0) / 1000).toFixed(1) + ' с  ' + what);
    }

    function report(kind, onlyFirst) {
      if (!diag || diag.sent[kind] || (onlyFirst && Object.keys(diag.sent).length)) return;
      diag.sent[kind] = true;
      var c = call;
      // Состояние — сейчас: к концу проверки объект звонка может быть уже
      // уничтожен переходом на свой сервер.
      var state = c ? c.meetingState() : '—';
      var net = navigator.connection || {};
      var test = c ? Promise.race([
        c.testWebsocketConnectivity().then(function (r) { return 'ответ ' + JSON.stringify(r); }),
        new Promise(function (resolve) { setTimeout(resolve, 15000, 'нет ответа за 15 с'); })
      ]).catch(function (e) { return 'ошибка ' + ((e && (e.message || e.errorMsg)) || e); }) : Promise.resolve('объекта звонка нет');
      test.then(function (ws) {
        var details = [
          opts.diag + ': ' + kind,
          'состояние Daily: ' + state + ', попытка входа: ' + (attempt + 1),
          'сеть браузера: ' + (net.type || '?') + ' / ' + (net.effectiveType || '?'),
          'проверка соединения с серверами Daily: ' + ws,
          '— хронология —'
        ].concat(diag.log);
        fetch('/api/client-error', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page: location.pathname, name: 'CallDiag', message: 'Звонок не соединился: ' + kind, details: details }),
          keepalive: true
        }).catch(noop);
      });
    }

    // Подпись события Daily для хронологии.
    function describe(name, e) {
      e = e || {};
      if (name === 'network-connection') return name + ' ' + e.type + ' ' + e.event;
      if (name === 'track-started' || name === 'track-stopped') return name + ' ' + (e.track && e.track.kind) + (e.participant && e.participant.local ? ' свой' : ' собеседника');
      if (name === 'error' || name === 'nonfatal-error' || name === 'load-attempt-failed') return name + ' ' + (e.type || '') + ' ' + (e.errorMsg || (e.error && (e.error.msg || e.error.type)) || '');
      return name;
    }

    function sec(ms) { return Math.round(ms / 1000) + ' с'; }

    // Отчёт и, для звонка, уход на свой сервер — один раз.
    function trouble(kind) {
      report(kind);
      if (!opts.onStuck || diag.stuck) return;
      diag.stuck = true;
      opts.onStuck(kind);
    }

    // Открывается ли домен Daily вообще — отдельным запросом и одновременно
    // со входом, а не вместо него.
    //
    // Вход в комнату висит до JOIN_MS (у звонка это 10 с), и всё это время
    // человек смотрит на «Подключаемся…». Но у недоступного домена ответ
    // есть на первой же секунде: запрос не доходит, и ждать девять секунд
    // сверх этого не за чем. В журнале 23.09 оба несоединившихся звонка
    // выглядели одинаково — вход замирал на joining-meeting, и проверка
    // связи с серверами Daily тоже молчала.
    //
    // Ответ нас не интересует, важно только, дошёл ли запрос: HEAD, без
    // чтения ответа, любой код — значит домен открывается. Отказ на уровне
    // сети, пока мы ещё не в комнате, — повод уйти на свой сервер сразу.
    // Ложная тревога стоит недорого: свой путь работает у всех.
    function probe(url) {
      if (!diag || !opts.onStuck || reached) return;
      var origin;
      try { origin = new URL(url).origin + '/'; } catch (e) { return; }
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, REACH_MS);
      fetch(origin, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal }).then(function () {
        clearTimeout(timer);
        reached = true;
        note('домен Daily открылся');
      }, function () {
        clearTimeout(timer);
        if (closed || diag.joined || diag.stuck) return;
        note('домен Daily не открылся за ' + sec(REACH_MS));
        trouble('домен Daily не открылся за ' + sec(REACH_MS));
      });
    }

    // Состояние наружу. Связь с Daily пропала после входа — ждём её
    // возвращения не дольше порога входа.
    function setState(st) {
      emit('onState', st);
      if (!diag) return;
      if (st !== 'reconnecting') { clearTimeout(diag.lost); diag.lost = null; }
      else if (diag.joined && !diag.lost) {
        diag.lost = setTimeout(function () { if (!closed) trouble('связь с Daily не вернулась за ' + sec(JOIN_MS)); }, JOIN_MS);
      }
    }

    // Собеседник вошёл: ждём от него звук или видео.
    function awaitMedia(round) {
      setTimeout(function () {
        if (closed || diag.remote || !call) return;
        var ps = call.participants();
        var silent = Object.keys(ps).some(function (k) {
          if (k === 'local') return false;
          var tr = ps[k].tracks || {};
          return ['audio', 'video'].every(function (kind) { return !tr[kind] || /^(blocked|off)$/.test(tr[kind].state); });
        });
        if (silent && round < MEDIA_ROUNDS) return awaitMedia(round + 1);
        trouble('собеседник в комнате, но звук и видео от него не пришли за ' + sec(MEDIA_MS * round));
      }, MEDIA_MS);
    }

    if (diag) {
      setTimeout(function () { if (!closed && !diag.joined) trouble('за ' + sec(JOIN_MS) + ' не вошли в комнату'); }, JOIN_MS);
    }

    // ── Слышно ли собеседника ──
    // У Daily своей статистики соединения нам не видно, и отчёт о звуке
    // (public/tk-audio.js) на этом пути всегда писал «звука нет» — пять
    // таких записей в журнале панели за один вечер проверок 23.09, притом
    // что звук был. Daily умеет говорить уровень входящего звука сам;
    // копим его: любой уровень выше нуля значит, что звук дошёл и
    // декодировался, а дальше дело в маршруте вывода на устройстве.
    var heard = null;
    function level(map) {
      var top = 0;
      Object.keys(map || {}).forEach(function (id) {
        var v = Number(map[id]);
        if (v > top) top = v;
      });
      var was = heard ? heard.energy : 0;
      // grew — это «сколько звука прямо сейчас» в той же мерке, что у своего
      // пути (public/tk-peer.js): там это прирост энергии за три секунды,
      // и полный голос — сотые доли. Полоска уровня в окне звонка считает
      // ширину по ней, поэтому уровень Daily (0…1) приводим к той же мерке,
      // иначе полоска стояла бы упёртой в край при любом шорохе.
      heard = { level: top, energy: was + top, grew: top * 0.02, route: 'Daily' };
      emit('onAudio', heard);
    }

    // Микрофон — свою дорожку отдаёт сам Daily; отчёту нужны её настройки.
    function mic() {
      if (!call) return null;
      var local = (call.participants() || {}).local;
      var track = local && local.tracks && local.tracks.audio;
      return (track && (track.persistentTrack || track.track)) || null;
    }

    function subscribe(c, sessionId) {
      c.updateParticipant(sessionId, {
        setSubscribedTracks: { audio: true, video: !voiceOnly, screenVideo: false }
      });
    }

    // Своя камера выключена кнопкой в окне звонка — это не то же, что
    // «Только голос»: там видео гаснет в обе стороны ради канала, здесь
    // гаснет только своё. Флаг учитывается везде, где решается судьба
    // камеры, иначе «Только голос» туда-обратно включал бы её заново.
    var camOff = false;

    function wantCamera() { return !!opts.video && !voiceOnly && !camOff; }

    function applyVoiceOnly(c) {
      if (opts.send) c.setLocalVideo(wantCamera());
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
      note('сбой: ' + ((err && (err.errorMsg || err.message || err.action)) || err));
      if ((err && err.final) || attempt >= RETRY_MS.length) {
        report('звонок оборвался, попытки кончились', true);
        drop();
        closed = true;
        setState('ended');
        return;
      }
      drop();
      setState('reconnecting');
      setTimeout(run, RETRY_MS[attempt++]);
    }

    function start() {
      setState(attempt ? 'reconnecting' : 'connecting');
      return Promise.all([load(), opts.access(), dying]).then(function (r) {
        if (closed) return;
        var Daily = r[0];
        var access = r[1];
        // Рядом со входом, не после него: обе проверки идут одновременно.
        probe(access.url);
        var props = {
          // Речь, а не музыка: браузерные эхоподавление, шумоподавление
          // и автоусиление остаются включены.
          dailyConfig: { micAudioMode: 'speech' },
          subscribeToTracksAutomatically: !manual,
          startVideoOff: !(opts.send && opts.video && !voiceOnly),
          startAudioOff: !opts.send
        };
        if (opts.videoSource) props.videoSource = opts.videoSource;
        var c = Daily.createCallObject(props);
        call = c;
        // События мёртвого объекта сюда не доходят: c !== call.
        function mine(fn) { return function (e) { if (c === call) fn(e); }; }
        function peers() { emit('onPeers', Math.max(0, Object.keys(c.participants()).length - 1)); }

        if (diag) {
          note('объект звонка создан' + (attempt ? ' (повторный вход)' : ''));
          ['loading', 'loaded', 'load-attempt-failed', 'joining-meeting', 'joined-meeting', 'participant-joined', 'participant-left',
           'track-started', 'track-stopped', 'network-connection', 'nonfatal-error', 'error', 'left-meeting'].forEach(function (name) {
            c.on(name, mine(function (e) {
              note(describe(name, e));
              if (name === 'joined-meeting') diag.joined = true;
              if (name === 'track-started' && e.participant && !e.participant.local) diag.remote = true;
              if (name === 'participant-joined') awaitMedia(1);
            }));
          });
        }
        c.on('track-started', mine(function (e) { if (opts.onTrack && e.participant) opts.onTrack(e.track, e.participant, true); }));
        c.on('track-stopped', mine(function (e) { if (opts.onTrack && e.participant) opts.onTrack(e.track, e.participant, false); }));
        c.on('participant-joined', mine(function (e) {
          if (manual) subscribe(c, e.participant.session_id);
          peers();
        }));
        c.on('participant-left', mine(peers));
        c.on('network-quality-change', mine(function (e) { emit('onNetwork', netState(e)); }));
        c.on('remote-participants-audio-level', mine(function (e) { level(e && e.participantsAudioLevel); }));
        // Камеры или микрофона нет, либо доступ запрещён: во встречу Daily
        // всё равно пускает, но без картинки — сказать об этом должен сайт.
        c.on('camera-error', mine(function (e) { emit('onMediaError', e); }));
        // Сигнализация прервалась — Daily переподключается сам, мы только показываем.
        c.on('network-connection', mine(function (e) {
          if (e.type === 'signaling') setState(e.event === 'interrupted' ? 'reconnecting' : 'live');
        }));
        // Встреча потеряна насовсем: входим заново со свежим токеном.
        c.on('left-meeting', mine(fail));
        c.on('error', mine(fail));

        return c.join({ url: access.url, token: access.token }).then(function () {
          if (c !== call) return;
          attempt = 0;
          // Кнопку видео могли нажать, пока шло подключение: применяем здесь.
          if (manual || pending) { pending = false; applyVoiceOnly(c); }
          peers();
          setState('live');
          // Событие о сети Daily шлёт только при смене оценки: при хорошей
          // сети с первой секунды его не будет вовсе. Начальную берём сами.
          c.getNetworkStats().then(mine(function (s) { emit('onNetwork', netState(s)); })).catch(noop);
          // Уровень звука собеседника — раз в полсекунды. Для картинки
          // уровня в окне звонка этого хватает, а нагрузки на кадр нет:
          // считает сам Daily, мы только читаем число.
          try { c.startRemoteParticipantsAudioLevelObserver(500); } catch (e) {}
        }).catch(function (e) {
          // Тот же сбой Daily шлёт и событием error: оно уже сняло объект
          // и назначило повтор. Второй повтор поверх первого создавал второй
          // объект звонка («Duplicate DailyIframe instances») и тратил попытки
          // вдвое быстрее.
          if (c === call) throw e;
        });
      });
    }

    function run() { if (!closed) start().catch(fail); }
    run();

    return {
      get call() { return call; },
      // Те же имена, что у своего пути (public/tk-peer.js): окно звонка
      // и отчёт о звуке не должны знать, каким путём идёт разговор.
      sound: function () { return heard; },
      mic: mic,
      setMic: function (on) { if (call) call.setLocalAudio(!!on); },
      setCamera: function (on) {
        camOff = !on;
        if (call && call.meetingState() === 'joined-meeting') call.setLocalVideo(wantCamera());
      },
      // Застрял ли Daily у этой стороны (onStuck уже вызван).
      get stuck() { return !!(diag && diag.stuck); },
      // Видео в звонке. Выключено — только голос: своя камера гаснет, чужое
      // видео не принимается, на слабой сети это освобождает почти весь канал
      // под звук. Включено — камера и чужое видео, и в аудиозвонке тоже.
      setVideo: function (on) {
        opts.video = !!on;
        voiceOnly = !on;
        // До входа в комнату Daily не даёт менять подписку и бросает
        // исключение — так и было, когда «Только голос» нажимали во время
        // «Подключаемся…». Тогда настройка применится при входе.
        if (call && call.meetingState() === 'joined-meeting') applyVoiceOnly(call);
        else pending = true;
      },
      leave: function () {
        // Положили трубку, так и не дождавшись входа: это тоже случай.
        if (diag && !diag.joined && Date.now() - diag.t0 > 8000) report('положили трубку, не дождавшись входа в комнату', true);
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
