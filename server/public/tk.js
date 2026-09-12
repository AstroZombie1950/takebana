// Поведение каркаса: мобильное меню.
//
// Подключается на каждой странице сайта, поэтому здесь только то, что есть
// в шапке. Всё остальное — в скрипте своей страницы.
//
// Переключателя языка здесь больше нет: перевод, подсветку кнопок и память
// выбора держит общий словарь (public/tk-i18n.js) — он же обслуживает кабинет.
// До этого публичные страницы и кабинет переключали язык каждый по-своему
// и помнили выбор в разных ключах localStorage, так что язык не переносился.
(function () {
  "use strict";

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

  document.addEventListener("DOMContentLoaded", initMenu);
})();
