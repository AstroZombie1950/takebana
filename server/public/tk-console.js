/* Пульт ведущего: картинка, кнопки эфира, чат. Настроек здесь нет — они
 * в студии (/tk-studio.js) и после выхода в эфир не нужны.
 *
 * Веб-эфир: камера через Daily, «Пауза» и «Продолжить», микрофон, смена
 * камеры, экран телефона не гаснет, пока идёт эфир. OBS-эфир: предпросмотр
 * того же HLS, что у зрителя; начало и паузу решает программа.
 * Завершение — с записью или без (utils/recording.js на сервере).
 *
 * Разметка — views/streamPage.ejs (фаза console). Раньше пульт был
 * инлайн-скриптом шаблона и не кэшировался.
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var data = document.body.dataset;
  var streamId = data.streamId;
  var streamKey = data.streamKey;
  var OBS = data.source === 'obs';
  var everLive = data.firstLive === '1';

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        // Текст сервера — на языке интерфейса: «сервис видео не запустил
        // трансляцию» ведущему понятнее, чем HTTP 502.
        if (!r.ok) throw new Error(b.message || 'HTTP ' + r.status);
        return b;
      });
    });
  }

  // Адрес ?go=1 нужен один раз: обновление страницы не должно снова выводить в эфир.
  if (data.autostart) history.replaceState(null, '', location.pathname);

  // ── Пульс: пока пульт открыт, эфир не считается брошенным ──
  // jobs/streamCleanup.js смотрит на updatedAt. Таймеры фоновой вкладки
  // браузер душит, поэтому пульс уходит и при каждой смене видимости.
  var lastBeat = 0;
  function beat() {
    if (Date.now() - lastBeat < 3000) return;
    lastBeat = Date.now();
    fetch('/stream/active/' + streamId, { method: 'POST', keepalive: true }).catch(function () {});
  }
  beat();
  setInterval(beat, 20000);
  document.addEventListener('visibilitychange', beat);
  window.addEventListener('pagehide', function () { navigator.sendBeacon('/stream/active/' + streamId); });

  var hint = $('playerHint');
  function showHint(key) {
    hint.hidden = !key;
    if (key) tkText(hint.querySelector('p'), key);
  }

  function live(on, since) {
    TKStream.state(on ? 'live' : OBS ? 'wait' : 'paused');
    if (on) {
      everLive = true;
      TKStream.timer.start(since || new Date().toISOString());
    } else {
      TKStream.timer.stop();
    }
  }

  // ── Завершение ────────────────────────────────────────────────────────
  // Выходил в эфир и записи включены — спрашиваем, сохранить ли запись.
  // Иначе сохранять нечего: обычное подтверждение.
  var endBtn = $('endBtn');
  endBtn.addEventListener('click', function () {
    var ask = data.recording && everLive
      ? chooseDialog(t('stream.endQ'), [
          { value: 'discard', text: t('stream.endDiscard'), danger: false },
          { value: 'save', text: t('stream.endSave') }
        ])
      : confirmDialog(t('stream.endConfirm'), { okText: t('stream.end') }).then(function (ok) { return ok ? 'discard' : null; });

    ask.then(function (choice) {
      if (!choice) return;
      endBtn.disabled = true;
      tkText(endBtn, 'stream.ending');
      var leaving = streamer ? streamer.leave() : Promise.resolve();
      return leaving
        .then(function () { return post('/terminate-stream', { streamId: streamId, save: choice === 'save' }); })
        .then(function (b) {
          if (b.recordingId) {
            toast(t('stream.saving'), 'ok');
            location.href = '/userPage/' + data.userId + '#recordings';
          } else {
            location.href = '/';
          }
        });
    }).catch(function (e) {
      toast(t('stream.endFailed') + ' ' + e.message, 'error');
      endBtn.disabled = false;
      tkText(endBtn, 'stream.end');
    });
  });

  // ── OBS ───────────────────────────────────────────────────────────────
  var streamer = null;

  if (OBS) {
    var obsToggle = $('obsToggle');
    var obsPanel = $('obsPanel');
    obsToggle.addEventListener('click', function () {
      obsPanel.hidden = !obsPanel.hidden;
      obsToggle.setAttribute('aria-expanded', String(!obsPanel.hidden));
    });

    // Предпросмотр ждёт плейлист, пока OBS не начал вещать, и снова ждёт после обрыва.
    var preview = $('video');
    preview.addEventListener('playing', function () {
      preview.hidden = false;
      showHint(null);
    });
    TKHls.play(preview, '/live/' + streamKey + '/index.m3u8');

    // Идёт ли OBS-эфир, решает приём RTMP (mediaServer.js) — он и присылает
    // stream:update. Реагируем только на смену состояния.
    var obsLive = !!data.startedAt;
    TKStream.onUpdate(function (u) {
      if (typeof u.isActive !== 'boolean' || u.isActive === obsLive) return;
      obsLive = u.isActive;
      live(obsLive, u.startedAt);
      if (obsLive) {
        obsPanel.hidden = true;
        obsToggle.setAttribute('aria-expanded', 'false');
      } else {
        preview.hidden = true;
        showHint('stream.obsWaitHint');
      }
    });
    return;
  }

  // ── Веб: камера через Daily ───────────────────────────────────────────
  var startBtn = $('startBtn');
  var pauseBtn = $('pauseBtn');
  var micBtn = $('micBtn');
  var cameraBtn = $('cameraBtn');
  var select = $('cameraSelect');
  var localVideo = $('localVideo');

  function showLocal(track) {
    TKDaily.attach(localVideo, track);
    localVideo.hidden = !track;
    showHint(track ? null : 'stream.pausedHint');
  }

  // Камера: «device:<id>» или, если браузер список не отдал (iOS),
  // «facing:user» / «facing:environment». Выбор помнит студия (tk_camera).
  function useCamera(call, value) {
    if (!value) return Promise.resolve();
    var v = value.slice(value.indexOf(':') + 1);
    return value.indexOf('device:') === 0
      ? call.setInputDevicesAsync({ videoDeviceId: v })
      : call.startCamera({ facingMode: v });
  }

  function fillCameras() {
    return navigator.mediaDevices.enumerateDevices().then(function (devices) {
      var cams = devices.filter(function (d) { return d.kind === 'videoinput'; });
      var values = cams.length > 1 ? cams.map(function (c) { return 'device:' + c.deviceId; })
        : cams.length ? [] : ['facing:user', 'facing:environment'];
      select.replaceChildren.apply(select, values.map(function (v) { return new Option(v, v); }));
      var saved = '';
      try { saved = localStorage.getItem('tk_camera') || ''; } catch (e) {}
      if (values.indexOf(saved) !== -1) select.value = saved;
      // Одна камера — переключать нечего.
      cameraBtn.hidden = values.length < 2;
    }).catch(function () {});
  }

  // Экран телефона не гаснет, пока идёт эфир: погасший экран — это
  // остановленная камера. Блокировку браузер снимает сам, когда вкладку
  // уводят в фон, — возвращаем её при возвращении.
  var wakeLock = null;
  function holdScreen(on) {
    if (!('wakeLock' in navigator)) return;
    if (!on) {
      if (wakeLock) wakeLock.release().catch(function () {});
      wakeLock = null;
      return;
    }
    navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && streamer && streamer.connected) holdScreen(true);
  });

  function Streamer() {
    this.session = null;
    this.connected = false;
  }

  // Сервер создаёт комнату и тем же ответом отдаёт токен вещателя. Камеру
  // и микрофон Daily берёт сам при входе. После входа — выход комнаты на
  // наш приём (/set-active): зрители смотрят HLS.
  Streamer.prototype.start = function () {
    var self = this;
    startBtn.disabled = true;
    tkText(startBtn, 'studio.connecting');
    showHint('studio.connecting');
    var first = null;
    return TKDaily.requestAccess('/api/create-room', { streamId: streamId })
      .then(function (access) {
        first = access;
        return new Promise(function (resolve, reject) {
          self.session = TKDaily.connect({
            send: true,
            video: true,
            // Повторный вход после обрыва — в ту же комнату со свежим токеном.
            access: function () {
              if (!first) return TKDaily.requestAccess('/api/get-token', { streamId: streamId });
              var a = first;
              first = null;
              return Promise.resolve(a);
            },
            onTrack: function (track, p, on) {
              if (p.local && track.kind === 'video') showLocal(on ? track : null);
            },
            onMediaError: function () { toast(t('stream.mediaDeniedObs'), 'error'); },
            onState: function (state) {
              if (state === 'live') resolve();
              if (state !== 'ended') return;
              reject(new Error(t('stream.serviceDown')));
              if (self.connected) {
                toast(t('stream.serviceLost'), 'error');
                self.pause();
              }
            },
          });
        });
      })
      .then(function () {
        var saved = '';
        try { saved = localStorage.getItem('tk_camera') || ''; } catch (e) {}
        return useCamera(self.session.call, saved).catch(function () {});
      })
      .then(function () { return post('/set-active', { streamKey: streamKey }); })
      .then(function () {
        self.connected = true;
        live(true);
        startBtn.hidden = true;
        pauseBtn.hidden = false;
        micBtn.disabled = false;
        holdScreen(true);
        tkText(startBtn, 'stream.resume');
        return fillCameras();
      })
      .catch(function (error) {
        if (self.session) { self.session.leave(); self.session = null; }
        showHint('stream.pausedHint');
        tkText(startBtn, everLive ? 'stream.resume' : 'studio.go');
        toast(t('app.errorShort', { message: error.message }), 'error');
      })
      .then(function () { startBtn.disabled = false; });
  };

  // Выйти из комнаты. Комната и выход на приём гаснут на сервере — паузой
  // (/set-inactive и удаление комнаты) или завершением эфира.
  // Уйти со страницы в эфире — выключить камеру: браузер переспросит.
  window.addEventListener('beforeunload', function (e) {
    if (streamer && streamer.connected) e.preventDefault();
  });

  Streamer.prototype.leave = function () {
    var session = this.session;
    this.session = null;
    this.connected = false;
    holdScreen(false);
    return session ? Promise.resolve(session.leave()) : Promise.resolve();
  };

  Streamer.prototype.pause = function () {
    return this.leave()
      .then(function () { return post('/set-inactive', { streamKey: streamKey }); })
      .catch(function (e) { console.error('[stream] эфир не снят в базе:', e); })
      // Удаление комнаты отключает и выход на приём.
      .then(function () { return fetch('/api/delete-room/' + streamId, { method: 'DELETE' }).catch(function () {}); })
      .then(function () {
        live(false);
        showLocal(null);
        pauseBtn.hidden = true;
        startBtn.hidden = false;
        micBtn.disabled = true;
        setMic(true);
      });
  };

  streamer = new Streamer();

  startBtn.addEventListener('click', function () { streamer.start(); });
  pauseBtn.addEventListener('click', function () {
    pauseBtn.disabled = true;
    streamer.pause().then(function () { pauseBtn.disabled = false; });
  });

  // ── Микрофон ──
  function setMic(on) {
    micBtn.setAttribute('aria-pressed', String(!on));
    var key = on ? 'stream.micOff' : 'stream.micOn';
    micBtn.setAttribute('data-i18n-aria', key);
    micBtn.setAttribute('data-i18n-title', key);
    micBtn.setAttribute('aria-label', t(key));
    micBtn.title = t(key);
  }
  micBtn.addEventListener('click', function () {
    var call = streamer.session && streamer.session.call;
    if (!call) return;
    var on = micBtn.getAttribute('aria-pressed') === 'true'; // сейчас выключен — включаем
    call.setLocalAudio(on);
    setMic(on);
  });

  // ── Смена камеры посреди эфира: следующая по списку ──
  cameraBtn.addEventListener('click', function () {
    var call = streamer.session && streamer.session.call;
    if (!call || select.options.length < 2) return;
    select.selectedIndex = (select.selectedIndex + 1) % select.options.length;
    try { localStorage.setItem('tk_camera', select.value); } catch (e) {}
    cameraBtn.disabled = true;
    useCamera(call, select.value)
      .catch(function (e) { console.warn('[stream] камера не переключилась:', e); })
      .then(function () { cameraBtn.disabled = false; });
  });

  // Страница открылась, а эфир в базе «идёт» — это обновление страницы или
  // вторая вкладка: камеры в комнате уже нет. Ставим на паузу, чтобы зрители
  // не смотрели пустой кадр, и ведущий продолжает кнопкой.
  if (data.startedAt) {
    streamer.pause();
  } else if (data.autostart) {
    streamer.start();
  }
})();
