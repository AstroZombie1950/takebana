// Связь с сервером — общий слой уведомлений (docs/NOTICES.md).
//
// Человек не должен оставаться наедине с кружком: до 02.10 обрыв сокета сайт
// не показывал вовсе, а у запросов не было тайм-аута — запрос в никуда висел
// минутами, и кнопка просто не отвечала.
//
//   tkFetch(url, opts)          — как fetch, плюс:
//     opts.timeout              — мс; по умолчанию 30 с, с файлом в теле — 2 мин, 0 — без
//     opts.button               — кнопка действия; без него — та, что нажата только что
//     Сбой сети — Error с .reason (offline | no_server | timeout) и текстом
//     для человека в .message. Отказ от самой страницы (opts.signal) — AbortError, как был.
//   TKNet.json(url, opts)       — tkFetch + разбор JSON; объект в opts.body уходит JSON.
//     Не 2xx — Error: .message — текст сервера или причины, .status, .reason, .data
//   TKNet.reason(ошибка | ответ) — offline | no_server | timeout | server | busy | too_big | denied | ''
//   TKNet.explain(ответ)        — текст по коду ответа, когда сервер своего не прислал
//   TKNet.say(ошибка | ответ [, запасной текст]) — показать это человеку
//   TKNet.socket(true | false, причина, транспорт) — tk-app.js: сокет подключился / отвалился
//
// Кнопка, нажатая перед запросом, через секунду без ответа показывает
// «Отправляем…» и не нажимается второй раз; через пять секунд — «медленное
// соединение». Каждый сбой и показанная полоса — в телеметрию (kind
// 'notice', одна запись на страницу), чтобы видеть, кто и где застрял.
(function () {
  'use strict';

  // Внешние вызовы сервера (Daily, Bunny) сами ограничены 10–20 с — запрос
  // к нам законно длится до них. Человек всё это время не в тишине:
  // «Отправляем…» через секунду, «медленное соединение» через пять.
  var TIMEOUT = 30000;
  var FILE_TIMEOUT = 120000;
  var BUSY_MS = 1000;
  var SLOW_MS = 5000;
  // Сокет молчит дольше SOCKET_GRACE — спрашиваем сервер обычным запросом.
  // Не ответил — «нет связи с сервером». Ответил — рвётся только живое
  // соединение (так было у заказчика через VPN 02.10: сотни сокетов по
  // несколько секунд, а эфиры и страницы шли), и пугать «нет связи» — неправда:
  // первые SOFT_MS молчим, дальше — мягкое «переподключаемся».
  var SOCKET_GRACE = 10000;
  var SOFT_MS = 30000;
  var PROBE_MS = 10000;     // пока связи нет — проверяем снова; гость без сокета — так же
  var PRESS_MS = 1000;      // запрос через столько после нажатия — от этой кнопки

  var KEYS = {
    offline: 'notice.offline', no_server: 'notice.noServer', slow: 'notice.slow',
    timeout: 'notice.timeout', server: 'notice.server', busy: 'notice.busy',
    too_big: 'notice.tooBig', denied: 'notice.denied', reconnecting: 'notice.reconnecting',
  };
  function text(reason) { return window.t(KEYS[reason] || KEYS.server); }

  // ── Телеметрия ──
  // Одна запись на страницу, заводится при первом сбое: у кого всё хорошо,
  // от того не уходит ничего.
  var trace = null;
  function note(reason, url) {
    if (!window.TKTrace) return;
    if (!trace) trace = window.TKTrace.start('notice', location.pathname);
    if (!reason) return trace; // только числа: длительность обрыва, причина
    trace.mark(reason);
    trace.set(reason, (trace.stats[reason] || 0) + 1);
    if (url) trace.set('url', String(url).split('?')[0]);
    trace.end('fail', reason);
  }

  // ── Полоса ──
  var bar = null;
  var shown = '';
  var hasSocket = false;
  var socketOk = true;      // последнее, что сообщил tk-app.js
  var downSince = 0;
  var socketDown = '';      // '' | 'no_server' | 'reconnecting' — что показываем про сокет
  var socketTimer = 0;
  var requestDown = false;  // запрос не дошёл, а сокета нет — до первого ответа
  var probeTimer = 0;
  var leaving = false;
  var lastWhy = '';

  function paint() {
    var reason = navigator.onLine === false ? 'offline'
      : socketDown || (requestDown && !hasSocket ? 'no_server' : '');
    if (reason === shown) return;
    shown = reason;
    if (!bar) {
      if (!reason) return;
      bar = document.createElement('div');
      bar.className = 'tk-netbar';
      bar.setAttribute('role', 'status');
      document.body.appendChild(bar);
    }
    bar.hidden = !reason;
    if (!reason) return;
    bar.classList.toggle('tk-netbar--soft', reason === 'reconnecting');
    window.tkText(bar, KEYS[reason]);
    note(reason);
    if (lastWhy && trace) trace.set('why', lastWhy);
  }

  // Отвечает ли сервер обычным запросом — за 5 с.
  function healthy() {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, 5000);
    return fetch('/healthz', { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) { clearTimeout(t); return r.ok; }, function () { clearTimeout(t); return false; });
  }

  // Гость без сокета: связь вернулась — узнаём сами, иначе полоса висела бы
  // до следующего его действия.
  function probe() {
    clearTimeout(probeTimer);
    if (!requestDown || hasSocket) return;
    probeTimer = setTimeout(function () {
      healthy().then(function (ok) {
        if (!ok) return probe();
        requestDown = false;
        paint();
      });
    }, PROBE_MS);
  }

  // Сокет молчит: проверка раз в PROBE_MS, пока страница на экране.
  // В фоне — ничего: человек не смотрит, а вернувшись, получит отсчёт заново
  // (tk-app.js в этот момент сам переподключается).
  function arm(ms) {
    clearTimeout(socketTimer);
    socketTimer = setTimeout(check, ms);
  }
  function check() {
    socketTimer = 0;
    if (socketOk || leaving || document.visibilityState === 'hidden') return;
    healthy().then(function (ok) {
      if (socketOk || leaving) return;
      if (!ok) socketDown = 'no_server';
      else if (Date.now() - downSince >= SOFT_MS) socketDown = 'reconnecting';
      else socketDown = '';
      if (ok && trace) trace.set('httpOk', true);
      paint();
      arm(PROBE_MS);
    });
  }

  function socketState(ok, why, transport) {
    hasSocket = true;
    if (ok) {
      // Обрыв был виден человеку — сколько длился: по этому числу видно,
      // мешает ли сеть или полоса мелькнула на секунду.
      if (!socketOk && shown) {
        var t = note('');
        if (t) { t.set('downMs', Date.now() - downSince); if (transport) t.set('transport', transport); }
      }
      socketOk = true;
      downSince = 0;
      clearTimeout(socketTimer);
      socketTimer = 0;
      socketDown = '';
      requestDown = false;
      return paint();
    }
    if (why) lastWhy = String(why).slice(0, 40);
    // connect_error приходит на каждой попытке — отсчёт от первой.
    if (!socketOk || leaving) return;
    socketOk = false;
    downSince = Date.now();
    arm(SOCKET_GRACE);
  }

  window.addEventListener('online', function () { paint(); if (requestDown) probe(); });
  window.addEventListener('offline', paint);
  // Переход по ссылке рвёт сокет — это не обрыв.
  window.addEventListener('pagehide', function () { leaving = true; });
  window.addEventListener('pageshow', function (e) { if (e.persisted) leaving = false; });
  // Вернулась из фона: что было до заморозки — уже неправда. Полосу
  // убираем, отсчёт — заново, пока tk-app.js переподключается.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || socketOk) return;
    downSince = Date.now();
    socketDown = '';
    paint();
    arm(SOCKET_GRACE);
  });

  // ── Кнопка, от которой запрос ──
  // Помним последнее нажатие: обработчик страницы зовёт tkFetch сразу после
  // него, и так «Отправляем…» получают все кнопки сайта без правки каждой.
  var press = null;
  function remember(el) { if (el) press = { el: el, at: Date.now() }; }
  document.addEventListener('click', function (e) {
    remember(e.target.closest && e.target.closest('button, [role="button"], input[type="submit"]'));
  }, true);
  document.addEventListener('submit', function (e) {
    remember(e.submitter || e.target.querySelector('[type="submit"]'));
  }, true);

  // Ширина — прежняя, чтобы ряд кнопок не прыгал. Текст меняем только у
  // кнопки с одним текстом и местом под него; у значка — только вид.
  function busy(el) {
    var n = (Number(el.dataset.tkBusy) || 0) + 1;
    el.dataset.tkBusy = String(n);
    if (n === 1) {
      var was = { disabled: el.disabled, minWidth: el.style.minWidth, label: null };
      var sending = window.t('notice.sending');
      el.style.minWidth = el.offsetWidth + 'px';
      if (!el.children.length && el.offsetWidth >= 110 && el.textContent.trim()) {
        was.label = el.textContent;
        el.textContent = sending;
      }
      el.disabled = true;
      el.setAttribute('aria-busy', 'true');
      el.classList.add('tk-busy');
      el._tkBusy = function () {
        // Страница успела сама переписать кнопку — её текст не трогаем.
        if (was.label != null && el.textContent === sending) el.textContent = was.label;
        el.disabled = was.disabled;
        el.style.minWidth = was.minWidth;
        el.removeAttribute('aria-busy');
        el.classList.remove('tk-busy');
      };
    }
    return function () {
      var left = (Number(el.dataset.tkBusy) || 1) - 1;
      if (left > 0) { el.dataset.tkBusy = String(left); return; }
      delete el.dataset.tkBusy;
      if (el._tkBusy) { el._tkBusy(); el._tkBusy = null; }
    };
  }

  // ── Запрос ──
  function isFile(body) {
    return (typeof FormData !== 'undefined' && body instanceof FormData) || (typeof Blob !== 'undefined' && body instanceof Blob);
  }

  // Файл в запросе — попытка загрузки (docs/TELEMETRY.md, kind upload):
  // аватар, обложки, фото заведения и группы идут здесь все, поэтому и
  // телеметрия одна на всех. Видео галереи — кусками (tk-upload.js), там своя.
  function fileTrace(url, body) {
    if (!window.TKTrace || !isFile(body)) return null;
    var files = [];
    if (body instanceof FormData) body.forEach(function (v) { if (v instanceof Blob) files.push(v); });
    else files.push(body);
    if (!files.length) return null;
    var bytes = files.reduce(function (a, f) { return a + f.size; }, 0);
    var type = files[0].type || '';
    var tr = TKTrace.start('upload', String(url).split('?')[0]);
    tr.set('what', /^video\//.test(type) ? 'video' : /^image\//.test(type) ? 'photo' : 'file');
    tr.set('files', files.length);
    tr.set('kb', Math.round(bytes / 1024));
    tr.set('type', type);
    tr.bytes = bytes;
    return tr;
  }
  function fileDone(tr, outcome, reason) {
    if (!tr) return;
    var ms = tr.at();
    tr.set('ms', ms);
    // Вместе с обработкой на сервере — медленнее чистой скорости сети.
    tr.set('kbps', Math.round((tr.bytes * 8) / Math.max(1, ms)));
    tr.end(outcome, reason);
  }

  function tkFetch(url, opts) {
    opts = Object.assign({}, opts);
    var tr = fileTrace(url, opts.body);
    var limit = opts.timeout != null ? opts.timeout : isFile(opts.body) ? FILE_TIMEOUT : TIMEOUT;
    var method = String(opts.method || 'GET').toUpperCase();
    var btn = opts.button !== undefined ? opts.button
      : method !== 'GET' && press && Date.now() - press.at < PRESS_MS && press.el.isConnected ? press.el : null;
    delete opts.timeout;
    delete opts.button;

    var ctrl = new AbortController();
    var outer = opts.signal;
    if (outer) {
      if (outer.aborted) ctrl.abort();
      else outer.addEventListener('abort', function () { ctrl.abort(); });
    }
    opts.signal = ctrl.signal;

    var timedOut = false;
    var release = null;
    var timers = [];
    if (limit) timers.push(setTimeout(function () { timedOut = true; ctrl.abort(); }, limit));
    if (btn) {
      timers.push(setTimeout(function () { release = busy(btn); }, BUSY_MS));
      timers.push(setTimeout(function () { window.toast(text('slow')); note('slow', url); }, SLOW_MS));
    }
    function settle() {
      timers.forEach(clearTimeout);
      if (release) release();
    }

    return fetch(url, opts).then(function (r) {
      settle();
      if (requestDown) { requestDown = false; paint(); }
      if (r.status >= 500 || r.status === 429) note(reasonOf(r), url);
      if (tr) fileDone(tr, r.ok ? 'ok' : 'fail', r.ok ? '' : reasonOf(r) || 'http_' + r.status);
      return r;
    }, function (e) {
      settle();
      if (outer && outer.aborted) { if (tr) tr.drop(); throw e; } // отменила сама страница — не сбой
      var reason = timedOut ? 'timeout' : navigator.onLine === false ? 'offline' : 'no_server';
      fileDone(tr, 'fail', reason);
      if (reason !== 'no_server') note(reason, url);
      // «Сервер не отвечает» — только если он и правда не отвечает. Сорванный
      // запрос без ответа бывает и при живом сервере: iOS рвёт запросы
      // уходящей страницы и приложения, вернувшегося из фона, — до 06.10
      // это была почти вся запись «сбой связи» в журнале (присутствие,
      // счётчики шапки, подписка пушей с телефона с иконки). Ушли со
      // страницы или она в фоне — тоже не пишем.
      else if (!leaving && document.visibilityState !== 'hidden') {
        healthy().then(function (ok) { if (!ok && !leaving) note(reason, url); });
      }
      if (reason === 'no_server' && !hasSocket) { requestDown = true; paint(); probe(); }
      var err = new Error(text(reason));
      err.reason = reason;
      throw err;
    });
  }

  function reasonOf(x) {
    if (!x) return '';
    var s = x.status;
    if (s >= 500) return 'server';
    if (s === 429) return 'busy';
    if (s === 413) return 'too_big';
    if (s === 401 || s === 403) return 'denied';
    return x.reason || '';
  }

  function json(url, opts) {
    opts = Object.assign({}, opts);
    opts.headers = Object.assign({ Accept: 'application/json' }, opts.headers);
    var body = opts.body;
    if (body && typeof body === 'object' && !isFile(body) && !(body instanceof URLSearchParams)) {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }
    return tkFetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.ok) return d;
        var reason = reasonOf(r);
        // У 5xx общий обработчик (middleware/errors.js) отдаёт безликое
        // «Ошибка сервера» с отпечатком — своё объяснение лучше. Текст,
        // который маршрут написал сам («сервис видео не запустил эфир»), — его.
        var own = d.message && !(reason === 'server' && d.code);
        var e = new Error(own ? d.message : explain(r));
        e.status = r.status;
        e.reason = reason;
        e.data = d;
        throw e;
      });
    });
  }

  function explain(r) {
    var reason = reasonOf(r);
    return reason ? text(reason) : window.t('common.failedCode', { code: r.status });
  }

  // Причина — своим текстом; иначе текст ошибки или запасной.
  function say(x, fallback) {
    var reason = reasonOf(x);
    var msg = x && x.message && (x.reason || x.status) ? x.message : reason ? text(reason) : (x && x.message) || fallback || text('server');
    window.toast(msg, 'error');
  }

  window.tkFetch = tkFetch;
  // Фото до отправки — те же правила, что у сервера (routes/streaming/
  // uploads.js, establishmentsRouter.js): JPEG, PNG или WebP и предел в МБ.
  // Пусто — годится, иначе текст для человека. Без этого отказ приходил
  // только после отправки — у заведения вместе со всей формой.
  function image(file, mb) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return window.t('upload.photoType', { name: file.name });
    if (file.size > mb * 1048576) return window.t('user.photoHeavy', { name: file.name, mb: mb });
    return '';
  }

  window.TKNet = { json: json, reason: reasonOf, explain: explain, say: say, socket: socketState, image: image };
})();
