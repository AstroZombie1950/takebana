// Тип, страна и город заведения в заявке и настройках (partials/venuePlace.ejs,
// 30.09). «Другое — ввести самому» открывает поле под списком; город —
// после страны и только её города. Своя страна или городов у страны в списке
// нет — город только вписать: в списке города стоит «Другой», и он заперт.
//
// TKPlace.attach(root) → { value() } — шесть полей для запроса: код из списка
// или своё текстом (utils/places.js, pick); null — чего-то не хватает.
(function () {
  'use strict';

  var OTHER = '__other';
  var KINDS = ['type', 'country', 'city'];

  function attach(root) {
    var sel = {}, own = {};
    KINDS.forEach(function (k) {
      sel[k] = root.querySelector('[data-place-select="' + k + '"]');
      own[k] = root.querySelector('[data-place-other="' + k + '"]');
    });
    // Все города разом — пункты переставляются, а не создаются: у каждого
    // свой ключ словаря, и переключение языка их переводит.
    var cities = Array.prototype.filter.call(sel.city.options, function (o) { return o.hasAttribute('data-country'); });

    function show(k) {
      var on = sel[k].value === OTHER;
      var was = !own[k].hidden;
      own[k].hidden = !on;
      if (on && !was && document.activeElement === sel[k]) own[k].focus();
    }

    function fillCities() {
      var country = sel.country.value;
      var keep = sel.city.value;
      cities.forEach(function (o) { o.remove(); });
      var mine = country && country !== OTHER ? cities.filter(function (o) { return o.getAttribute('data-country') === country; }) : [];
      mine.forEach(function (o) { sel.city.appendChild(o); });
      var free = !!country && !mine.length;
      if (free) sel.city.value = OTHER;
      else if (!mine.some(function (o) { return o.value === keep; }) && keep !== OTHER) sel.city.value = '';
      // Без страны город не выбрать; своя страна — город только вписать.
      sel.city.disabled = !country || free;
      show('city');
    }

    KINDS.forEach(function (k) {
      sel[k].addEventListener('change', function () {
        if (k === 'country') fillCities();
        show(k);
      });
    });
    fillCities();

    return {
      value: function () {
        var out = {};
        for (var i = 0; i < KINDS.length; i++) {
          var k = KINDS[i];
          var text = sel[k].value === OTHER ? own[k].value.trim() : '';
          if (!text && (!sel[k].value || sel[k].value === OTHER)) {
            (sel[k].value === OTHER ? own[k] : sel[k]).focus();
            return null;
          }
          out[k] = sel[k].value === OTHER ? '' : sel[k].value;
          out[k + 'Other'] = text;
        }
        return out;
      },
      // Для выбора точки: страна и город — поля, на смену которых смотрит карта.
      country: sel.country,
      city: sel.city,
      // Своё текстом — подсказка поиску адреса, кода у него нет.
      ownText: function () {
        return ['city', 'country'].map(function (k) { return sel[k].value === OTHER ? own[k].value.trim() : ''; }).filter(Boolean).join(', ');
      },
    };
  }

  window.TKPlace = { attach: attach };
})();
