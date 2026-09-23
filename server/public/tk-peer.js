// Звонок через свой сервер: браузеры соединяются между собой по WebRTC,
// сигналы (SDP и кандидаты) ходят через наш сокет, а где напрямую не
// выходит — звук и видео идут через наш TURN (utils/turn.js).
//
// Запасной путь к Daily: у части людей в России провайдер душит соединения
// с его серверами, а до нашего всё доходит. Сюда звонок попадает сразу, если
// браузер помнит, что Daily у него не соединялся, или посреди звонка, когда
// Daily застрял (tk-daily.js, onStuck). Интерфейс — как у TKDaily.connect:
// окно звонка (tk-app.js) не знает, каким путём идёт разговор.
//
// Роли без гонок: предложение соединения делает только звонящий (offerer),
// собеседник только отвечает. Обе дорожки — звук и видео — заводятся сразу,
// поэтому включение камеры и «только голос» — замена дорожки без нового
// согласования.
(function () {
  function noop() {}

  // ── Свои дорожки ──
  // Микрофон и камера захватываются один раз на разговор, а не на каждое
  // соединение: вчетвером соединений три, и три захвата микрофона подряд
  // телефон просто не отдаст. Владелец — комната (room ниже), в разговоре
  // на двоих её заводит сам connect().
  function media() {
    var subs = [];
    var starting = false;
    var self = { mic: null, camera: null };

    function tell() { subs.slice().forEach(function (fn) { fn(self); }); }

    self.watch = function (fn) {
      subs.push(fn);
      return function () { subs = subs.filter(function (x) { return x !== fn; }); };
    };

    // Микрофон и камеру можно выключить кнопкой в окне звонка, не разрывая
    // соединения: дорожка остаётся, но молчит (mic) или шлёт чёрный кадр
    // (camera). Выбор запоминается: камера могла ещё не подняться к моменту
    // нажатия, и тогда он применится к ней при захвате.
    self.off = { mic: false, camera: false };
    self.setEnabled = function (kind, on) {
      self.off[kind] = !on;
      var track = kind === 'mic' ? self.mic : self.camera;
      if (track) track.enabled = !!on;
    };

    self.startMic = function (onError) {
      if (self.mic || self.micAsked) return;
      self.micAsked = true;
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
        if (self.closed) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
        self.mic = s.getAudioTracks()[0];
        self.mic.enabled = !self.off.mic;
        tell();
      }).catch(function (e) { if (onError) onError(e); });
    };

    self.startCamera = function (onError) {
      if (self.camera || starting) return;
      starting = true;
      navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } }).then(function (s) {
        starting = false;
        var track = s.getVideoTracks()[0];
        if (self.closed || self.voiceOnly) { track.stop(); return; }
        self.camera = track;
        self.camera.enabled = !self.off.camera;
        tell();
      }).catch(function (e) {
        starting = false;
        if (onError) onError(e);
      });
    };

    self.stopCamera = function () {
      if (!self.camera) return;
      var track = self.camera;
      self.camera = null;
      tell();
      track.stop();
    };

    self.stop = function () {
      self.closed = true;
      if (self.mic) self.mic.stop();
      if (self.camera) self.camera.stop();
      self.mic = null;
      self.camera = null;
      subs = [];
    };

    return self;
  }

  // Связи нет столько — звонок кончился. До первого соединения ждём дольше:
  // на слабом мобильном сигналы через сокет идут секундами (17.09.2026 у
  // заказчика ответ на перезапуск ICE не дошёл за 11 с).
  var CONNECT_MS = 45000;
  var GIVE_UP_MS = 30000;
  // Пока собеседник не ответил, привет повторяется: его вкладка могла ещё
  // не перейти на этот путь.
  var HELLO_MS = 2000;
  // Обрыв: столько ждём, что браузер восстановит сам, потом — перезапуск ICE.
  var RESTART_MS = 3000;
  var STATS_MS = 3000;

  // opts: как у TKDaily.connect, плюс
  //   ice      — iceServers от сервера (ключи TURN)
  //   offerer  — эта сторона делает предложение (звонящий)
  //   signal(data) — отправить сигнал собеседнику
  // Возвращает { setVideo, leave, signal(data) — принять сигнал }.
  function connect(opts) {
    var closed = false;
    // «Только голос» — как у Daily: включается кнопкой, а не типом звонка.
    // В аудиозвонке своя камера выключена, но видео собеседника принимается.
    var voiceOnly = false;
    var remote = { audio: null, video: null, sends: false, wants: true, shown: false };
    var pending = []; // кандидаты, пришедшие раньше описания сессии
    var chain = Promise.resolve(); // сигналы обрабатываются по очереди
    var state = null;
    var net = null;
    var lostAt = Date.now(); // соединения ещё не было — отсчёт с начала
    var connected = false; // соединение было хоть раз
    var lastRestart = 0;
    var timers = [];
    var heard = null;   // последняя снятая статистика звука собеседника
    var path = '';      // каким путём пошло соединение: напрямую или через TURN
    var t0 = Date.now();
    var log = [];
    var sent = false;
    // Для отчёта: какие пути вообще нашлись — свои кандидаты, кандидаты
    // собеседника, ошибки TURN. Без этого «не соединились» не объяснить.
    var found = { mine: {}, theirs: {}, errors: {} };

    function count(bag, key) { bag[key] = (bag[key] || 0) + 1; }
    function kind(line) {
      var m = / (udp|tcp) .* typ (\w+)/i.exec(line || '');
      return m ? m[2] + '/' + m[1].toLowerCase() : '?';
    }
    function list(bag) {
      var keys = Object.keys(bag);
      return keys.length ? keys.map(function (k) { return k + ' ' + bag[k]; }).join(', ') : 'нет';
    }

    function emit(name) { if (opts[name]) opts[name].apply(null, [].slice.call(arguments, 1)); }
    function every(fn, ms) { timers.push(setInterval(fn, ms)); }
    function send(data) { if (!closed) opts.signal(data); }
    function note(what) { if (log.length < 100) log.push(((Date.now() - t0) / 1000).toFixed(1) + ' с  ' + what); }

    var pc = new RTCPeerConnection({ iceServers: opts.ice, bundlePolicy: 'max-bundle' });
    var tx = { audio: null, video: null };
    if (opts.offerer) {
      tx.audio = pc.addTransceiver('audio', { direction: 'sendrecv' });
      tx.video = pc.addTransceiver('video', { direction: 'sendrecv' });
    }

    function setState(st) {
      if (st === state) return;
      state = st;
      note('состояние ' + st);
      emit('onState', st);
    }

    // ── Свои звук и видео ──
    // Дорожки общие на весь разговор: в комнате (room ниже) их держит она
    // и отдаёт каждому соединению, в разговоре на двоих соединение заводит
    // их себе. Камера горит, только пока видео включено; собеседнику она
    // уходит, только если он сам не в «только голос».
    var own = opts.media || media();
    var alone = !opts.media;      // дорожки мои — мне о них и сообщать окну
    var hadCamera = false;
    var lastCamera = null;

    function applySend() {
      if (tx.audio) tx.audio.sender.replaceTrack(own.mic).catch(noop);
      if (tx.video) tx.video.sender.replaceTrack(own.camera && remote.wants ? own.camera : null).catch(noop);
    }

    function announce() { send({ t: 'media', video: !!own.camera, want: !voiceOnly }); }

    function onMediaError(e) {
      note('устройство: ' + (e && e.name));
      emit('onMediaError', e);
    }

    // Дорожки появились или пропали — переложить их в соединение и сказать
    // об этом собеседнику. Окну о своей картинке сообщает владелец дорожек.
    var unwatch = own.watch(function () {
      applySend();
      announce();
      if (!alone) return;
      if (own.camera) lastCamera = own.camera;
      var on = !!own.camera;
      if (on === hadCamera || !lastCamera) return;
      hadCamera = on;
      emit('onTrack', lastCamera, { local: true }, on);
    });

    if (alone) {
      own.startMic(onMediaError);
      if (opts.video) own.startCamera(onMediaError);
    } else {
      applySend();   // комната могла захватить дорожки раньше этого соединения
    }

    // ── Чужие звук и видео ──
    function applyRemote() {
      var show = !!remote.video && remote.sends && !voiceOnly;
      if (show === remote.shown) return;
      remote.shown = show;
      emit('onTrack', remote.video, { local: false }, show);
    }

    pc.ontrack = function (e) {
      if (e.track.kind === 'audio') {
        remote.audio = e.track;
        emit('onTrack', e.track, { local: false }, true);
      } else {
        remote.video = e.track;
        applyRemote();
      }
    };

    // ── Сигналы ──
    pc.onicecandidate = function (e) {
      if (!e.candidate) return note('свои кандидаты собраны: ' + list(found.mine));
      count(found.mine, kind(e.candidate.candidate) + (e.candidate.relayProtocol ? ' через ' + e.candidate.relayProtocol : ''));
      send({ t: 'ice', c: e.candidate.toJSON() });
    };
    pc.onicecandidateerror = function (e) { count(found.errors, e.errorCode + ' ' + (e.url || '') + ' ' + (e.errorText || '')); };

    function offer(restart) {
      return pc.createOffer({ iceRestart: !!restart }).then(function (o) {
        return pc.setLocalDescription(o);
      }).then(function () {
        note(restart ? 'перезапуск ICE' : 'предложение');
        send({ t: 'offer', sdp: pc.localDescription.toJSON() });
      });
    }

    function flush() {
      var list = pending;
      pending = [];
      return Promise.all(list.map(function (c) { return pc.addIceCandidate(c).catch(noop); }));
    }

    function onOffer(sdp) {
      return pc.setRemoteDescription(sdp).then(function () {
        // Дорожки заводит звонящий: здесь они появились вместе с предложением.
        pc.getTransceivers().forEach(function (t) {
          var kind = t.receiver.track.kind;
          if (tx[kind]) return;
          t.direction = 'sendrecv';
          tx[kind] = t;
        });
        applySend();
        return flush();
      }).then(function () {
        return pc.createAnswer();
      }).then(function (a) {
        return pc.setLocalDescription(a);
      }).then(function () {
        note('ответ');
        send({ t: 'answer', sdp: pc.localDescription.toJSON() });
        announce();
      });
    }

    function receive(d) {
      if (closed || !d || typeof d.t !== 'string') return;
      chain = chain.then(function () {
        if (closed) return;
        switch (d.t) {
          // Собеседник на связи. Звонящий шлёт предложение (или повторяет
          // то, что уже отправил), собеседник — привет в ответ, если
          // предложения ещё не было.
          case 'hello':
            if (!opts.offerer) {
              if (!pc.remoteDescription) send({ t: 'hello' });
              return;
            }
            if (pc.signalingState === 'have-local-offer') return send({ t: 'offer', sdp: pc.localDescription.toJSON() });
            if (!pc.remoteDescription) return offer(false);
            return;
          case 'offer':
            if (opts.offerer) return;
            // Звонящий повторяет предложение, пока не дойдёт наш ответ: на
            // медленном сокете одно и то же приходит по нескольку раз.
            // Повтор — не новое согласование, а повод повторить ответ.
            if (pc.remoteDescription && pc.remoteDescription.sdp === d.sdp.sdp) {
              if (pc.localDescription) send({ t: 'answer', sdp: pc.localDescription.toJSON() });
              return;
            }
            return onOffer(d.sdp);
          case 'answer':
            if (opts.offerer && pc.signalingState === 'have-local-offer') {
              return pc.setRemoteDescription(d.sdp).then(flush).then(announce);
            }
            return;
          case 'ice':
            count(found.theirs, kind(d.c && d.c.candidate));
            if (pc.remoteDescription) return pc.addIceCandidate(d.c).catch(noop);
            pending.push(d.c);
            return;
          case 'restart':
            if (opts.offerer) return restart();
            return;
          case 'media':
            remote.sends = !!d.video;
            remote.wants = !!d.want;
            applyRemote();
            applySend();
            return;
        }
      }).catch(function (e) {
        note('сбой сигнала ' + d.t + ': ' + (e && e.message));
      });
    }

    // Перезапуск ICE — не чаще раза в RESTART_MS. Предложение делает звонящий,
    // собеседник только просит.
    function restart() {
      if (closed || Date.now() - lastRestart < RESTART_MS) return;
      lastRestart = Date.now();
      if (!opts.offerer) return send({ t: 'restart' });
      if (pc.signalingState !== 'stable') return;
      return offer(true);
    }

    // ── Соединение ──
    pc.onconnectionstatechange = function () {
      var st = pc.connectionState;
      note('соединение ' + st);
      if (st === 'connected') {
        lostAt = 0;
        connected = true;
        emit('onPeers', 1);
        setState('live');
        route();
      } else if (st === 'disconnected' || st === 'failed') {
        if (!lostAt) lostAt = Date.now();
        setState('reconnecting');
        if (st === 'failed') restart();
        else timers.push(setTimeout(function () { if (pc.connectionState === 'disconnected') restart(); }, RESTART_MS));
      }
    };

    // Каким путём пошло: напрямую или через наш TURN, и каким транспортом.
    function route() {
      pc.getStats().then(function (stats) {
        stats.forEach(function (s) {
          if (s.type !== 'candidate-pair' || !s.nominated || s.state !== 'succeeded') return;
          var lc = stats.get(s.localCandidateId);
          var rc = stats.get(s.remoteCandidateId);
          if (lc && rc) note('путь: ' + lc.candidateType + '/' + (lc.relayProtocol || lc.protocol) + ' → ' + rc.candidateType);
        });
      }).catch(noop);
    }

    // ── Отчёт, если свой путь тоже не соединился ──
    function report(kind) {
      if (!opts.diag || sent) return;
      sent = true;
      fetch('/api/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page: location.pathname,
          name: 'CallDiag',
          message: 'Звонок через свой сервер: ' + kind,
          details: [
            opts.diag + ' через свой сервер: ' + kind,
            'соединение: ' + pc.connectionState + ', ICE: ' + pc.iceConnectionState + ', сигналы: ' + pc.signalingState,
            'свои кандидаты: ' + list(found.mine),
            'кандидаты собеседника: ' + list(found.theirs),
            'ошибки TURN: ' + list(found.errors),
            'сеть браузера: ' + ((navigator.connection || {}).type || '?') + ' / ' + ((navigator.connection || {}).effectiveType || '?'),
            'роль: ' + (opts.offerer ? 'звонящий' : 'отвечающий'),
            '— хронология —'
          ].concat(log),
          keepalive: true
        })
      }).catch(noop);
    }

    // Качество сети — по потерям и задержке, как оценка Daily: good | low | bad.
    // Тем же проходом снимаем звук собеседника: энергия и уровень из
    // getStats() — единственный способ понять, доходит ли до человека звук,
    // не заводя WebAudio (в звонке он запрещён, см. public/tk-audio.js).
    var prev = null;
    every(function () {
      if (pc.connectionState !== 'connected') return;
      pc.getStats().then(function (stats) {
        var lost = 0, got = 0, rtt = 0;
        var sound = null;
        stats.forEach(function (s) {
          if (s.type === 'inbound-rtp') {
            lost += s.packetsLost || 0;
            got += s.packetsReceived || 0;
            if (s.kind === 'audio') {
              sound = {
                energy: s.totalAudioEnergy || 0,
                level: s.audioLevel || 0,
                packets: s.packetsReceived || 0,
                lost: s.packetsLost || 0,
                jitter: s.jitter || 0,
              };
            }
          }
          if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
            rtt = s.currentRoundTripTime || 0;
            var lc = stats.get(s.localCandidateId);
            var rc = stats.get(s.remoteCandidateId);
            if (lc && rc) path = lc.candidateType + '/' + (lc.relayProtocol || lc.protocol) + ' → ' + rc.candidateType;
          }
        });
        if (sound) {
          sound.route = path;
          // Уровень — приращение энергии за срез: сам audioLevel
          // в мгновении, а энергия копится с начала разговора.
          sound.grew = heard ? Math.max(0, sound.energy - heard.energy) : 0;
          heard = sound;
          emit('onAudio', sound);
        }
        if (prev) {
          var dl = lost - prev.lost, dg = got - prev.got;
          var loss = dl + dg > 0 ? dl / (dl + dg) : 0;
          var level = loss > 0.1 || rtt > 0.8 ? 'bad' : loss > 0.03 || rtt > 0.4 ? 'low' : 'good';
          if (level !== net) { net = level; emit('onNetwork', level); }
        }
        prev = { lost: lost, got: got };
      }).catch(noop);
    }, STATS_MS);

    // Сдаёмся, если связи нет CONNECT_MS до первого соединения или GIVE_UP_MS
    // после обрыва. Привет повторяется, пока не
    // обменялись описаниями.
    every(function () {
      var limit = connected ? GIVE_UP_MS : CONNECT_MS;
      if (lostAt && Date.now() - lostAt > limit) {
        report((connected ? 'связь пропала и не вернулась за ' : 'не соединились за ') + limit / 1000 + ' с');
        leave();
        emit('onState', 'ended');
        return;
      }
      if (!pc.remoteDescription) send({ t: 'hello' });
    }, HELLO_MS);

    emit('onPeers', 0);
    setState('connecting');
    send({ t: 'hello' });

    function leave() {
      if (closed) return Promise.resolve();
      closed = true;
      timers.forEach(function (id) { clearInterval(id); clearTimeout(id); });
      unwatch();
      pc.close();
      if (alone) own.stop();   // в комнате дорожки общие — их закрывает она
      return Promise.resolve();
    }

    return {
      call: null,
      signal: receive,
      // Для отчёта о звуке (public/tk-audio.js): что пришло по сети и как.
      sound: function () { return heard; },
      mic: function () { return own.mic; },
      // Свой микрофон и своя камера — кнопками в окне звонка. Это не то же,
      // что «Только голос» ниже: там гаснет видео в обе стороны ради канала,
      // здесь — только своё, собеседника по-прежнему видно и слышно.
      setMic: function (on) { own.setEnabled('mic', on); },
      setCamera: function (on) { own.setEnabled('camera', on); },
      // Как у Daily: выключено — только голос, своя камера гаснет и чужое
      // видео не принимается (собеседник перестаёт его слать).
      setVideo: function (on) {
        voiceOnly = !on;
        opts.video = !!on;
        own.voiceOnly = !on;
        if (alone) { if (on) own.startCamera(onMediaError); else own.stopCamera(); }
        applyRemote();
        applySend();
        announce();
      },
      leave: leave
    };
  }

  // ── Комната: разговор на троих и четверых ──
  // Сетка: соединение с каждым (на четверых — три). Окну звонка комната
  // выглядит почти как одно соединение — те же onTrack/onPeers/onState/
  // onNetwork, только у чужих дорожек и состояний добавлен userId.
  //
  // Микрофон и камера захватываются один раз на всех (media выше): три
  // отдельных захвата телефон бы не отдал.
  //
  // opts: как у connect, плюс
  //   peers — [{ userId, offerer, ice }] — кто уже в разговоре
  //   signal(data, to) — отправить сигнал конкретному участнику
  //   onPeerLeft(userId) — участник ушёл насовсем: убрать его плитку
  function room(opts) {
    var own = media();
    var links = {};        // userId → соединение
    var states = {};       // userId → состояние его соединения
    var closed = false;
    var voiceOnly = !opts.video;
    var lastCamera = null;

    function emit(name) { if (opts[name]) opts[name].apply(null, [].slice.call(arguments, 1)); }
    function ids() { return Object.keys(links); }
    function onMediaError(e) { emit('onMediaError', e); }

    // Своя картинка в комнате одна на всех — о ней говорит комната, а не
    // каждое соединение.
    own.watch(function () {
      if (own.camera) lastCamera = own.camera;
      if (!lastCamera) return;
      emit('onTrack', lastCamera, { local: true }, !!own.camera);
    });

    // Общее состояние: кто-то переподключается — так и говорим; иначе
    // «на связи», пока хоть с кем-то соединились.
    function overall() {
      var all = ids().map(function (id) { return states[id]; });
      if (all.some(function (st) { return st === 'reconnecting'; })) return 'reconnecting';
      if (all.some(function (st) { return st === 'live'; })) return 'live';
      return 'connecting';
    }

    function add(peer) {
      var id = String(peer.userId);
      if (closed || links[id]) return;
      states[id] = 'connecting';
      links[id] = connect({
        ice: peer.ice || opts.ice,
        offerer: !!peer.offerer,
        video: !voiceOnly,
        diag: opts.diag,
        media: own,
        signal: function (data) { opts.signal(data, id); },
        onTrack: function (track, p, on) { if (!p.local) emit('onTrack', track, { local: false, userId: id }, on); },
        onPeers: function () { emit('onPeers', ids().length); },
        onNetwork: function (n) { emit('onNetwork', n, id); },
        onAudio: function (sound) { emit('onAudio', sound, id); },
        onMediaError: onMediaError,
        onState: function (st) {
          // Соединение сдалось. Вдвоём это конец разговора, втроём —
          // минус один участник: остальные продолжают.
          if (st === 'ended') {
            if (ids().length <= 1) return emit('onState', 'ended');
            drop(id);
            return;
          }
          states[id] = st;
          emit('onState', overall());
        },
      });
      emit('onPeers', ids().length);
    }

    function drop(id) {
      if (!links[id]) return;
      links[id].leave();
      delete links[id];
      delete states[id];
      emit('onPeerLeft', id);
      emit('onPeers', ids().length);
      if (!closed) emit('onState', overall());
    }

    own.startMic(onMediaError);
    if (opts.video) own.startCamera(onMediaError);
    (opts.peers || []).forEach(add);

    return {
      call: null,
      add: add,
      drop: drop,
      // Отчёт о звуке берёт того собеседника, от которого пришло больше
      // всего звука: если слышно хоть кого-то, дело не в нашей стороне.
      sound: function () {
        return ids().map(function (id) { return links[id].sound(); })
          .filter(Boolean)
          .sort(function (a, b) { return b.energy - a.energy; })[0] || null;
      },
      mic: function () { return own.mic; },
      setMic: function (on) { own.setEnabled('mic', on); },
      setCamera: function (on) { own.setEnabled('camera', on); },
      // Сигнал от участника — его же соединению.
      signal: function (from, data) { if (links[from]) links[from].signal(data); },
      setVideo: function (on) {
        voiceOnly = !on;
        own.voiceOnly = !on;
        if (on) own.startCamera(onMediaError); else own.stopCamera();
        ids().forEach(function (id) { links[id].setVideo(on); });
      },
      leave: function () {
        closed = true;
        ids().forEach(function (id) { links[id].leave(); delete links[id]; });
        own.stop();
        return Promise.resolve();
      },
    };
  }

  window.TKPeer = { connect: connect, room: room };
})();
