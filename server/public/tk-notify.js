/* Звуки и системные уведомления о сообщениях и звонках (разбор 4.5 от 17.09).
 *
 * Три настройки, по умолчанию выключены: звук сообщения, звук звонка,
 * системные уведомления. Живут в браузере (localStorage), а не в аккаунте:
 * и звук, и разрешение на уведомления — свойство устройства. Включает их
 * /settings (settings.js), события подаёт tk-app.js:
 *   TKNotify.message(d)   — пришло сообщение (d из message:new);
 *   TKNotify.ring(call)   — входящий звонок { callId, name, video };
 *   TKNotify.stopRing()   — звонок принят, отклонён или отменён.
 *
 * Звук синтезируется WebAudio — файлов нет. Вкладок открыто несколько —
 * звучит одна: видимая сразу, фоновые с задержкой занимают событие
 * в localStorage, кто первый. Системное уведомление — только когда
 * вкладка не на экране: на экране хватает счётчика и окна звонка.
 */
(function () {
  var KEY = 'tk.notify';
  var RING_EVERY_MS = 2500;

  function prefs() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) { return {}; }
  }
  function setPref(name, on) {
    var p = prefs();
    p[name] = !!on;
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (_) {}
  }

  // Событие берёт одна вкладка. Хранилище недоступно — звучит каждая.
  function claim(id) {
    var k = 'tk.claim.' + id;
    try {
      if (localStorage.getItem(k)) return false;
      localStorage.setItem(k, '1');
      setTimeout(function () { try { localStorage.removeItem(k); } catch (_) {} }, 60000);
    } catch (_) {}
    return true;
  }
  function once(id, fn) {
    var go = function () { if (claim(id)) fn(); };
    if (document.visibilityState === 'visible') go(); else setTimeout(go, 300);
  }

  // ── Звук ──
  // Браузер пускает звук только после жеста на странице: контекст будим
  // первым касанием или клавишей.
  var ctx = null;
  function audio() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});
    return ctx;
  }
  ['pointerdown', 'keydown'].forEach(function (ev) {
    document.addEventListener(ev, function wakeUp() {
      var p = prefs();
      if (p.sndMsg || p.sndCall) audio();
    }, { once: true, capture: true });
  });

  function tone(freq, at, dur, vol) {
    var c = audio();
    if (!c) return;
    var o = c.createOscillator();
    var g = c.createGain();
    var t0 = c.currentTime + at;
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
  // Сообщение — короткое «дзынь» вверх; звонок — две пары гудков.
  function ping() { tone(880, 0, 0.16, 0.22); tone(1320, 0.08, 0.24, 0.18); }
  function ringOnce() {
    [0, 0.32].forEach(function (d) { tone(659, d, 0.24, 0.26); tone(988, d, 0.24, 0.12); });
  }

  // ── Системные уведомления ──
  function supported() { return 'Notification' in window; }
  function show(title, body, tag, url, sticky) {
    if (!prefs().sys || !supported() || Notification.permission !== 'granted') return null;
    if (document.visibilityState === 'visible') return null;
    try {
      var n = new Notification(title, { body: body, tag: tag, icon: '/favicon.svg', requireInteraction: !!sticky });
      n.onclick = function () {
        window.focus();
        if (url) location.href = url;
        n.close();
      };
      return n;
    } catch (_) {
      // Chrome на Android показывает уведомления только через service worker.
      return null;
    }
  }

  function preview(m) {
    if (m.forwardedFrom) return t('notify.forwarded');
    var s = String(m.content || '').replace(/\s+/g, ' ').trim();
    // Файл без подписи — «Фото», «Голосовое» и т. п.
    if (!s && m.attachments && m.attachments[0]) s = t('chats.att.' + m.attachments[0].kind);
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
  }

  function message(d) {
    // Только входящие: своё из другой вкладки тоже приходит message:new.
    if (!d || !d.message || !d.peer || d.message.sender !== d.peer.id) return;
    var p = prefs();
    if (!p.sndMsg && !p.sys) return;
    once('m' + d.message._id, function () {
      if (p.sndMsg) ping();
      show(d.peer.displayName, preview(d.message), 'msg-' + d.peer.id, '/chatsPage?peer=' + d.peer.id);
    });
  }

  var ringTimer = null;
  var ringNote = null;
  function ring(call) {
    stopRing();
    var p = prefs();
    if (!p.sndCall && !p.sys) return;
    once('c' + call.callId, function () {
      if (p.sndCall) {
        ringOnce();
        ringTimer = setInterval(ringOnce, RING_EVERY_MS);
      }
      ringNote = show(t(call.video ? 'call.incomingVideo' : 'call.incomingAudio'), call.name, 'call', null, true);
    });
  }
  function stopRing() {
    clearInterval(ringTimer);
    ringTimer = null;
    if (ringNote) { ringNote.close(); ringNote = null; }
  }

  window.TKNotify = {
    prefs: prefs,
    setPref: setPref,
    supported: supported,
    message: message,
    ring: ring,
    stopRing: stopRing,
    // Пробный звук при включении тумблера в настройках.
    preview: function (name) { if (name === 'sndMsg') ping(); else if (name === 'sndCall') ringOnce(); },
  };
})();
