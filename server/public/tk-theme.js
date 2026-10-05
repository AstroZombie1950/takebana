// Переключатель темы — один на весь сайт (utils/theme.js, цвета — css/tk.css).
//
// Кнопки в разметке:
//   [data-theme-toggle]      — значок в шапке и левой панели: тёмная ⇄ светлая
//   [data-theme-set="…"]     — выбор в настройках: dark | light | auto
//
// Тема меняется на месте, без перезагрузки: атрибут data-theme на <html>,
// cookie `theme` (с ней сервер отдаст следующую страницу сразу в ней) и,
// у вошедшего, аккаунт. Не сохранилось в аккаунте — на этой странице и
// в этом браузере тема уже другая, а человек видит, что на другом
// устройстве её не будет.
//
// Событие `tk:theme` на document — после смены: карта (tk-map.js) меняет
// подложку.
(function () {
  var root = document.documentElement;
  var system = matchMedia('(prefers-color-scheme: light)');
  var COLORS = { dark: '#0A0A0A', light: '#F5F1EA' };

  function pref() {
    return root.hasAttribute('data-theme-auto') ? 'auto' : root.getAttribute('data-theme');
  }

  function apply(p) {
    var on = p === 'auto' ? (system.matches ? 'light' : 'dark') : p;
    root.toggleAttribute('data-theme-auto', p === 'auto');
    if (root.getAttribute('data-theme') !== on) {
      root.setAttribute('data-theme', on);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', COLORS[on]);
      document.dispatchEvent(new CustomEvent('tk:theme', { detail: { theme: on } }));
    }
    var set = document.querySelectorAll('[data-theme-set]');
    for (var i = 0; i < set.length; i++) {
      var mine = set[i].getAttribute('data-theme-set') === p;
      set[i].classList.toggle('tk-lang__btn--on', mine);
      set[i].setAttribute('aria-pressed', mine);
    }
  }

  function choose(p) {
    if (p === pref()) return;
    apply(p);
    document.cookie = 'theme=' + p + '; path=/; max-age=31536000; samesite=lax';
    if (window.TK && TK.userId) {
      TKNet.json('/settings/theme', { method: 'POST', body: { theme: p } })
        .catch(function (err) { TKNet.say(err, t('theme.saveFailed')); });
    }
  }

  // Страница, отданная до выбора «как в системе», уже стоит в нужной теме
  // (строка в partials/tkHead.ejs); здесь — смена системы при открытой.
  system.addEventListener('change', function () {
    if (pref() === 'auto') apply('auto');
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-theme-toggle], [data-theme-set]');
    if (!btn) return;
    var p = btn.getAttribute('data-theme-set');
    choose(p || (root.getAttribute('data-theme') === 'light' ? 'dark' : 'light'));
  });

  // Страницу вернули кнопкой «назад» из кэша браузера — тема могла смениться
  // на другой странице.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    var m = /(?:^|;\s*)theme=(dark|light|auto)(?:;|$)/.exec(document.cookie);
    if (m) apply(m[1]);
  });
})();
