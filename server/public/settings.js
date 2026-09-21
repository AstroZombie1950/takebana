/* Настройки профиля: имя и никнейм, фото, пароль, почта, уведомления,
 * камера и микрофон, удаление аккаунта. Язык переключает общий
 * tk-i18n.js по кнопкам с data-lang — здесь для него ничего не нужно.
 *
 * Раньше жило в tk-app.js и грузилось с каждой страницей кабинета вместе
 * с окном профиля.
 */
(function () {
  var t = window.t || function () { return ''; };
  var tkText = window.tkText || function () {};
  var $ = function (id) { return document.getElementById(id); };

  // Ответ сервера — JSON с message; не 2xx — ошибка с этим текстом.
  // Accept — чтобы и общий обработчик ошибок (middleware/errors.js) ответил
  // JSON, а не страницей: иначе отказ загрузки («Только изображения JPEG…»)
  // доходил до человека как безликое «HTTP 400».
  function send(url, options) {
    options = options || {};
    options.headers = Object.assign({ Accept: 'application/json' }, options.headers);
    return fetch(url, options).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok || data.success === false) throw new Error(data.message || 'HTTP ' + r.status);
        return data;
      });
    });
  }

  function json(body) {
    return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }

  // «Как разрешить?» раскрывается и сворачивается плавно: <details> сам
  // делает это рывком. Анимируется высота всего блока — от строки-ссылки
  // до полной; open снимается, когда сворачивание доиграло.
  var calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  document.querySelectorAll('.tk-set__how').forEach(function (box) {
    var summary = box.querySelector('summary');
    var run = null;
    summary.addEventListener('click', function (e) {
      if (calm.matches || !box.animate) return;
      e.preventDefault();
      var opening = !box.open || box.classList.contains('is-closing');
      // Нажали посреди анимации — продолжаем с той высоты, что на экране.
      var from = box.getBoundingClientRect().height;
      if (run) run.cancel();
      box.open = opening || box.open;
      box.classList.toggle('is-closing', !opening);
      var to = opening ? box.getBoundingClientRect().height : summary.getBoundingClientRect().height;
      box.style.overflow = 'hidden';
      run = box.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: 260, easing: 'cubic-bezier(.2, .7, .2, 1)' });
      run.onfinish = function () {
        run = null;
        box.style.overflow = '';
        if (!opening) { box.open = false; box.classList.remove('is-closing'); }
      };
    });
  });

  // ── Имя и никнейм ─────────────────────────────────────────────────────
  // Ник проверяется на ходу: формат — здесь же, занятость — запросом
  // (routes/userRoutes.js), с паузой на набор. Правила — utils/nickname.js.
  var nick = $('profileNick');
  var nickStatus = $('nickStatus');
  var NICK_RULE = /^[a-z][a-z0-9_]{2,19}$/;
  var nickTimer = null, nickSeq = 0;

  function nickSay(key, vars, state) {
    nickStatus.className = 'tk-set__status' + (state ? ' is-' + state : '');
    if (!key) { nickStatus.textContent = ''; nickStatus.removeAttribute('data-i18n'); return; }
    tkText(nickStatus, key, vars);
  }

  function untilVars(iso) {
    return { date: tkDate(iso, { day: 'numeric', month: 'long', year: 'numeric' }) };
  }

  function nickReason(reason, until) {
    if (reason === 'wait') return nickSay('settings.nick.wait', untilVars(until), 'bad');
    nickSay('settings.nick.' + (reason || 'format'), null, 'bad');
  }

  function checkNick() {
    var v = nick.value.trim().toLowerCase();
    if (nick.value !== v) nick.value = v;
    clearTimeout(nickTimer);
    if (v === nick.dataset.current) return nickSay(nick.dataset.next ? 'settings.nick.wait' : null, nick.dataset.next ? untilVars(nick.dataset.next) : null, '');
    if (!NICK_RULE.test(v)) return nickReason('format');
    nickSay('settings.nick.checking', null, '');
    var seq = ++nickSeq;
    nickTimer = setTimeout(function () {
      fetch('/api/nickname/check?n=' + encodeURIComponent(v))
        .then(function (r) { return r.json(); })
        .then(function (r) {
          if (seq !== nickSeq) return; // уже печатают дальше
          if (r.ok) nickSay('settings.nick.free', null, 'ok');
          else nickReason(r.reason, r.until);
        })
        .catch(function () { if (seq === nickSeq) nickSay(null); });
    }, 350);
  }

  nick.addEventListener('input', checkNick);
  checkNick();

  $('nameForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = nick.value.trim().toLowerCase();
    if (!NICK_RULE.test(v)) { nickReason('format'); return nick.focus(); }
    var btn = e.target.querySelector('[type="submit"]');
    btn.disabled = true;
    fetch('/update-profile', json({ login: $('profileName').value.trim(), nickname: v }))
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (x) {
        if (!x.ok) {
          if (x.b.reason) nickReason(x.b.reason, x.b.until);
          return toast(t('app.errorPrefix', { message: x.b.message || '' }), 'error');
        }
        // Ник стоит по всей странице — в шапке панели, подписях: проще
        // перезагрузить, чем искать каждое место.
        if (x.b.nickname !== nick.dataset.current) return location.reload();
        toast(t('settings.saved'), 'ok');
      })
      .catch(function () { toast(t('common.noNetwork'), 'error'); })
      .finally(function () { btn.disabled = false; });
  });

  // ── Почта ─────────────────────────────────────────────────────────────
  // Новый адрес вступает в силу по ссылке из письма на него
  // (routes/emailChange.js); до тех пор — «ждёт подтверждения».
  var emailForm = $('emailForm');
  if (emailForm) {
    emailForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = $('newEmail').value.trim();
      var pass = $('emailPassword');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast(t('settings.emailBad'), 'error');
      if (!pass.value) return toast(t('settings.delete.needPassword'), 'error');
      // Кнопка стоит вне формы (под нынешним адресом) и держится за неё
      // через form=, поэтому внутри формы её не найти.
      var btn = document.querySelector('button[form="emailForm"]');
      btn.disabled = true;
      send('/settings/email', json({ email: email, password: pass.value }))
        .then(function () {
          $('emailPendingAddr').textContent = email;
          $('emailPending').hidden = false;
          $('newEmail').value = '';
          pass.value = '';
          toast(t('settings.emailSent'), 'ok');
        })
        .catch(function (err) { toast(t('app.errorPrefix', { message: err.message }), 'error'); })
        .finally(function () { btn.disabled = false; });
    });
  }

  // ── Фото профиля ──────────────────────────────────────────────────────
  var avatarInput = $('avatarInput');
  var chooseAvatar = $('chooseAvatarBtn');
  var deleteAvatar = $('deleteAvatarBtn');
  var avatarHint = $('avatarHint');

  // Аватар везде на странице — здесь и в левой панели: фото или градиент
  // с буквой, как его отдал сервер (utils/userView.js).
  function paintAvatar(ava) {
    var boxes = [$('avatarBox')].concat(Array.prototype.slice.call(document.querySelectorAll('[data-my-avatar]')));
    boxes.forEach(function (box) {
      box.style.background = ava.url ? '' : ava.gradient;
      box.innerHTML = ava.url ? '<img src="' + escapeHtml(ava.url) + '" alt="">' : escapeHtml(ava.initial || '');
    });
    tkText(chooseAvatar, ava.url ? 'settings.photoReplace' : 'settings.photoUpload');
    deleteAvatar.hidden = !ava.url;
  }

  function busy(on) {
    chooseAvatar.disabled = on;
    deleteAvatar.disabled = on;
  }

  chooseAvatar.addEventListener('click', function () { avatarInput.click(); });

  avatarInput.addEventListener('change', function () {
    var file = avatarInput.files[0];
    avatarInput.value = ''; // тот же файл ещё раз — снова change
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      return tkText(avatarHint, 'app.fileBad');
    }
    var form = new FormData();
    form.append('avatar', file);
    busy(true);
    tkText(avatarHint, 'app.uploading');
    send('/profile/avatar', { method: 'POST', body: form })
      .then(function (data) {
        paintAvatar(data.avatar);
        tkText(avatarHint, 'app.photoDone');
      })
      .catch(function (err) { avatarHint.removeAttribute('data-i18n'); avatarHint.textContent = t('app.errorShort', { message: err.message }); })
      .finally(function () { busy(false); });
  });

  deleteAvatar.addEventListener('click', function () {
    confirmDialog(t('settings.photoDeleteQ'), { okText: t('settings.photoDelete') }).then(function (ok) {
      if (!ok) return;
      busy(true);
      return send('/profile/avatar', { method: 'DELETE' })
        .then(function (data) {
          paintAvatar(data.avatar);
          tkText(avatarHint, 'settings.photoLimit');
        })
        .finally(function () { busy(false); });
    }).catch(function (err) { toast(t('app.deleteError', { message: err.message }), 'error'); });
  });

  // ── Удаление аккаунта ─────────────────────────────────────────────────
  // Подтверждение — пароль (у входа через Google его нет) и вопрос в диалоге:
  // отменить удаление нельзя, случайное нажатие стоит слишком дорого.
  var deleteForm = $('deleteForm');
  if (deleteForm) {
    deleteForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var pass = $('deletePassword');
      if (pass && !pass.value) return toast(t('settings.delete.needPassword'), 'error');
      confirmDialog(t('settings.delete.ask'), { okText: t('settings.delete.btn') }).then(function (yes) {
        if (!yes) return;
        send('/profile/delete', json(pass ? { password: pass.value } : {}))
          .then(function () { location.href = '/'; })
          .catch(function (err) {
            if (pass) pass.value = '';
            toast(t('app.errorPrefix', { message: err.message }), 'error');
          });
      });
    });
  }

  // ── Пароль ────────────────────────────────────────────────────────────
  var passwordForm = $('passwordForm');
  if (passwordForm) {
    passwordForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var fields = [$('oldPassword'), $('newPassword'), $('confirmPassword')];
      var v = fields.map(function (f) { return f.value; });
      if (!v[0] || !v[1] || !v[2]) return toast(t('app.passwordFields'), 'error');
      if (v[1] !== v[2]) return toast(t('app.passwordMismatch'), 'error');
      send('/update-password', json({ oldPassword: v[0], newPassword: v[1] }))
        .then(function () {
          fields.forEach(function (f) { f.value = ''; });
          toast(t('app.passwordSaved'), 'ok');
        })
        .catch(function (err) { toast(t('app.errorPrefix', { message: err.message }), 'error'); });
    });
  }

  // ── Подтверждение почты: письмо ещё раз ──
  var verifyBtn = $('verifyBtn');
  if (verifyBtn) verifyBtn.addEventListener('click', function () {
    verifyBtn.disabled = true;
    send('/settings/email/verify', { method: 'POST' })
      .then(function (data) { toast(data.message, 'ok'); })
      .catch(function (err) { toast(t('app.errorPrefix', { message: err.message }), 'error'); })
      .then(function () { setTimeout(function () { verifyBtn.disabled = false; }, 60000); });
  });

  // ── Уведомления: тумблеры пишут в браузер (tk-notify.js) ──
  // Разрешение на системные уведомления просим только по нажатию на тумблер:
  // без жеста браузер запрос блокирует. Отказ с сайта не отменить —
  // подсказываем, где это в настройках браузера.
  var notifyState = $('notifyState');
  if (notifyState && window.TKNotify) {
    var N = window.TKNotify;
    var notifyHow = $('notifyHow');
    var sysBlocked = function () {
      var key = !N.supported() ? 'settings.notifyNone'
        : Notification.permission === 'denied' ? 'settings.notifyDenied' : '';
      notifyState.hidden = !key;
      if (key) tkText(notifyState, key);
      // «Как разрешить» — только у запрета: браузеру, который уведомлений
      // не умеет вовсе, разрешать нечего.
      if (notifyHow) notifyHow.hidden = key !== 'settings.notifyDenied';
      return !!key;
    };
    var saved = N.prefs();
    document.querySelectorAll('[data-notify]').forEach(function (box) {
      var name = box.getAttribute('data-notify');
      box.checked = name === 'sys'
        ? !!saved.sys && N.supported() && Notification.permission === 'granted'
        : !!saved[name];
      box.addEventListener('change', function () {
        if (name !== 'sys') {
          N.setPref(name, box.checked);
          if (box.checked) N.preview(name); // сразу слышно, что включили
          return;
        }
        if (!box.checked) return N.setPref('sys', false);
        if (sysBlocked()) { box.checked = false; return; }
        Promise.resolve(Notification.permission === 'granted' ? 'granted' : Notification.requestPermission())
          .then(function (res) {
            box.checked = res === 'granted';
            N.setPref('sys', box.checked);
            sysBlocked();
          });
      });
    });
    sysBlocked();
  }

  // ── Пуши: уведомления с закрытой вкладкой (tk-push.js) ────────────────
  // Три тумблера разного свойства. «Присылать» — это подписка устройства
  // у пуш-сервиса и разрешение браузера, поэтому спрашивается по нажатию.
  // «Показывать текст» и «об эфирах» — выбор, который хранит сервер рядом
  // с подпиской: уведомление собирает он, и знать об этом должен он.
  var pushPanel = $('pushPanel');
  if (pushPanel && window.TKPush) {
    var P = window.TKPush;
    var pushState = $('pushState');
    var pushBoxes = {};
    document.querySelectorAll('[data-push]').forEach(function (box) { pushBoxes[box.getAttribute('data-push')] = box; });

    var pushHow = $('pushHow');
    var pushSay = function (key) {
      pushState.hidden = !key;
      if (key) tkText(pushState, key);
      if (pushHow) pushHow.hidden = key !== 'settings.pushDenied';
    };
    // Пока не подписано, выбор показа текста и эфиров ни на что не влияет.
    var pushLock = function (on) {
      ['preview', 'live'].forEach(function (name) { pushBoxes[name].disabled = !on; });
      $('pushTest').disabled = !on;
    };

    // Что выбрано на этом устройстве, знает сервер: страница не помнит ничего,
    // подписка живёт дольше вкладки. Поэтому после подписки тумблеры тоже
    // расставляет он — иначе «об эфирах» осталось бы снятым, хотя по умолчанию
    // мы про эфиры шлём.
    var pushPrefs = function (endpoint) {
      return send('/api/push/state?endpoint=' + encodeURIComponent(endpoint))
        .then(function (d) { pushBoxes.preview.checked = !!d.preview; pushBoxes.live.checked = !!d.live; })
        .catch(function () {});
    };

    P.state().then(function (st) {
      pushBoxes.on.checked = st.on;
      pushLock(st.on);
      pushSay(!st.supported ? 'settings.pushNone' : st.permission === 'denied' ? 'settings.pushDenied' : '');
      if (st.on) pushPrefs(st.endpoint);
    });

    pushBoxes.on.addEventListener('change', function () {
      var on = pushBoxes.on.checked;
      pushLock(false);
      (on ? P.enable() : P.disable())
        .then(function (sub) {
          pushLock(on);
          pushSay('');
          if (on && sub) return pushPrefs(sub.endpoint);
        })
        .catch(function (e) {
          pushBoxes.on.checked = false;
          pushLock(false);
          pushSay(e.message === 'denied' ? 'settings.pushDenied' : 'settings.pushNone');
        });
    });

    ['preview', 'live'].forEach(function (name) {
      pushBoxes[name].addEventListener('change', function () {
        var patch = {};
        patch[name] = pushBoxes[name].checked;
        P.prefs(patch).catch(function (e) {
          pushBoxes[name].checked = !pushBoxes[name].checked;
          toast(t('settings.pushFail', { message: e.message }), 'error');
        });
      });
    });

    $('pushTest').addEventListener('click', function () {
      P.test()
        .then(function () { toast(t('settings.pushSent'), 'ok'); })
        .catch(function (e) { toast(t('settings.pushFail', { message: e.message }), 'error'); });
    });
  }

  // ── Камера и микрофон: что разрешил браузер, и проверка ──
  // Сайт не выдаёт себе доступ сам — его даёт браузер по жесту и запоминает
  // ответ. «Проверить» и есть такой жест: разрешили один раз — звонки
  // и эфиры дальше идут без вопроса.
  var devBtn = $('devBtn');
  if (devBtn) {
    var PERM = { granted: ['settings.permGranted', 'is-ok'], prompt: ['settings.permPrompt', ''], denied: ['settings.permDenied', 'is-bad'] };
    var devState = $('devState');
    var showPerm = function (el, state) {
      var p = PERM[state] || ['settings.permUnknown', ''];
      tkText(el, p[0]);
      el.className = p[1];
    };
    // Permissions API знает не каждый браузер (Firefox — не про камеру):
    // тогда «не известно», и ответ покажет проверка.
    var readPerms = function () {
      [['camera', $('permCamera')], ['microphone', $('permMic')]].forEach(function (x) {
        if (!navigator.permissions) return showPerm(x[1], '');
        navigator.permissions.query({ name: x[0] }).then(function (st) {
          showPerm(x[1], st.state);
          st.onchange = function () { showPerm(x[1], st.state); };
        }, function () { showPerm(x[1], ''); });
      });
    };
    readPerms();

    var devStream = null, devCtx = null, devRaf = 0;
    var stopCheck = function () {
      cancelAnimationFrame(devRaf);
      if (devStream) devStream.getTracks().forEach(function (tr) { tr.stop(); });
      if (devCtx) devCtx.close().catch(function () {});
      devStream = devCtx = null;
      $('devVideo').srcObject = null;
      $('devCheck').hidden = true;
      tkText(devBtn, 'settings.devicesCheck');
    };
    // Уровень микрофона — громкость по временной форме сигнала.
    var meter = function (stream) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !stream.getAudioTracks().length) return;
      devCtx = new AC();
      var an = devCtx.createAnalyser();
      an.fftSize = 512;
      devCtx.createMediaStreamSource(stream).connect(an);
      var buf = new Uint8Array(an.fftSize);
      var bar = $('devLevel');
      (function tick() {
        an.getByteTimeDomainData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
        bar.style.width = Math.min(100, Math.round(Math.sqrt(sum / buf.length) * 400)) + '%';
        devRaf = requestAnimationFrame(tick);
      })();
    };
    devBtn.addEventListener('click', function () {
      if (devStream) return stopCheck();
      devState.hidden = true;
      devBtn.disabled = true;
      navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        .then(function (stream) {
          devStream = stream;
          $('devVideo').srcObject = stream;
          $('devCheck').hidden = false;
          meter(stream);
          tkText(devBtn, 'settings.devicesStop');
        })
        .catch(function (e) {
          devState.hidden = false;
          if (e && e.name === 'NotAllowedError') tkText(devState, 'settings.devicesDenied');
          else devState.textContent = t('settings.devicesFail', { message: (e && (e.message || e.name)) || '' });
        })
        .then(function () {
          devBtn.disabled = false;
          readPerms(); // Safari не шлёт onchange — перечитываем
        });
    });
    window.addEventListener('pagehide', stopCheck);
  }
})();

// Кому закрыт канал: «Вернуть доступ» убирает строку (routes/streaming/subscriptions.js).
(function () {
  var panel = document.getElementById('restrictedPanel');
  if (!panel) return;
  panel.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-unrestrict]');
    if (!btn) return;
    var row = btn.closest('[data-restricted]');
    btn.disabled = true;
    fetch('/restrict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: row.getAttribute('data-restricted'), on: false })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.message || 'HTTP ' + r.status);
        row.remove();
        if (!panel.querySelector('[data-restricted]')) panel.remove();
      });
    }).catch(function (err) {
      btn.disabled = false;
      toast(err.message, 'error');
    });
  });
})();
