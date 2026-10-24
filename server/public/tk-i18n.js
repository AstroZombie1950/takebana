// ── Переключатель ───────────────────────────────────────────────────────────
//
// Один словарь и один переключатель на весь сайт. Раньше их было два:
// публичные страницы переводились по `data-i18n` из этого файла и помнили
// выбор в `localStorage.tk_lang`, а кабинет — по числовым `lng="123"`
// из `lang.js` и помнил выбор в `localStorage.lang`. `lang.js` удалён,
// числовые ключи переписаны на имена.
//
// Страница приходит с сервера уже на нужном языке: <html lang> в ней — язык,
// на котором она отрисована. Язык публичной страницы — её адрес (/ru/@anna,
// docs/seo/LANGUAGES.md), и сменить его — перейти на её версию на другом
// языке (window.TK.urls.alt). Закрытая страница (переписка, студия)
// переключается на месте, по ключам в разметке: звонок, эфир или открытый
// диалог при этом не рвутся.
//
// Две cookie (utils/i18n.js, langOf):
//   lang_choice — выбор в меню языка: по нему сервер ведёт на версию страницы
//                 на этом языке;
//   lang        — язык последней публичной страницы этой вкладки: по нему
//                 закрытые страницы и ответы сервера продолжают её язык.
//
// Словарь — по файлу на язык: tk-i18n-<код>.js. Страница подключает перед
// этим файлом только словарь своего языка, другой подгружается при первом
// переключении. Список языков и их локали — window.TK.langs (сервер,
// utils/langs.js); первый — основной.
// Прежде оба языка ехали на каждую страницу — 80 КБ вместо 30–42.
//
//   data-i18n="ключ"              — текст элемента (допускается разметка)
//   data-i18n-placeholder="ключ"  — подсказка поля, разметка вырезается
//   data-i18n-title="ключ"        — всплывающая подсказка
//   data-i18n-aria="ключ"         — подпись для читалки экрана
//   data-i18n-label="ключ"        — подпись группы <optgroup> (атрибут label)
//   data-i18n-region="RS"         — имя страны по коду ISO, из Intl (09.10)
//   data-i18n-month="1"           — имя месяца по номеру, из Intl (09.10)
//
//   window.t('ключ' [, запасная строка | подстановки]) — строка на текущем
//     языке для скриптов, которые собирают разметку сами:
//     t('venues.photo', { n: 2 }) по «Фото {n}» даёт «Фото 2»
//   window.tkText(элемент, 'ключ' [, подстановки]) — поставить текст так,
//     чтобы он пережил переключение языка
//   window.tkDate(дата [, параметры toLocaleString]) — дата и время в локали
//     интерфейса: tkDate(x, { hour: '2-digit', minute: '2-digit' }) → «10:04»
//   window.tkLocale()                    — локаль интерфейса для Intl: 'ru-RU'
//   window.tkPlural(n, 'rec.views')      — ключ формы слова по числу:
//     rec.viewsOne / rec.viewsFew / rec.viewsMany, правила языка — из Intl
//   window.applyLang('ru')               — выбрать язык, как в меню: публичная
//     страница переходит на свою версию, закрытая — переводится на месте
//     (промис: словарь может ещё загружаться)
//   window.tkHref('/@anna')              — адрес публичной страницы на языке
//     этой: '/ru/@anna'; для переходов из скриптов (location.href = …)
//   window.tkLang()                      — текущий язык
//   событие `tk:lang` на document        — после переключения, для того,
//     что собирают скрипты: подписи на плитках карты, лента переписки
(function () {
  'use strict';

  var TK = window.TK_I18N || (window.TK_I18N = {});
  var rendered = document.documentElement.getAttribute('lang');
  var LANGS = (window.TK && window.TK.langs) || {};
  var CODES = Object.keys(LANGS);
  function isLang(l) { return CODES.indexOf(l) >= 0; }
  var URLS = (window.TK && window.TK.urls) || {};
  var BASE = URLS.base || CODES[0];
  var PUBLIC = URLS.rx ? new RegExp(URLS.rx) : null;
  var ALT = URLS.alt || null; // эта страница на каждом языке; у закрытой — null

  function choice() {
    var m = /(?:^|;\s*)lang_choice=([a-z]{2})(?:;|$)/.exec(document.cookie);
    return m && isLang(m[1]) ? m[1] : '';
  }
  function setCookie(name, value) {
    document.cookie = name + '=' + value + '; path=/; max-age=31536000; samesite=lax';
  }

  // Текущий язык — тот, чей словарь уже на странице: пока другой грузится,
  // t() и tkLang() не должны расходиться со строками, которые отдают.
  var current = TK[rendered] ? rendered : Object.keys(TK)[0];

  function dict(l) { return TK[l] || TK[current] || {}; }

  // Словарь языка: уже подключён — сразу, иначе один раз тегом <script>.
  var loading = {};
  function load(l) {
    if (TK[l]) return Promise.resolve();
    return loading[l] || (loading[l] = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      // Адрес — от сервера (window.TK.langs, partials/header.ejs): сжатая копия
      // с хешем в имени. Собранный здесь «/tk-i18n-en.js» был бы без версии,
      // и после правки словаря браузер держал бы старый.
      script.src = LANGS[l].dict;
      script.onload = resolve;
      script.onerror = function () { delete loading[l]; reject(new Error('словарь ' + l + ' не загрузился')); };
      document.head.appendChild(script);
    }));
  }

  // t('ключ')                       — строка на текущем языке
  // t('ключ', 'запасная строка')    — если ключа ещё нет в словаре
  // t('ключ', { n: 3 })             — подстановка: «Фото {n}» → «Фото 3»
  //
  // Строка — текст, не разметка: её ставят через textContent. В разметку
  // её кладёт только render() ниже — с экранированными подстановками.
  function t(key, arg, wrap) {
    var v = dict(current)[key];
    if (v === undefined) return typeof arg === 'string' ? arg : '';
    if (arg && typeof arg === 'object') {
      return String(v).replace(/\{(\w+)\}/g, function (whole, name) {
        return arg[name] === undefined ? whole : wrap ? wrap(arg[name]) : arg[name];
      });
    }
    return v;
  }

  // Локаль, а не код языка: toLocaleString('en') в части браузеров даёт
  // другой порядок, чем сервер (utils/langs.js, locale).
  function locale() { return (LANGS[current] || {}).locale || current; }

  function date(value, opts) {
    return new Date(value).toLocaleString(locale(), opts);
  }

  // Форма слова — как plural() в шаблонах (utils/i18n.js): One / Few / Many,
  // «other» и чего в словаре нет — Many.
  var FORM = { one: 'One', few: 'Few', many: 'Many' };
  function plural(n, base) {
    return base + (FORM[new Intl.PluralRules((LANGS[current] || {}).plural || locale()).select(n)] || 'Many');
  }

  var strip = function (s) { return String(s).replace(/<[^>]*>/g, ''); };
  var escapeHtml = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; });
  };

  // Подстановки — экранированными: строка идёт в innerHTML, а в них бывает
  // чужой текст — поисковый запрос, имя (аудит 14.10, S7).
  function fill(attr, set) {
    var nodes = document.querySelectorAll('[' + attr + ']');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute(attr);
      if (dict(current)[key] === undefined) continue; // ключа ещё нет в словаре
      // Подстановки строк со скобками ({n}, {name}) складывает сюда tkText:
      // без них переключение языка показало бы сам шаблон.
      var vars = nodes[i].getAttribute('data-i18n-vars');
      set(nodes[i], t(key, vars ? JSON.parse(vars) : undefined, escapeHtml));
    }
  }

  // Страны — не строки словаря: их имена знает сам браузер (Intl), в разметке
  // только код — data-i18n-region="RS" (utils/places.js, заведения).
  function regions() {
    var nodes = document.querySelectorAll('[data-i18n-region]');
    if (!nodes.length || !window.Intl || !Intl.DisplayNames) return;
    var names = new Intl.DisplayNames([current], { type: 'region' });
    for (var i = 0; i < nodes.length; i++) {
      try { nodes[i].textContent = names.of(nodes[i].getAttribute('data-i18n-region')); } catch (e) {}
    }
  }

  // Месяцы — тоже из Intl, по номеру: дата рождения (partials/birthSelect.ejs)
  // при смене языка без перезагрузки оставалась с русскими месяцами.
  function months() {
    var nodes = document.querySelectorAll('[data-i18n-month]');
    if (!nodes.length) return;
    var names = new Intl.DateTimeFormat(locale(), { month: 'long', timeZone: 'UTC' });
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = names.format(Date.UTC(2000, Number(nodes[i].getAttribute('data-i18n-month')) - 1, 1));
    }
  }

  // Текст, который ставит скрипт. Ключ переезжает на элемент, поэтому строка
  // переживает переключение языка; без этого статичный ключ в разметке
  // затирал бы то, что поставил скрипт, а поставленное скриптом — не
  // переводилось бы вовсе.
  function setText(el, key, vars) {
    if (!el) return;
    if (key) {
      el.setAttribute('data-i18n', key);
      if (vars) el.setAttribute('data-i18n-vars', JSON.stringify(vars));
      else el.removeAttribute('data-i18n-vars');
      el.textContent = t(key, vars);
    } else {
      el.removeAttribute('data-i18n');
      el.removeAttribute('data-i18n-vars');
      el.textContent = '';
    }
  }

  // Перевод закрытой страницы на месте. Скрипты страницы с самого начала
  // берут строки через t() на текущем языке, поэтому событие — только при
  // настоящей смене.
  var wanted;
  function apply(next) {
    wanted = next;
    return load(next).then(function () {
      if (wanted !== next) return; // пока грузился, выбрали другой
      current = next;
      if (document.documentElement.getAttribute('lang') !== current) render();
    });
  }

  function render() {
    // В строках словаря бывает разметка (<strong>, <br>), поэтому innerHTML.
    // Заголовок вкладки — исключение: в него подставляется поисковый запрос
    // и другие чужие строки, и там нужен только текст.
    fill('data-i18n', function (el, v) {
      if (el.tagName === 'TITLE') el.textContent = strip(v);
      else el.innerHTML = v;
    });
    fill('data-i18n-placeholder', function (el, v) { el.placeholder = strip(v); });
    fill('data-i18n-title', function (el, v) { el.title = strip(v); });
    fill('data-i18n-aria', function (el, v) { el.setAttribute('aria-label', strip(v)); });
    fill('data-i18n-label', function (el, v) { el.label = strip(v); });
    regions();
    months();

    document.documentElement.setAttribute('lang', current);

    // Переключатели: тумблер настроек и меню языка в левой панели.
    var buttons = document.querySelectorAll('[data-lang]');
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-lang') === current;
      if (buttons[i].classList.contains('tk-lang__btn')) {
        buttons[i].classList.toggle('tk-lang__btn--on', on);
        buttons[i].setAttribute('aria-pressed', String(on));
      } else if (on) buttons[i].setAttribute('aria-current', 'true');
      else buttons[i].removeAttribute('aria-current');
    }
    var menus = document.querySelectorAll('[data-langmenu]');
    for (var j = 0; j < menus.length; j++) {
      menus[j].open = false;
      menus[j].querySelector('.tk-langmenu__name').textContent = (LANGS[current] || {}).name || current;
    }

    document.dispatchEvent(new CustomEvent('tk:lang', { detail: { lang: current } }));
  }

  // Выбор языка — как в меню: запоминается (сервер ведёт на версии на нём),
  // в журнал (lang.pick), публичная страница — переход на свою версию.
  // go = false — переходит сама ссылка меню.
  function pick(next, go) {
    if (!isLang(next)) return Promise.resolve();
    setCookie('lang_choice', next);
    setCookie('lang', next);
    try {
      navigator.sendBeacon('/api/lang', new Blob([JSON.stringify({ lang: next, from: current })], { type: 'application/json' }));
    } catch (e) {}
    if (ALT) {
      if (next !== current && go !== false) location.assign(ALT[next]);
      return Promise.resolve();
    }
    return apply(next);
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-lang]') : null;
    if (btn) {
      pick(btn.getAttribute('data-lang'), btn.tagName !== 'A').catch(function (err) { console.error('[i18n]', err.message); });
      return;
    }
    // Меню языка закрывается кликом мимо.
    var menus = document.querySelectorAll('[data-langmenu][open]');
    for (var i = 0; i < menus.length; i++) if (!menus[i].contains(e.target)) menus[i].open = false;
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var menu = document.querySelector('[data-langmenu][open]');
    if (menu) { menu.open = false; menu.querySelector('summary').focus(); }
  });

  // Адрес публичной страницы на языке этой: '/@anna' → '/ru/@anna'.
  // Ссылки сервер уже отдаёт с приставкой (utils/langUrl.js); здесь — для
  // тех, что собирают скрипты, и для переходов из них.
  function href(url) {
    if (current === BASE || !PUBLIC || typeof url !== 'string' || url[0] !== '/' || url[1] === '/') return url;
    var cut = url.search(/[?#]/);
    var path = cut === -1 ? url : url.slice(0, cut);
    if (!PUBLIC.test(path)) return url;
    return '/' + current + (path === '/' ? '' : path) + (cut === -1 ? '' : url.slice(cut));
  }
  // Ссылка, собранная скриптом без приставки, получает её в момент нажатия
  // (и правой кнопкой — «копировать адрес»). Меню языка (hreflang) не трогаем.
  function fixLink(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('hreflang')) return;
    var url = a.getAttribute('href');
    var next = href(url);
    if (next !== url) a.setAttribute('href', next);
  }
  ['click', 'auxclick', 'contextmenu'].forEach(function (type) { document.addEventListener(type, fixLink, true); });

  window.t = t;
  window.tkText = setText;
  // Имя страны по коду ISO на текущем языке: 'rs' → «Сербия».
  window.tkRegion = function (code) {
    try { return new Intl.DisplayNames([current], { type: 'region' }).of(String(code).toUpperCase()); } catch (e) { return ''; }
  };
  window.tkDate = date;
  window.tkLocale = locale;
  window.tkPlural = plural;
  window.applyLang = pick;
  window.tkHref = href;
  window.tkLang = function () { return current; };

  // Публичная страница помечает свой язык (cookie lang) — закрытые и ответы
  // сервера продолжат его. Рядом — часовой пояс: даты в разметке сервер
  // пишет в нём, а не в своём (на бою UTC). Год — от последнего визита.
  function start() {
    if (ALT) setCookie('lang', current);
    try { setCookie('tz', Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) {}
  }
  start();

  // Страница может вернуться на экран целой: Safari отдаёт её из памяти по
  // «назад» (bfcache), соседняя вкладка или окно приложения просто становится
  // видимым. Публичная — снова помечает свой язык (в другой вкладке мог быть
  // другой). Закрытая — сверяется с выбором в меню и переводится на месте:
  // у заказчика 29.09 после переключения на английский бургер-меню
  // открывалось по-русски, а новая страница — уже по-английски.
  function resync() {
    if (ALT) return start();
    var c = choice();
    if (c && c !== current) apply(c).catch(function (err) { console.error('[i18n]', err.message); });
  }
  window.addEventListener('pageshow', function (e) { if (e.persisted) resync(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) resync(); });
})();
