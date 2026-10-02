// Телеметрия в браузере: одна попытка — одна запись (docs/TELEMETRY.md).
//
//   var tr = TKTrace.start('live.view', streamKey);
//   tr.step('manifest');            — этап, время от начала; повтор не пишется
//   tr.mark('stall');               — событие, может повторяться (до 40 всего)
//   tr.set('stalls', 3);            — числа направления
//   tr.route = 'fallback';
//   tr.end('fail', 'cdn_timeout');  — исход; ok/fail/gave_up/partial
//   tr.onLeave = function () { … }; — последний шанс выставить исход
//
// Итог уходит sendBeacon: при исходе, когда страницу прячут (на айфоне это
// последнее надёжное событие) и раз в минуту, если что-то поменялось, —
// iPhone часто закрывает страницу молча. Сервер — routes/telemetry.js.
(function () {
  var URL_ = '/api/t';
  var EVERY_MS = 60000;
  var MAX_STEPS = 40;

  function id() {
    var a = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function tz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  }

  var standalone = !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));

  function Trace(kind, target) {
    this.tid = id();
    this.kind = kind;
    this.target = String(target || '');
    this.t0 = Date.now();
    this.steps = [];
    this.stats = {};
    this.route = '';
    this.outcome = 'open';
    this.reason = '';
    this.onLeave = null;
    this.sentAt = 0;
    this.dirty = true;
    var self = this;
    this.timer = setInterval(function () { if (self.dirty) self.send(); }, EVERY_MS);
    function leave() {
      if (self.onLeave) self.onLeave();
      self.send();
    }
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') leave(); });
    window.addEventListener('pagehide', leave);
  }

  Trace.prototype.at = function () { return Date.now() - this.t0; };

  Trace.prototype.step = function (name) {
    for (var i = 0; i < this.steps.length; i++) if (this.steps[i].s === name) return;
    this.mark(name);
  };

  Trace.prototype.mark = function (name) {
    if (this.steps.length >= MAX_STEPS) return;
    this.steps.push({ s: name, ms: this.at() });
    this.dirty = true;
  };

  Trace.prototype.set = function (key, value) {
    if (this.stats[key] === value) return;
    this.stats[key] = value;
    this.dirty = true;
  };

  Trace.prototype.end = function (outcome, reason) {
    this.outcome = outcome;
    this.reason = reason || '';
    this.dirty = true;
    this.send();
  };

  Trace.prototype.send = function () {
    var c = navigator.connection || {};
    var body = JSON.stringify({
      tid: this.tid, kind: this.kind, target: this.target, ago: this.at(),
      tz: tz(), conn: c.effectiveType || '', down: c.downlink || 0, standalone: standalone,
      route: this.route, steps: this.steps, outcome: this.outcome, reason: this.reason, stats: this.stats,
    });
    this.dirty = false;
    this.sentAt = Date.now();
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(URL_, body)) return;
    } catch (e) { /* очередь маяков переполнена — ниже обычным запросом */ }
    fetch(URL_, { method: 'POST', body: body, keepalive: true }).catch(function () {});
  };

  window.TKTrace = {
    start: function (kind, target) { return new Trace(kind, target); },
  };
})();
