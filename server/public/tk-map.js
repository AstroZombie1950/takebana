// Карта заведений на своей подложке. MapLibre GL рисует векторные плитки
// Protomaps, которые лежат у нас (server/media/basemap, отдаётся как
// /basemap/): ни ключей, ни чужих плиточных серверов. Раньше плитки шли
// с общественного сервера OpenStreetMap — он не для продуктов и в какой-то
// момент стал отвечать картинкой «Access blocked».
//
// Страница подключает /vendor/pmtiles-4.5.0.js и этот файл; MapLibre (ES-модуль,
// ~290 КБ сжатого) грузится здесь же при создании карты.
//
// TKMap.mount(container, { center: [lng, lat], zoom }) → Promise<карта>:
//   карта.setPoints([{ id, lng, lat, name, photo, online }])
//   карта.on('hover', fn(id, { x, y }) — наведение на заведение; fn(null) — ушли)
//   карта.on('click', fn(id))
//   карта.on('move', fn({ west, south, east, north })) — после остановки карты
//   карта.flyTo(lng, lat, zoom, padding) — padding { right } или { bottom }:
//     точка встаёт в середину той части карты, что не закрыта карточкой
//
// TKMap.pick(container, { center, zoom, point }) → Promise<выбор точки>:
//   выбор.on('pick', fn({ lng, lat })) — метку перетащили или поставили щелчком
//   выбор.setLngLat(lng, lat, zoom), выбор.getLngLat(), выбор.has(), выбор.clear()
//   выбор.resize() — после показа окна, иначе карта считает себя нулевой
//
// TKMap.setLang('ru' | 'en') — подписи всех карт страницы на другом языке;
// на событие `tk:lang` общего переключателя этот файл подписывается сам
(function () {
  var LIB = '/vendor/maplibre-gl-6.9.0/maplibre-gl.mjs';
  var BELGRADE = [20.4612, 44.8125];
  var protocolReady = false;

  function lang() {
    return window.tkLang ? window.tkLang() : 'ru';
  }

  // Стиль в git без адресов (ops/basemap/style.mjs): MapLibre нужны
  // абсолютные адреса шрифтов и значков, поэтому они — от адреса страницы.
  // Ответ кэшируется: при смене языка тот же стиль нужен второй раз.
  var styles = {};
  function loadStyle(l) {
    if (styles[l]) return styles[l];
    var origin = location.origin;
    styles[l] = fetch('/map/style.' + l + '.json')
      .then(function (r) { return r.json(); })
      .then(function (s) {
        s.glyphs = origin + '/basemap/fonts/{fontstack}/{range}.pbf';
        s.sprite = origin + '/basemap/sprites/dark';
        s.sources.protomaps.url = 'pmtiles://' + origin + '/basemap/basemap.pmtiles';
        return s;
      })
      .catch(function (err) {
        delete styles[l]; // не запоминаем неудачу
        throw err;
      });
    return styles[l];
  }

  // Все карты страницы: смена языка проходит по ним.
  var live = [];

  // Подписи на другом языке без перезагрузки. Стили ru и en отличаются только
  // выражением `text-field` у десяти слоёв подписей, поэтому подменяем именно
  // их: `setStyle` перебрал бы стиль целиком и снёс наши источники, слои
  // заведений и маркеры. Раньше подписи оставались на языке, который был
  // в момент открытия страницы, и менялись только с перезагрузкой.
  function setLang(next) {
    var l = next === 'en' ? 'en' : 'ru';
    return loadStyle(l).then(function (s) {
      live.forEach(function (map) {
        s.layers.forEach(function (layer) {
          var text = layer.layout && layer.layout['text-field'];
          if (!text || !map.getLayer(layer.id)) return;
          map.setLayoutProperty(layer.id, 'text-field', text);
        });
      });
    });
  }

  // Подписи на плитках живут вне DOM, поэтому общий переключатель языка
  // (public/tk-i18n.js) сообщает о смене событием, а не перерисовкой разметки.
  document.addEventListener('tk:lang', function (e) {
    if (live.length) setLang(e.detail && e.detail.lang);
  });

  // Общее для карты заведений и выбора точки: библиотека, стиль, базовая карта.
  function createMap(container, opts) {
    return Promise.all([import(LIB), loadStyle(lang())]).then(function (res) {
      var lib = res[0].default || res[0];
      if (!protocolReady) {
        lib.addProtocol('pmtiles', new pmtiles.Protocol().tile);
        protocolReady = true;
      }
      var map = new lib.Map({
        container: container,
        style: res[1],
        center: opts.center || BELGRADE,
        zoom: opts.zoom || 11,
        attributionControl: { compact: true },
        dragRotate: false,
        pitchWithRotate: false,
      });
      map.touchZoomRotate.disableRotation();
      map.addControl(new lib.NavigationControl({ showCompass: false }), 'bottom-right');
      live.push(map);
      return new Promise(function (resolve) {
        map.on('load', function () { resolve({ lib: lib, map: map }); });
      });
    });
  }

  function mount(container, opts) {
    return createMap(container, opts || {}).then(function (r) { return venues(r.lib, r.map); });
  }

  // Выбор точки заведения: одна перетаскиваемая метка и ничего больше —
  // ни заведений, ни групп. Метка появляется только когда точка задана:
  // пока владелец её не поставил, у заведения координат нет, и врать
  // меткой в центре города не следует.
  function pick(container, opts) {
    opts = opts || {};
    return createMap(container, { center: opts.point || opts.center, zoom: opts.zoom || 16 }).then(function (r) {
      var lib = r.lib, map = r.map;

      var el = document.createElement('span');
      el.className = 'tk-point';
      el.setAttribute('aria-hidden', 'true');
      var marker = new lib.Marker({ element: el, anchor: 'bottom', draggable: true });
      var placed = false;
      var handlers = [];

      function place(lng, lat) {
        marker.setLngLat([lng, lat]);
        if (!placed) {
          marker.addTo(map);
          placed = true;
        }
      }
      function emit() {
        var p = marker.getLngLat();
        handlers.forEach(function (fn) { fn({ lng: p.lng, lat: p.lat }); });
      }

      if (opts.point) place(opts.point[0], opts.point[1]);
      marker.on('dragend', emit);

      // Щелчок по карте — тоже постановка метки: попасть пальцем в место
      // проще, чем поймать и протащить метку, а мышью так короче.
      map.on('click', function (e) {
        place(e.lngLat.lng, e.lngLat.lat);
        emit();
      });
      map.getCanvas().style.cursor = 'crosshair';

      return {
        map: map,
        on: function (ev, fn) {
          if (ev === 'pick') handlers.push(fn);
          return this;
        },
        has: function () { return placed; },
        // Окно настроек одно на все заведения: у следующего точки может
        // не быть, и метка предыдущего осталась бы висеть на карте.
        clear: function () {
          if (!placed) return;
          marker.remove();
          placed = false;
        },
        getLngLat: function () {
          if (!placed) return null;
          var p = marker.getLngLat();
          return { lng: p.lng, lat: p.lat };
        },
        setLngLat: function (lng, lat, zoom) {
          place(lng, lat);
          map.easeTo({ center: [lng, lat], zoom: zoom || Math.max(map.getZoom(), 16) });
        },
        center: function (lng, lat, zoom) { map.jumpTo({ center: [lng, lat], zoom: zoom || map.getZoom() }); },
        resize: function () { map.resize(); },
      };
    });
  }

  // Первая буква названия — для заведения без фото: «Бар «Тэкэбана»» → «Б».
  function initial(name) {
    var m = String(name || '').match(/[\p{L}\p{N}]/u);
    return m ? m[0].toUpperCase() : '•';
  }

  // Заведения: близкие точки карта сама собирает в кружок с числом,
  // одиночные — HTML-маркеры с фото, у идущей камеры красное кольцо.
  function venues(lib, map) {
    var handlers = { hover: [], click: [], move: [] };
    function emit(ev, a, b) { handlers[ev].forEach(function (fn) { fn(a, b); }); }
    var markers = {}; // id → { marker, el, img, letter }

    map.addSource('venues', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      cluster: true,
      clusterRadius: 48,
      clusterMaxZoom: 15,
    });
    map.addLayer({
      id: 'venue-clusters', type: 'circle', source: 'venues', filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#0A0A0A',
        'circle-stroke-color': '#C9C2B7',
        'circle-stroke-width': 2,
        'circle-radius': ['step', ['get', 'point_count'], 18, 10, 22, 50, 28],
      },
    });
    map.addLayer({
      id: 'venue-count', type: 'symbol', source: 'venues', filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Medium'], 'text-size': 13 },
      paint: { 'text-color': '#F5F1EA' },
    });

    map.on('click', 'venue-clusters', function (e) {
      var f = e.features[0];
      map.getSource('venues').getClusterExpansionZoom(f.properties.cluster_id).then(function (zoom) {
        map.easeTo({ center: f.geometry.coordinates, zoom: zoom });
      });
    });
    map.on('mouseenter', 'venue-clusters', function () { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'venue-clusters', function () { map.getCanvas().style.cursor = ''; });

    // Координаты маркера — от угла карты: подсказка встаёт над ним.
    function anchorOf(el) {
      var r = el.getBoundingClientRect();
      var c = map.getContainer().getBoundingClientRect();
      return { x: r.left + r.width / 2 - c.left, y: r.top - c.top };
    }

    function makeMarker(id) {
      var el = document.createElement('button');
      el.type = 'button';
      el.className = 'tk-pin';
      var img = document.createElement('img');
      img.alt = '';
      // Фото не загрузилось — показываем букву, а не значок битой картинки.
      img.onerror = function () { el.classList.add('tk-pin--empty'); };
      var letter = document.createElement('span');
      letter.className = 'tk-pin__letter';
      letter.setAttribute('aria-hidden', 'true');
      el.append(img, letter);
      el.addEventListener('mouseenter', function () { emit('hover', id, anchorOf(el)); });
      el.addEventListener('mouseleave', function () { emit('hover', null); });
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        emit('click', id);
      });
      return { marker: new lib.Marker({ element: el, anchor: 'bottom' }), el: el, img: img, letter: letter };
    }

    // Маркеры — по тому, что источник сейчас показывает без группировки.
    function syncMarkers() {
      var seen = {};
      map.querySourceFeatures('venues').forEach(function (f) {
        var p = f.properties;
        if (p.cluster || seen[p.id]) return;
        seen[p.id] = true;
        var m = markers[p.id] || (markers[p.id] = makeMarker(p.id));
        m.el.setAttribute('aria-label', p.name);
        m.el.classList.toggle('is-live', !!p.online);
        m.el.classList.toggle('tk-pin--empty', !p.photo);
        m.letter.textContent = initial(p.name);
        if (p.photo && m.img.getAttribute('src') !== p.photo) m.img.src = p.photo;
        m.marker.setLngLat(f.geometry.coordinates).addTo(map);
      });
      Object.keys(markers).forEach(function (id) {
        if (!seen[id]) {
          markers[id].marker.remove();
          delete markers[id];
        }
      });
    }
    map.on('moveend', syncMarkers);
    map.on('sourcedata', function (e) {
      if (e.sourceId === 'venues' && e.isSourceLoaded) syncMarkers();
    });

    var moveTimer = null;
    function moved() {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(function () {
        var b = map.getBounds();
        emit('move', { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
      }, 300);
    }
    map.on('moveend', moved);

    var api = {
      map: map,
      on: function (ev, fn) {
        handlers[ev].push(fn);
        if (ev === 'move') moved(); // первая выборка — по текущему виду
        return api;
      },
      setPoints: function (list) {
        map.getSource('venues').setData({
          type: 'FeatureCollection',
          features: list.map(function (v) {
            return {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [v.lng, v.lat] },
              properties: { id: v.id, name: v.name || '', photo: v.photo || '', online: !!v.online },
            };
          }),
        });
      },
      flyTo: function (lng, lat, zoom, padding) {
        map.flyTo({ center: [lng, lat], zoom: zoom || 14, padding: padding || 0 });
      },
    };
    return api;
  }

  window.TKMap = { mount: mount, pick: pick, setLang: setLang };
})();
