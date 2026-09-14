// Вход, регистрация и восстановление пароля: отправка формы и показ пароля.
//
// Раньше это делал service.js — 722 строки, из которых страницам входа
// и регистрации нужны первые девяносто; остальное — карта и заведения.
(function () {
  "use strict";

  // Подписи — из общего словаря (public/tk-i18n.js), он грузится раньше.
  var t = function (key, vars) { return window.t ? window.t(key, vars) : ""; };

  // Ответ сервера один и тот же по форме: { message, redirectUrl }. Успех —
  // по адресу перехода: текст сообщения переводится на язык интерфейса, и
  // сравнение с ним ломалось бы на английском. onOk — для ответа без перехода
  // (письмо восстановления).
  function submit(url, body, button, onOk) {
    button.disabled = true;
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (res) {
        var data = res.data;
        if (data.redirectUrl) {
          window.location.href = data.redirectUrl;
          return; // кнопку не возвращаем: уходим со страницы
        }
        button.disabled = false;
        if (res.ok && onOk) onOk();
        else toast(data.message);
      })
      .catch(function () {
        button.disabled = false;
        toast(t("auth.noServer"));
      });
  }

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
        { email: value("email"), password: value("password"), provider: "" },
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
        { email: value("email"), password: value("password"), provider: "" },
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
