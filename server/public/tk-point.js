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
// TKPoint.attach(root, { address, cityField }) → {
//   open(lat, lng) — блок показан: поднять карту, поставить метку, если есть
//   value() — { lat, lng } или null
// }
(function () {
  'use strict';

  // Подписи — из общего словаря (public/tk-i18n.js).
  var t = function (key, arg) { return window.t ? window.t(key, arg) : ''; };

  var DEFAULT = [20.4612, 44.8125]; // Белград — если город ещё не выбран
  var CITY_VIEW = 12;   // масштаб «весь город»: точку ещё не поставили
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
    var cityField = opts.cityField || null;

    var idle = note.textContent;
    var picker = null;
    var mounting = null;
    var reverseTimer = null;

    function say(text) { note.textContent = text || idle; }

    function cityCenter() {
      var centers = window.TKCityCenter || {};
      return (cityField && centers[cityField.value]) || DEFAULT;
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
      fetch('/api/geocode/reverse?lat=' + p.lat.toFixed(6) + '&lng=' + p.lng.toFixed(6),
            { credentials: 'same-origin' })
        .then(read)
        .then(function (data) {
          say(t('point.placed'));
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
          center: cityCenter(),
          zoom: point ? POINT_VIEW : CITY_VIEW,
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

      var url = '/api/geocode?q=' + encodeURIComponent(q) +
                (cityField && cityField.value ? '&city=' + encodeURIComponent(cityField.value) : '');
      fetch(url, { credentials: 'same-origin' })
        .then(read)
        .then(function (data) {
          return ensure([data.lng, data.lat]).then(function (p) {
            p.resize();
            p.setLngLat(data.lng, data.lat, POINT_VIEW);
            setFields(data.lng, data.lat);
            say(t('point.foundAddress'));
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

    if (cityField) {
      cityField.addEventListener('change', function () {
        if (!picker || picker.has()) return; // метку уже поставили — не дёргаем
        var c = cityCenter();
        picker.center(c[0], c[1], CITY_VIEW);
      });
    }

    // Блок на странице заявки — просто в потоке: карту поднимаем, когда
    // до него доскроллили. В окне настроек блок скрыт, и наблюдатель молчит
    // до вызова open().
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
          var c = cityCenter();
          p.center(c[0], c[1], CITY_VIEW);
        }).catch(function () {});
      },
      value: function () {
        var lat = Number(latField.value);
        var lng = Number(lngField.value);
        if (!latField.value || !lngField.value || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { lat: lat, lng: lng };
      },
    };
  }

  window.TKPoint = { attach: attach };
})();
