// Поведение каркаса: переключатель языка и мобильное меню.
//
// Подключается на каждой странице сайта, поэтому здесь только то, что есть
// в шапке. Всё остальное — в скрипте своей страницы.
//
// Словарь (tk-i18n.js) не обязателен: без него переключатель просто меняет
// подсветку и атрибут lang, а тексты остаются как в разметке.
(function () {
  "use strict";

  var LANG_KEY = "tk_lang";

  function applyLang(lang) {
    var dict = (typeof TK_I18N !== "undefined" && TK_I18N[lang]) || null;
    if (dict) {
      var nodes = document.querySelectorAll("[data-i18n]");
      for (var i = 0; i < nodes.length; i++) {
        var key = nodes[i].getAttribute("data-i18n");
        // Ключа может не быть: страница переводится по мере готовности словаря.
        if (dict[key] !== undefined) nodes[i].innerHTML = dict[key];
      }
      // Плейсхолдеры полей — отдельным атрибутом: innerHTML их не трогает.
      var fields = document.querySelectorAll("[data-i18n-placeholder]");
      for (var j = 0; j < fields.length; j++) {
        var pkey = fields[j].getAttribute("data-i18n-placeholder");
        if (dict[pkey] !== undefined) fields[j].placeholder = dict[pkey];
      }
    }

    document.documentElement.setAttribute("lang", lang === "en" ? "en" : "ru");

    var buttons = document.querySelectorAll("[data-lang]");
    for (var k = 0; k < buttons.length; k++) {
      buttons[k].classList.toggle(
        "tk-lang__btn--on",
        buttons[k].getAttribute("data-lang") === lang
      );
    }

    // Приватный режим запрещает запись — язык тогда живёт до перезагрузки.
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
  }

  function initLang() {
    var saved = "ru";
    try { saved = localStorage.getItem(LANG_KEY) || "ru"; } catch (e) {}
    applyLang(saved);

    var buttons = document.querySelectorAll("[data-lang]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", function () {
        applyLang(this.getAttribute("data-lang"));
      });
    }
  }

  function initMenu() {
    var open = document.getElementById("tkBurgerOpen");
    var close = document.getElementById("tkBurgerClose");
    var menu = document.getElementById("tkMobileMenu");
    if (!open || !close || !menu) return;

    var toggle = function (on) {
      if (on) menu.setAttribute("data-open", "");
      else menu.removeAttribute("data-open");
      // Фон под открытым меню не должен прокручиваться.
      document.body.style.overflow = on ? "hidden" : "";
    };

    open.addEventListener("click", function () { toggle(true); });
    close.addEventListener("click", function () { toggle(false); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && menu.hasAttribute("data-open")) toggle(false);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initLang();
    initMenu();
  });
})();
