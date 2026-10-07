// Переключатель темы — один на весь сайт (utils/theme.js, цвета — css/tk.css).
//
// Кнопки в разметке:
//   [data-theme-pick="…"]    — переключатель в левой панели: dark | light;
//                              нажата та, что на экране, и при «как в системе»
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
    mark('[data-theme-set]', 'data-theme-set', p);
    mark('[data-theme-pick]', 'data-theme-pick', on);
  }

  function mark(sel, attr, value) {
    var set = document.querySelectorAll(sel);
    for (var i = 0; i < set.length; i++) {
      var mine = set[i].getAttribute(attr) === value;
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

  // При «как в системе» сервер не знает, какая тема на экране: её ставит
  // строка в partials/tkHead.ejs ещё до отрисовки. Переключатель панели
  // сверяем с ней.
  mark('[data-theme-pick]', 'data-theme-pick', root.getAttribute('data-theme'));

  // Страница, отданная до выбора «как в системе», уже стоит в нужной теме
  // (строка в partials/tkHead.ejs); здесь — смена системы при открытой.
  system.addEventListener('change', function () {
    if (pref() === 'auto') apply('auto');
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-theme-set], [data-theme-pick]');
    if (!btn) return;
    var p = btn.getAttribute('data-theme-set');
    if (!p) {
      p = btn.getAttribute('data-theme-pick');
      // Нажата уже горящая тема при «как в системе» — выбор не меняем.
      if (p === root.getAttribute('data-theme')) return;
    }
    choose(p);
  });

  // Страницу вернули кнопкой «назад» из кэша браузера — тема могла смениться
  // на другой странице.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    var m = /(?:^|;\s*)theme=(dark|light|auto)(?:;|$)/.exec(document.cookie);
    if (m) apply(m[1]);
  });
})();
