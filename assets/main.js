(function () {
  "use strict";

  /* ---------- language switch ---------- */
  var LANG_KEY = "tk_lang";
  var docEl = document.documentElement;

  function applyLang(lang) {
    var dict = TK_I18N[lang] || TK_I18N.ru;
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute("data-i18n");
      if (dict[key] !== undefined) nodes[i].innerHTML = dict[key];
    }
    docEl.setAttribute("lang", lang === "en" ? "en" : "ru");

    var ru = document.getElementById("tkLangRu");
    var en = document.getElementById("tkLangEn");
    if (ru && en) {
      var active = { background: "#F5F1EA", color: "#0A0A0A", border: "1px solid transparent" };
      var inactive = { background: "transparent", color: "#C9C2B7", border: "1px solid rgba(144,113,99,.7)" };
      var apply = function (el, s) {
        el.style.background = s.background;
        el.style.color = s.color;
        el.style.border = s.border;
      };
      apply(ru, lang === "en" ? inactive : active);
      apply(en, lang === "en" ? active : inactive);
    }

    try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
  }

  function initLang() {
    var saved = "ru";
    try { saved = localStorage.getItem(LANG_KEY) || "ru"; } catch (e) {}
    applyLang(saved);

    var ru = document.getElementById("tkLangRu");
    var en = document.getElementById("tkLangEn");
    if (ru) ru.addEventListener("click", function () { applyLang("ru"); });
    if (en) en.addEventListener("click", function () { applyLang("en"); });
  }

  /* ---------- mobile menu ---------- */
  function initMenu() {
    var open = document.getElementById("tkBurgerOpen");
    var close = document.getElementById("tkBurgerClose");
    var menu = document.getElementById("tkMobileMenu");
    if (!open || !close || !menu) return;

    open.addEventListener("click", function () {
      menu.style.display = "flex";
      document.body.style.overflow = "hidden";
    });
    close.addEventListener("click", function () {
      menu.style.display = "none";
      document.body.style.overflow = "";
    });
  }

  /* ---------- animated stat counters ---------- */
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

  /* ---------- email subscribe form ---------- */
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

    input.addEventListener("input", function () {
      setState("idle");
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });
    btn.addEventListener("click", submit);

    function submit() {
      var v = input.value.trim();
      setState(valid(v) ? "sent" : "error");
    }
  }

  /* ---------- placeholder links: keep them focusable, stop the jump ---------- */
  function initPlaceholderLinks() {
    var links = document.querySelectorAll('a[href="#"]');
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener("click", function (e) {
        e.preventDefault();
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    initLang();
    initMenu();
    initStats();
    initSubscribe();
    initPlaceholderLinks();
  });
})();
