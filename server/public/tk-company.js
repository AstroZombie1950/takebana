// Заявка на регистрацию заведения.
//
// Заменяет блок REGISTER ESTABLISHMENT из service.js и заодно снимает
// со страницы jQuery с плагином inputmask: маска «99:99» — двадцать строк
// ниже, ради них тянуть 90 КБ библиотеки незачем.
(function () {
  "use strict";

  // Время: цифры, двоеточие после второй. Пишем и стираем без сюрпризов —
  // никакого «перепрыгивания» курсора, потому что правим только конец строки.
  function initTimeMask() {
    var fields = document.querySelectorAll("[data-time]");
    for (var i = 0; i < fields.length; i++) {
      fields[i].addEventListener("input", function () {
        var digits = this.value.replace(/\D/g, "").slice(0, 4);
        this.value = digits.length > 2 ? digits.slice(0, 2) + ":" + digits.slice(2) : digits;
      });
    }
  }

  function initForm() {
    var form = document.getElementById("tkCompanyForm");
    var done = document.getElementById("tkCompanyDone");
    if (!form) return;

    var val = function (name) {
      var el = form.elements[name];
      return el ? el.value.trim() : "";
    };

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      var establishment = {
        country: val("country"),
        city: val("city"),
        name: val("name"),
        address: val("address"),
        email: val("email"),
        phone: val("phone"),
        weekdayHours: { open: val("weekdayOpen"), close: val("weekdayClose") },
        weekendHours: { open: val("weekendOpen"), close: val("weekendClose") },
      };

      // Сервер тоже проверяет, но здесь ответ мгновенный и без запроса.
      var required = [
        establishment.country, establishment.city, establishment.name,
        establishment.address, establishment.email, establishment.phone,
        establishment.weekdayHours.open, establishment.weekdayHours.close,
        establishment.weekendHours.open, establishment.weekendHours.close,
      ];
      for (var i = 0; i < required.length; i++) {
        if (!required[i]) {
          toast("Заполните все поля");
          return;
        }
      }

      var button = form.querySelector('[type="submit"]');
      button.disabled = true;

      fetch("/register-establishment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(establishment),
      })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (err) { throw new Error(err.message); });
          return r.json();
        })
        .then(function () {
          form.hidden = true;
          if (done) done.hidden = false;
        })
        .catch(function (error) {
          button.disabled = false;
          toast("Не удалось отправить заявку: " + error.message, "error");
        });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initTimeMask();
    initForm();
  });
})();
