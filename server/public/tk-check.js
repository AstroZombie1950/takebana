/* Проверка связи — страница /check (views/check.ejs, utils/netCheck.js).
 *
 * Каждый путь — отдельно и по очереди, чтобы замеры не мешали друг другу:
 *   сайт, эфиры, записи — один и тот же файл в 96 КБ, дочитываем до конца
 *     и считаем байты: обрыв после первых килобайт — это «режут», а не
 *     «открылось»;
 *   Daily — открывается ли его домен вообще (ответ чужого сайта страница
 *     прочитать не может, но видит, пришёл он или нет);
 *   наш TURN — по UDP, TCP и TLS по отдельности: соединение через сервер
 *     считается рабочим, когда браузер получил от него адрес (relay).
 * Итог уходит в журнал панели тем же маршрутом, что ошибки страниц.
 */
(function () {
  var data = JSON.parse(document.getElementById('netData').textContent);
  var list = document.getElementById('netList');
  var again = document.getElementById('netAgain');
  var sent = document.getElementById('netSent');
  var ownNote = document.getElementById('netOwn');
  var TIMEOUT = 10000;

  // Подписи для журнала панели — она русская, язык страницы тут ни при чём.
  var LABELS = { site: 'сайт', live: 'эфиры', vod: 'записи', daily: 'Daily', udp: 'TURN UDP', tcp: 'TURN TCP', tls: 'TURN TLS' };

  function row(name) { return list.querySelector('[data-check="' + name + '"]'); }
  function show(name, key, vars, state) {
    var el = row(name);
    el.dataset.state = state || '';
    tkText(el.querySelector('.tk-net__state'), key, vars);
  }

  function download(url) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT);
    var t0 = performance.now();
    var got = 0;
    // Метка в адресе — мимо кэша браузера: иначе второй прогон ничего не мерит.
    return fetch(url + '?r=' + Date.now(), { cache: 'no-store', signal: ctrl.signal })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var reader = res.body.getReader();
        return (function pump() {
          return reader.read().then(function (c) {
            if (c.done) return;
            got += c.value.length;
            return pump();
          });
        })();
      })
      .then(function () { return null; }, function (e) { return e.name === 'AbortError' ? 'timeout' : (e.message || e.name); })
      .then(function (error) {
        clearTimeout(timer);
        var r = { ms: Math.round(performance.now() - t0), bytes: got };
        if (error) r.error = error;
        else if (got < data.size) r.error = 'short';
        return r;
      });
  }

  function reach(url) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT);
    var t0 = performance.now();
    return fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
      .then(function () { return null; }, function (e) { return e.name === 'AbortError' ? 'timeout' : (e.message || e.name); })
      .then(function (error) {
        clearTimeout(timer);
        var r = { ms: Math.round(performance.now() - t0) };
        if (error) r.error = error;
        return r;
      });
  }

  function relay(url) {
    return new Promise(function (resolve) {
      var t0 = performance.now();
      var errors = [];
      var done = false;
      var pc = new RTCPeerConnection({
        iceServers: [{ urls: url, username: data.ice.username, credential: data.ice.credential }],
        iceTransportPolicy: 'relay',
      });
      function finish(error) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pc.close();
        var r = { ms: Math.round(performance.now() - t0) };
        if (error) r.error = error + (errors.length ? ' (' + errors.join('; ') + ')' : '');
        resolve(r);
      }
      var timer = setTimeout(function () { finish('timeout'); }, TIMEOUT);
      pc.onicecandidate = function (e) {
        if (!e.candidate) finish('нет адреса');
        else if (/ typ relay /.test(e.candidate.candidate)) finish(null);
      };
      pc.onicecandidateerror = function (e) { errors.push(e.errorCode + ' ' + (e.errorText || '')); };
      pc.createDataChannel('check');
      pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function (e) { finish(e.message || e.name); });
    });
  }

  // Порядок строк — порядок проверок. Чего в этой сборке нет (CDN не
  // настроен, гость без ключей TURN), того и строки нет.
  var urls = data.ice ? data.ice.urls : [];
  var pick = function (re) { return urls.filter(function (u) { return re.test(u); })[0] || ''; };
  var checks = [
    { name: 'site', run: download, url: data.site },
    { name: 'live', run: download, url: data.live },
    { name: 'vod', run: download, url: data.vod },
    { name: 'daily', run: reach, url: data.daily },
    { name: 'udp', run: relay, url: pick(/^turn:.*udp/) },
    { name: 'tcp', run: relay, url: pick(/^turn:.*tcp/) },
    { name: 'tls', run: relay, url: pick(/^turns:/) },
  ].filter(function (c) {
    if (!c.url) row(c.name).remove();
    return !!c.url;
  });

  function paint(c, r) {
    if (!r.error) return show(c.name, 'check.ok', { ms: r.ms }, 'ok');
    if (r.bytes) return show(c.name, 'check.cut', { kb: Math.round(r.bytes / 1024) }, 'bad');
    show(c.name, 'check.fail', null, 'bad');
  }

  function report(results) {
    var line = results.map(function (x) {
      return LABELS[x.name] + ' ' + (x.r.error ? '✗' : '✓');
    }).join(', ');
    var conn = navigator.connection || {};
    var details = results.map(function (x) {
      return LABELS[x.name] + ': ' + (x.r.error ? 'нет — ' + x.r.error : 'да') + ', ' + x.r.ms + ' мс' +
        (x.r.bytes !== undefined ? ', ' + x.r.bytes + ' из ' + data.size + ' байт' : '');
    }).concat([
      'сеть: ' + (conn.type || '?') + ' / ' + (conn.effectiveType || '?'),
      'часовой пояс: ' + (Intl.DateTimeFormat().resolvedOptions().timeZone || '?'),
      'язык: ' + navigator.language,
      'браузер: ' + navigator.userAgent,
    ]);
    return fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NetCheck', page: '/check', message: 'Проверка связи: ' + line, details: details }),
      keepalive: true,
    }).catch(function () {});
  }

  // Провайдер режет CDN — включаем запасной путь, не дожидаясь жалобы.
  //
  // Признак: наш сайт открылся, а CDN эфиров или записей — нет. Если не
  // открылся и сайт, то сеть просто лежит, и через нас будет не лучше:
  // подменять адреса в такой момент значило бы запомнить на месяц
  // случайный обрыв.
  //
  // Дальше всё делает сервер (utils/mediaFallback.js): он видит cookie
  // и отдаёт страницы с нашими адресами. Эта страница — исключение, она
  // обязана и впредь проверять настоящий CDN.
  function switchToOwn(results) {
    var by = {};
    results.forEach(function (x) { by[x.name] = !x.r.error; });
    if (!by.site || (by.live !== false && by.vod !== false)) return false;
    // Второй прогон подряд ничего не меняет, но сказать всё равно нужно:
    // человек должен понимать, почему медиа теперь идёт другой дорогой.
    if (window.TKMedia) TKMedia.remember();
    return true;
  }

  function run() {
    again.disabled = true;
    sent.hidden = true;
    checks.forEach(function (c) { show(c.name, 'check.wait'); });
    var results = [];
    checks.reduce(function (chain, c) {
      return chain.then(function () {
        show(c.name, 'check.running');
        return c.run(c.url).then(function (r) {
          paint(c, r);
          results.push({ name: c.name, r: r });
        });
      });
    }, Promise.resolve()).then(function () {
      return report(results);
    }).then(function () {
      sent.hidden = false;
      ownNote.hidden = !switchToOwn(results);
      again.disabled = false;
    });
  }

  again.addEventListener('click', run);
  run();

  // ── Проверка звука ────────────────────────────────────────────────────
  // Звонок в одиночку не проверишь — нужен второй человек, поэтому проверки
  // звука до сих пор и не было, а жалоба «слышно только по громкой связи»
  // висит с сентября. Здесь телефон вводится ровно в то состояние, в каком
  // он бывает в разговоре: микрофон захвачен и не отпускается, пока играет
  // запись, и играет она через такой же <audio playsinline>, как в звонке.
  //
  // Человек отвечает одной из четырёх кнопок, ответ уходит в журнал вместе
  // с полным отчётом об устройстве — дальше его читаем мы.
  var soundStart = document.getElementById('soundStart');
  var soundState = document.getElementById('soundState');
  var soundBack = document.getElementById('soundBack');
  var answers = document.getElementById('soundAnswers');
  var REC_MS = 5000;
  var mic = null;
  var micTrack = null;

  var ANSWERS = {
    ok: 'слышно нормально',
    quiet: 'слышно тихо',
    ear: 'слышно только у уха',
    none: 'не слышно',
  };

  function stopMic() {
    if (!mic) return;
    mic.getTracks().forEach(function (t) { t.stop(); });
    mic = null;
  }

  function fail(key, e) {
    tkText(soundState, key);
    soundStart.disabled = false;
    stopMic();
    if (e) console.error('проверка звука:', e);
  }

  soundStart.addEventListener('click', function () {
    if (!window.MediaRecorder || !navigator.mediaDevices) return fail('check.sound.unsupported');
    soundStart.disabled = true;
    answers.hidden = true;
    tkText(soundState, 'check.sound.asking');

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      mic = stream;
      micTrack = stream.getAudioTracks()[0];
      var rec = new MediaRecorder(stream);
      var parts = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) parts.push(e.data); };
      rec.onstop = function () {
        // Микрофон нарочно остаётся захваченным: именно в этом состоянии
        // телефон и решает, в какой динамик вести звук в звонке.
        tkText(soundState, 'check.sound.playing');
        soundBack.src = URL.createObjectURL(new Blob(parts, { type: rec.mimeType || 'audio/webm' }));
        soundBack.play().then(function () {
          answers.hidden = false;
        }).catch(function (e) {
          answers.hidden = false;
          fail('check.sound.blocked', e);
        });
      };
      rec.start();
      tkText(soundState, 'check.sound.recording');
      setTimeout(function () { if (rec.state !== 'inactive') rec.stop(); }, REC_MS);
    }).catch(function (e) { fail('check.sound.denied', e); });
  });

  answers.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-answer]');
    if (!btn) return;
    var answer = btn.getAttribute('data-answer');
    answers.hidden = true;
    tkText(soundState, 'check.sound.sending');
    var report = window.TKAudio;
    var finish = function () {
      stopMic();
      soundStart.disabled = false;
      tkText(soundState, 'check.sound.thanks');
    };
    if (!report) return finish();
    report.outputs().then(function (list) {
      return report.send('Проверка звука: ' + (ANSWERS[answer] || answer),
        ['ответ: ' + (ANSWERS[answer] || answer)]
          .concat(report.element(soundBack, 'элемент звука'))
          .concat(report.track(micTrack, 'микрофон'))
          .concat(report.device())
          .concat(list));
    }).then(finish, finish);
  });

  // Ушли со страницы, не ответив, — микрофон отпускаем.
  window.addEventListener('pagehide', stopMic);
})();
