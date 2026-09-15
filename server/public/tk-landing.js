// Поведение, которое есть только на главной: счётчики, форма подписки
// и карта заведений. Язык, бургер и ссылки-заглушки живут в tk.js — они нужны
// всем страницам.
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

  /* ---------- карта заведений ----------
   * Та же карта, что у вошедших на /main. Библиотека тяжёлая, а до секции
   * докручивает не каждый, поэтому стили и скрипты карты подгружаются, только
   * когда секция подходит к экрану. Точки — по видимой части карты, как там. */
  function load(tag, attrs) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement(tag);
      for (var k in attrs) el[k] = attrs[k];
      el.onload = resolve;
      el.onerror = reject;
      document.head.appendChild(el);
    });
  }

  function initMap() {
    var box = document.getElementById("tkHomeMap");
    if (!box) return;

    function start() {
      Promise.all([
        load("link", { rel: "stylesheet", href: "/vendor/maplibre-gl-6.9.0/maplibre-gl.css" }),
        load("link", { rel: "stylesheet", href: "/css/tk-map.css" }),
        load("script", { src: "/vendor/pmtiles-4.5.0.js" }).then(function () {
          return load("script", { src: "/tk-map.js" });
        })
      ])
        .then(function () { return window.TKMap.mount(box, { cooperative: true }); })
        .then(function (map) {
          var venues = [];
          var pending = null;
          var tip = document.createElement("div");
          tip.className = "tk-homemap__tip";
          tip.hidden = true;
          box.appendChild(tip);

          map.on("move", function (b) {
            if (pending) pending.abort();
            var ctrl = pending = new AbortController();
            var q = "bl_lat=" + b.south + "&bl_lng=" + b.west + "&tr_lat=" + b.north + "&tr_lng=" + b.east;
            fetch("/establishmentsLocation?" + q, { signal: ctrl.signal })
              .then(function (r) { return r.json(); })
              .then(function (list) {
                venues = list;
                map.setPoints(list.map(function (v) {
                  return { id: v._id, lng: v.location.lng, lat: v.location.lat, name: v.name, photo: v.photos[0], online: v.online };
                }));
              })
              .catch(function (e) { if (e.name !== "AbortError") console.error("Заведения не загрузились:", e); });
          });
          map.on("hover", function (id, at) {
            var v = id && venues.filter(function (x) { return x._id === id; })[0];
            tip.hidden = !v;
            if (!v) return;
            tip.textContent = v.name;
            tip.style.left = at.x + "px";
            tip.style.top = at.y + "px";
          });
          // Карточка заведения и эфир камеры — после входа.
          map.on("click", function () { location.href = "/login"; });
        })
        .catch(function (e) { console.error("Карта не загрузилась:", e); });
    }

    if (!("IntersectionObserver" in window)) return start();
    var io = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      start();
    }, { rootMargin: "600px 0px" });
    io.observe(box);
  }

  document.addEventListener("DOMContentLoaded", function () {
    initStats();
    initSubscribe();
    initMap();
  });
})();
