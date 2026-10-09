// Точка заведения в формах владельца: метка на карте и поиск по адресу.
//
// Разметка — views/partials/venuePoint.ejs, карта — TKMap.pick (tk-map.js),
// поиск адреса — наш /api/geocode: чужой сервис стоит за ним и в страницу
// не попадает. Широту с долготой владельцу не показываем вовсе — их никто
// не знает; он либо ставит метку, либо пишет адрес, и одно ведёт другое.
//
// Карта поднимается не при загрузке страницы, а когда блок впервые показан:
// MapLibre — около 290 КБ, и до заявки доходят не все, кто открыл страницу.
//
// Страна заведения (09.10) — отсюда же: её приносит ответ поиска и адрес
// под меткой, она ложится в скрытое поле country и показывается строкой
// «Страна». Владелец её не выбирает; города нет вовсе — он в адресе.
// Карта без точки открывается миром (решение заказчика 09.10: прежде —
// Белградом, а владелец мог о Сербии и не слышать).
//
// TKPoint.attach(root, { address }) → {
//   open(lat, lng) — блок показан: поднять карту, поставить метку, если есть
//   value() — { lat, lng } или null
//   country() — { country, countryOther } для запроса
// }
(function () {
  'use strict';

  // Подписи — из общего словаря (public/tk-i18n.js).
  var t = function (key, arg) { return window.t ? window.t(key, arg) : ''; };

  var POINT_VIEW = 16;  // масштаб «видно дом»: точка известна

  function attach(root, opts) {
    opts = opts || {};
    var mapBox = root.querySelector('[data-point-map]');
    var latField = root.querySelector('[data-point-lat]');
    var lngField = root.querySelector('[data-point-lng]');
    var note = root.querySelector('[data-point-note]');
    var found = root.querySelector('[data-point-found]');
    var addressOut = root.querySelector('[data-point-address]');
    var applyBtn = root.querySelector('[data-point-apply]');
    var findBtn = root.querySelector('[data-point-find]');
    var addressField = opts.address || null;
    var ccField = root.querySelector('[data-point-cc]');
    var ccOther = root.querySelector('[data-point-cc-other]');
    var ccLine = root.querySelector('[data-point-country]');
    var ccName = root.querySelector('[data-point-cc-name]');

    var idle = note.textContent;
    var picker = null;
    var mounting = null;
    var reverseTimer = null;

    function say(text) { note.textContent = text || idle; }

    // Страна из ответа поиска: пустой код — страну не узнали, прежнюю
    // не трогаем (поиск лежит, а метку двигали рукой).
    function setCountry(code) {
      if (!code) return;
      ccField.value = code;
      ccOther.value = '';
      ccName.innerHTML = '';
      var span = document.createElement('span');
      span.setAttribute('data-i18n-region', code.toUpperCase());
      span.textContent = window.tkRegion ? window.tkRegion(code) : code.toUpperCase();
      ccName.appendChild(span);
      ccLine.hidden = false;
    }

    function setFields(lng, lat) {
      // Шесть знаков — это около десяти сантиметров: больше незачем,
      // а меньше уже смещает метку на соседний дом.
      latField.value = lat.toFixed(6);
      lngField.value = lng.toFixed(6);
    }

    function read(r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.message || t('common.failedCode', { code: r.status }));
        return data;
      });
    }

    // Адрес, который вернул поиск. Пустое поле заполняем сразу — терять
    // нечего; заполненное не переписываем молча, а предлагаем кнопкой.
    function showFound(address) {
      if (!address) {
        found.hidden = true;
        return;
      }
      addressOut.textContent = address;
      found.hidden = false;

      if (addressField && !addressField.value.trim()) {
        addressField.value = address;
        applyBtn.hidden = true;
        say(t('point.addressTaken'));
        return;
      }
      applyBtn.hidden = !addressField || addressField.value.trim() === address;
    }

    function askAddress(p) {
      say(t('point.locating'));
      tkFetch('/api/geocode/reverse?lat=' + p.lat.toFixed(6) + '&lng=' + p.lng.toFixed(6),
            { credentials: 'same-origin' })
        .then(read)
        .then(function (data) {
          say(t('point.placed'));
          setCountry(data.country);
          showFound(data.address);
        })
        .catch(function (err) { say(t('point.placedNoAddress', { error: err.message })); });
    }

    function picked(p) {
      setFields(p.lng, p.lat);
      // Перетаскивание — это десятки событий; адрес спрашиваем, когда метку
      // отпустили и она постояла: у поиска на той стороне запрос в секунду.
      clearTimeout(reverseTimer);
      reverseTimer = setTimeout(function () { askAddress(p); }, 600);
    }

    function ensure(point) {
      if (picker) return Promise.resolve(picker);
      if (!mounting) {
        mounting = window.TKMap.pick(mapBox, {
          zoom: point ? POINT_VIEW : null,
          point: point || null,
        }).then(function (p) {
          picker = p;
          picker.on('pick', picked);
          return p;
        }).catch(function (err) {
          mounting = null;
          say(t('point.mapFailed', { error: err.message }));
          throw err;
        });
      }
      return mounting;
    }

    function find() {
      var q = addressField ? addressField.value.trim() : '';
      if (q.length < 3) {
        say(t('point.needAddress'));
        return;
      }
      findBtn.disabled = true;
      say(t('point.searching'));

      tkFetch('/api/geocode?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
        .then(read)
        .then(function (data) {
          return ensure([data.lng, data.lat]).then(function (p) {
            p.resize();
            p.setLngLat(data.lng, data.lat, POINT_VIEW);
            setFields(data.lng, data.lat);
            say(t('point.foundAddress'));
            setCountry(data.country);
            showFound(data.address);
          });
        })
        .catch(function (err) { say(err.message); })
        .finally(function () { findBtn.disabled = false; });
    }

    findBtn.addEventListener('click', find);

    applyBtn.addEventListener('click', function () {
      if (!addressField) return;
      addressField.value = addressOut.textContent;
      applyBtn.hidden = true;
      say(t('point.addressUsed'));
    });

    if (addressField) {
      // Enter в адресе — поиск, а не отправка формы: так и задумано,
      // «написал адрес — метка переехала».
      addressField.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        find();
      });
    }

    // Блок в заявке и в правке заведения — просто в потоке: карту поднимаем,
    // когда до него доскроллили или когда позвали open() (правка — сразу,
    // с точкой заведения).
    if (window.IntersectionObserver) {
      var io = new IntersectionObserver(function (entries) {
        if (!entries.some(function (e) { return e.isIntersecting; })) return;
        io.disconnect();
        ensure(null).catch(function () {});
      }, { rootMargin: '200px' });
      io.observe(root);
    }

    return {
      open: function (lat, lng) {
        var has = Number.isFinite(lat) && Number.isFinite(lng);
        found.hidden = true;
        say(null);
        if (has) setFields(lng, lat);
        else { latField.value = ''; lngField.value = ''; }

        ensure(has ? [lng, lat] : null).then(function (p) {
          p.resize(); // окно только что показали: до этого карта считала себя нулевой
          if (has) {
            p.setLngLat(lng, lat, POINT_VIEW);
            return;
          }
          // У этого заведения точки нет — метка предыдущего не должна остаться.
          p.clear();
          p.world();
        }).catch(function () {});
      },
      value: function () {
        var lat = Number(latField.value);
        var lng = Number(lngField.value);
        if (!latField.value || !lngField.value || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { lat: lat, lng: lng };
      },
      country: function () { return { country: ccField.value, countryOther: ccOther.value }; },
    };
  }

  window.TKPoint = { attach: attach };
})();
