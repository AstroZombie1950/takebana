// Вход и регистрация: отправка формы и показ пароля.
//
// Раньше это делал service.js — 722 строки, из которых страницам входа
// и регистрации нужны первые девяносто; остальное — карта и заведения.
(function () {
  "use strict";

  // Ответ сервера один и тот же по форме: { message, redirectUrl }.
  function submit(url, body, okMessage, button) {
    button.disabled = true;
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.message === okMessage) {
          window.location.href = data.redirectUrl;
          return; // кнопку не возвращаем: уходим со страницы
        }
        button.disabled = false;
        toast(data.message);
      })
      .catch(function () {
        button.disabled = false;
        toast("Сервер не ответил. Попробуйте ещё раз.");
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
        "User logged in successfully",
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
        toast("Passwords do not match");
        return;
      }
      submit(
        "/register",
        { email: value("email"), password: value("password"), provider: "" },
        "User registered successfully",
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
        this.setAttribute("aria-label", shown ? "Показать пароль" : "Скрыть пароль");
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    initLogin();
    initRegister();
    initEyes();
  });
})();
