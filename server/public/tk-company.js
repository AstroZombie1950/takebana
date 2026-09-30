// Заявка на регистрацию заведения.
//
// Заменяет блок REGISTER ESTABLISHMENT из service.js и заодно снимает
// со страницы jQuery с плагином inputmask: маска «99:99» — двадцать строк
// ниже, ради них тянуть 90 КБ библиотеки незачем.
(function () {
  "use strict";

  // Подписи — из общего словаря (public/tk-i18n.js), он грузится раньше.
  var t = function (key, vars) { return window.t ? window.t(key, vars) : ""; };

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

    // Тип, страна и город — список или своё (public/tk-venue-place.js).
    var place = window.TKPlace.attach(form.querySelector("[data-place]"));

    // Точка на карте: метка и поиск по адресу (public/tk-point.js). Без
    // координат заведение не попадает на карту вообще, поэтому метка здесь
    // обязательна — а ставить её рукой можно и без поиска адреса.
    var pointBox = form.querySelector("[data-point]");
    var point = pointBox && window.TKPoint
      ? window.TKPoint.attach(pointBox, { address: form.elements.address, place: place })
      : null;

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      var where = place.value();
      if (!where) {
        toast(t("company.fillAll"));
        return;
      }
      var establishment = {
        name: val("name"),
        address: val("address"),
        email: val("email"),
        phone: val("phone"),
        weekdayHours: { open: val("weekdayOpen"), close: val("weekdayClose") },
        weekendHours: { open: val("weekendOpen"), close: val("weekendClose") },
      };

      Object.keys(where).forEach(function (k) { establishment[k] = where[k]; });

      // Сервер тоже проверяет, но здесь ответ мгновенный и без запроса.
      var required = [
        establishment.name, establishment.address, establishment.email, establishment.phone,
        establishment.weekdayHours.open, establishment.weekdayHours.close,
        establishment.weekendHours.open, establishment.weekendHours.close,
      ];
      for (var i = 0; i < required.length; i++) {
        if (!required[i]) {
          toast(t("company.fillAll"));
          return;
        }
      }

      var spot = point && point.value();
      if (!spot) {
        toast(t("company.needPoint"));
        if (pointBox) pointBox.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
      establishment.lat = spot.lat;
      establishment.lng = spot.lng;

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
          toast(t("company.sendFailed", { message: error.message }), "error");
        });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initTimeMask();
    initForm();
  });
})();
