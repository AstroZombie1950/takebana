// Поведение, которое есть только на главной: счётчики, форма подписки
// и ссылки-заглушки. Язык и бургер живут в tk.js — они нужны всем страницам.
(function () {
  "use strict";

  /* ---------- счётчики в блоке социального доказательства ---------- */
  function initStats() {
    var el = document.getElementById("tkStats");
    var streamsEl = document.getElementById("tkStatStreams");
    var venuesEl = document.getElementById("tkStatVenues");
    if (!el || !streamsEl || !venuesEl) return;

    var started = false;

    function runCount() {
      var dur = 1400, t0 = performance.now();
      function step(now) {
        var p = Math.min(1, Math.max(0, (now - t0) / dur));
        var e = 1 - Math.pow(1 - p, 3);
        streamsEl.textContent = Math.round(500 * e) + "+";
        venuesEl.textContent = Math.round(100 * e) + "+";
        if (p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }

    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting && !started) {
            started = true;
            runCount();
            io.disconnect();
          }
        }
      }, { threshold: 0.4 });
      io.observe(el);
    } else {
      runCount();
    }
  }

  /* ---------- форма подписки ---------- */
  function initSubscribe() {
    var input = document.getElementById("tkEmailInput");
    var btn = document.getElementById("tkEmailSubmit");
    var errorBox = document.getElementById("tkEmailError");
    var sentBox = document.getElementById("tkEmailSent");
    if (!input || !btn) return;

    function valid(v) {
      return /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v);
    }

    function setState(state) {
      var bad = state === "error";
      var sent = state === "sent";
      input.style.border = "1px solid " + (bad ? "#E34234" : "rgba(144,113,99,.7)");
      input.style.borderRight = "none";
      if (errorBox) errorBox.style.display = bad ? "flex" : "none";
      if (sentBox) sentBox.style.display = sent ? "flex" : "none";
    }

    input.addEventListener("input", function () { setState("idle"); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });
    btn.addEventListener("click", submit);

    function submit() {
      var v = input.value.trim();
      setState(valid(v) ? "sent" : "error");
    }
  }

  /* ---------- ссылки без адреса ----------
   * «Я ведущий», «Блог» и соцсети: страниц под них пока нет. Кнопки заданы
   * по ТЗ, поэтому не убираем и не прячем — только гасим прыжок наверх. */
  function initPlaceholderLinks() {
    var links = document.querySelectorAll('a[href="#"]');
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener("click", function (e) { e.preventDefault(); });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    initStats();
    initSubscribe();
    initPlaceholderLinks();
  });
})();
