// Тип заведения в заявке и настройках (partials/venuePlace.ejs, 30.09).
// «Другое — ввести самому» открывает поле под списком. Страна — в блоке
// точки (tk-point.js), города с 09.10 нет.
//
// TKPlace.attach(root) → { value() } — { type, typeOther } для запроса:
// код из списка или своё текстом (utils/places.js, pick); null — не выбран.
(function () {
  'use strict';

  var OTHER = '__other';

  function attach(root) {
    var sel = root.querySelector('[data-place-select]');
    var own = root.querySelector('[data-place-other]');

    sel.addEventListener('change', function () {
      var on = sel.value === OTHER;
      var was = !own.hidden;
      own.hidden = !on;
      if (on && !was && document.activeElement === sel) own.focus();
    });

    return {
      value: function () {
        var text = sel.value === OTHER ? own.value.trim() : '';
        if (!text && (!sel.value || sel.value === OTHER)) {
          (sel.value === OTHER ? own : sel).focus();
          return null;
        }
        return { type: sel.value === OTHER ? '' : sel.value, typeOther: text };
      },
    };
  }

  window.TKPlace = { attach: attach };
})();
