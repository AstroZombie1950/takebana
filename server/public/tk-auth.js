// Вход, регистрация и восстановление пароля: отправка формы и показ пароля.
//
// Раньше это делал service.js — 722 строки, из которых страницам входа
// и регистрации нужны первые девяносто; остальное — карта и заведения.
(function () {
  "use strict";

  // Подписи — из общего словаря (public/tk-i18n.js), он грузится раньше.
  var t = function (key, vars) { return window.t ? window.t(key, vars) : ""; };

  // Задача против подбора пароля (utils/loginGuard.js). После трёх ошибок
  // сервер присылает строку, и браузер ищет число, с которым SHA-256
  // от «строка:число» начинается с заданного числа нулевых бит. Хеши
  // считаются пачками по 256: так crypto.subtle работает быстрее, чем по одному.
  function zeroBits(hash) {
    for (var i = 0, n = 0; i < hash.length; i++, n += 8) {
      if (hash[i]) return n + Math.clz32(hash[i]) - 24;
    }
    return n;
  }

  function solve(task) {
    var bits = Number(task.split(".")[1]);
    var enc = new TextEncoder();
    function from(n) {
      var jobs = [];
      for (var i = 0; i < 256; i++) jobs.push(crypto.subtle.digest("SHA-256", enc.encode(task + ":" + (n + i))));
      return Promise.all(jobs).then(function (hashes) {
        for (var i = 0; i < hashes.length; i++) {
          if (zeroBits(new Uint8Array(hashes[i])) >= bits) return task + ":" + (n + i);
        }
        return from(n + 256);
      });
    }
    return from(0);
  }

  // Решение следующей задачи. Сервер присылает её вместе с отказом, и браузер
  // считает, пока человек заново набирает пароль, — к нажатию «Войти» оно
  // обычно уже готово.
  var task = null;

  // Ответ сервера один и тот же по форме: { message, redirectUrl }. Успех —
  // по адресу перехода: текст сообщения переводится на язык интерфейса, и
  // сравнение с ним ломалось бы на английском. onOk — для ответа без перехода
  // (письмо восстановления). 428 — нужна задача, а её не было или она
  // устарела: решаем присланную и повторяем запрос сами, один раз.
  function submit(url, body, button, onOk, retried) {
    button.disabled = true;
    var label = button.innerHTML;
    if (task) button.textContent = t("auth.checking");
    var ready = task || Promise.resolve("");
    task = null;
    ready
      .then(function (answer) {
        if (answer) body.task = answer;
        return fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        });
      })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; }); })
      .then(function (res) {
        var data = res.data;
        if (data.redirectUrl) {
          window.location.href = data.redirectUrl;
          return; // кнопку не возвращаем: уходим со страницы
        }
        button.innerHTML = label;
        if (data.task) task = solve(data.task);
        if (res.status === 428 && !retried) return submit(url, body, button, onOk, true);
        button.disabled = false;
        if (res.ok && onOk) onOk();
        else toast(data.message);
      })
      .catch(function () {
        button.innerHTML = label;
        button.disabled = false;
        toast(t("auth.noServer"));
      });
  }

  // Куда вернуться после входа: ?next= ставят ссылки «Войти» в шапке, в эфире
  // и на странице автора. Проверяет адрес сервер (middleware/auth.js, safeNext).
  var next = new URLSearchParams(location.search).get("next") || "";

  function value(id) {
    var el = document.getElementById(id);
    return el ? el.value : "";
  }

  function initLogin() {
    var form = document.getElementById("tkLoginForm");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      submit(
        "/login",
        { email: value("email"), password: value("password"), provider: "", next: next },
        form.querySelector('[type="submit"]')
      );
    });
  }

  function initRegister() {
    var form = document.getElementById("tkRegisterForm");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (value("password") !== value("confirmPassword")) {
        toast(t("auth.passwordMismatch"));
        return;
      }
      submit(
        "/register",
        { email: value("email"), password: value("password"), provider: "", next: next },
        form.querySelector('[type="submit"]')
      );
    });
  }

  // Письмо со ссылкой. Форма уходит со страницы целиком, а не прячется
  // атрибутом: у .tk-auth__form свой display, и hidden он перебивает.
  function initForgot() {
    var form = document.getElementById("tkForgotForm");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      submit("/forgot-password", { email: value("email") }, form.querySelector('[type="submit"]'), function () {
        form.remove();
        document.getElementById("tkForgotSent").hidden = false;
      });
    });
  }

  // Новый пароль по ссылке. Токен — последний сегмент адреса страницы.
  function initReset() {
    var form = document.getElementById("tkResetForm");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (value("password") !== value("confirmPassword")) {
        toast(t("auth.passwordMismatch"));
        return;
      }
      submit(
        "/reset-password",
        { token: location.pathname.split("/").pop(), password: value("password") },
        form.querySelector('[type="submit"]')
      );
    });
  }

  // Показать пароль. Кнопка лежит внутри .tk-field-wrap рядом с полем.
  function initEyes() {
    var eyes = document.querySelectorAll("[data-eye]");
    for (var i = 0; i < eyes.length; i++) {
      eyes[i].addEventListener("click", function () {
        var input = this.parentNode.querySelector("input");
        if (!input) return;
        var shown = input.type === "text";
        input.type = shown ? "password" : "text";
        var key = shown ? "auth.showPassword" : "auth.hidePassword";
        this.setAttribute("data-i18n-aria", key);
        this.setAttribute("aria-label", t(key));
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    initLogin();
    initRegister();
    initForgot();
    initReset();
    initEyes();
  });
})();
