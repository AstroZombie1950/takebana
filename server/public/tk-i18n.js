// ── Переключатель ───────────────────────────────────────────────────────────
//
// Один словарь и один переключатель на весь сайт. Раньше их было два:
// публичные страницы переводились по `data-i18n` из этого файла и помнили
// выбор в `localStorage.tk_lang`, а кабинет — по числовым `lng="123"`
// из `lang.js` и помнил выбор в `localStorage.lang`. `lang.js` удалён,
// числовые ключи переписаны на имена.
//
// Выбор живёт в cookie `lang`, и страница приходит с сервера уже на нужном
// языке: <html lang> в ней — язык, на котором она отрисована. Раньше сервер
// всегда отдавал русский, а скрипт переводил после загрузки — английская
// страница мигала русским. Ключи в разметке остаются для переключения без
// перезагрузки: звонок, эфир или открытый диалог при этом не рвутся.
//
// Словарь — по файлу на язык: tk-i18n-ru.js и tk-i18n-en.js. Страница
// подключает перед этим файлом только словарь своего языка, второй
// подгружается при первом переключении.
// Прежде оба языка ехали на каждую страницу — 80 КБ вместо 30–42.
//
//   data-i18n="ключ"              — текст элемента (допускается разметка)
//   data-i18n-placeholder="ключ"  — подсказка поля, разметка вырезается
//   data-i18n-title="ключ"        — всплывающая подсказка
//   data-i18n-aria="ключ"         — подпись для читалки экрана
//
//   window.t('ключ' [, запасная строка | подстановки]) — строка на текущем
//     языке для скриптов, которые собирают разметку сами:
//     t('venues.photo', { n: 2 }) по «Фото {n}» даёт «Фото 2»
//   window.tkText(элемент, 'ключ' [, подстановки]) — поставить текст так,
//     чтобы он пережил переключение языка
//   window.tkDate(дата [, параметры toLocaleString]) — дата и время в локали
//     интерфейса: tkDate(x, { hour: '2-digit', minute: '2-digit' }) → «10:04»
//   window.applyLang('ru' | 'en')        — переключить; промис: словарь
//     другого языка может ещё загружаться
//   window.tkLang()                      — текущий язык
//   событие `tk:lang` на document        — после переключения, для того,
//     что собирают скрипты: подписи на плитках карты, лента переписки
(function () {
  'use strict';

  var TK = window.TK_I18N || (window.TK_I18N = {});
  var rendered = document.documentElement.getAttribute('lang');

  function saved() {
    var m = /(?:^|;\s*)lang=(en|ru)(?:;|$)/.exec(document.cookie);
    if (m) return m[1];
    // Выбор, сделанный до cookie, — в localStorage; при первом применении
    // он переезжает в cookie, а localStorage чистится.
    try {
      var v = localStorage.getItem('lang') || localStorage.getItem('tk_lang');
      if (v === 'en' || v === 'ru') return v;
    } catch (e) {} // приватный режим запрещает чтение
    return rendered === 'en' ? 'en' : 'ru';
  }

  // Текущий язык — тот, чей словарь уже на странице: пока второй грузится,
  // t() и tkLang() не должны расходиться со строками, которые отдают.
  var current = TK[rendered] ? rendered : (TK.ru ? 'ru' : 'en');

  function dict(l) { return TK[l] || TK[current] || {}; }

  // Словарь языка: уже подключён — сразу, иначе один раз тегом <script>.
  var loading = {};
  function load(l) {
    if (TK[l]) return Promise.resolve();
    return loading[l] || (loading[l] = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = '/tk-i18n-' + l + '.js';
      script.onload = resolve;
      script.onerror = function () { delete loading[l]; reject(new Error('словарь ' + l + ' не загрузился')); };
      document.head.appendChild(script);
    }));
  }

  // t('ключ')                       — строка на текущем языке
  // t('ключ', 'запасная строка')    — если ключа ещё нет в словаре
  // t('ключ', { n: 3 })             — подстановка: «Фото {n}» → «Фото 3»
  function t(key, arg) {
    var v = dict(current)[key];
    if (v === undefined) return typeof arg === 'string' ? arg : '';
    if (arg && typeof arg === 'object') {
      return String(v).replace(/\{(\w+)\}/g, function (whole, name) {
        return arg[name] === undefined ? whole : arg[name];
      });
    }
    return v;
  }

  // Локаль, а не код языка: toLocaleString('en') в части браузеров даёт
  // другой порядок, чем сервер (utils/i18n.js, LOCALE).
  function date(value, opts) {
    return new Date(value).toLocaleString(current === 'en' ? 'en-US' : 'ru-RU', opts);
  }

  var strip = function (s) { return String(s).replace(/<[^>]*>/g, ''); };

  function fill(attr, set) {
    var nodes = document.querySelectorAll('[' + attr + ']');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute(attr);
      if (dict(current)[key] === undefined) continue; // ключа ещё нет в словаре
      // Подстановки строк со скобками ({n}, {name}) складывает сюда tkText:
      // без них переключение языка показало бы сам шаблон.
      var vars = nodes[i].getAttribute('data-i18n-vars');
      set(nodes[i], t(key, vars ? JSON.parse(vars) : undefined));
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

  // Перерисовка разметки — только если страница отрисована на другом языке:
  // при переключении или когда выбор ещё лежал в localStorage и сервер
  // о нём не знал. Скрипты страницы с самого начала берут строки через t()
  // на текущем языке, поэтому событие — только при настоящей смене.
  var wanted;
  function apply(next) {
    next = next === 'en' ? 'en' : 'ru';
    wanted = next;

    // Сервер отвечает на языке из этой cookie (utils/i18n.js). Ставится и на
    // загрузке — год отсчитывается от последнего визита. Рядом — часовой
    // пояс: даты в разметке сервер пишет в нём, а не в своём (на бою UTC).
    document.cookie = 'lang=' + next + '; path=/; max-age=31536000; samesite=lax';
    try {
      document.cookie = 'tz=' + Intl.DateTimeFormat().resolvedOptions().timeZone + '; path=/; max-age=31536000; samesite=lax';
    } catch (e) {}
    try { localStorage.removeItem('lang'); localStorage.removeItem('tk_lang'); } catch (e) {}

    return load(next).then(function () {
      if (wanted !== next) return; // пока грузился, выбрали другой
      current = next;
      if (document.documentElement.getAttribute('lang') !== current) render();
    });
  }

  function render() {
    fill('data-i18n', function (el, v) { el.innerHTML = v; });
    fill('data-i18n-placeholder', function (el, v) { el.placeholder = strip(v); });
    fill('data-i18n-title', function (el, v) { el.title = strip(v); });
    fill('data-i18n-aria', function (el, v) { el.setAttribute('aria-label', strip(v)); });

    document.documentElement.setAttribute('lang', current);

    // Переключатели: выпадашка шапки, мобильное меню, публичная шапка.
    var buttons = document.querySelectorAll('[data-lang]');
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-lang') === current;
      buttons[i].classList.toggle('tk-lang__btn--on', on);
      buttons[i].setAttribute('aria-pressed', String(on));
    }
    var toggle = document.getElementById('languageToggle');
    var label = toggle && toggle.querySelector('span');
    if (label) label.textContent = current.toUpperCase();

    document.dispatchEvent(new CustomEvent('tk:lang', { detail: { lang: current } }));
  }

  // Перехват на всплытии вниз: в шапке кабинета на этих же кнопках висят
  // свои обработчики, и они закрывают выпадашку.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-lang]') : null;
    if (!btn) return;
    var next = btn.getAttribute('data-lang');
    if (next !== 'ru' && next !== 'en') return;
    apply(next).catch(function (err) { console.error('[i18n]', err.message); });
    var dropdown = document.getElementById('languageDropdown');
    if (dropdown) dropdown.classList.add('hidden');
  }, true);

  window.t = t;
  window.tkText = setText;
  window.tkDate = date;
  window.applyLang = apply;
  window.tkLang = function () { return current; };

  function start() {
    apply(saved()).catch(function (err) { console.error('[i18n]', err.message); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
