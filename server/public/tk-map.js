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
//   карта.flyTo(lng, lat, zoom)
(function () {
  var LIB = '/vendor/maplibre-gl-6.9.0/maplibre-gl.mjs';
  var protocolReady = false;

  function lang() {
    try { return localStorage.getItem('lang') === 'en' ? 'en' : 'ru'; } catch (_) { return 'ru'; }
  }

  // Стиль в git без адресов (ops/basemap/style.mjs): MapLibre нужны
  // абсолютные адреса шрифтов и значков, поэтому они — от адреса страницы.
  function loadStyle() {
    var origin = location.origin;
    return fetch('/map/style.' + lang() + '.json')
      .then(function (r) { return r.json(); })
      .then(function (s) {
        s.glyphs = origin + '/basemap/fonts/{fontstack}/{range}.pbf';
        s.sprite = origin + '/basemap/sprites/dark';
        s.sources.protomaps.url = 'pmtiles://' + origin + '/basemap/basemap.pmtiles';
        return s;
      });
  }

  function mount(container, opts) {
    opts = opts || {};
    return Promise.all([import(LIB), loadStyle()]).then(function (res) {
      var lib = res[0].default || res[0];
      if (!protocolReady) {
        lib.addProtocol('pmtiles', new pmtiles.Protocol().tile);
        protocolReady = true;
      }
      var map = new lib.Map({
        container: container,
        style: res[1],
        center: opts.center || [20.4612, 44.8125], // Белград
        zoom: opts.zoom || 11,
        attributionControl: { compact: true },
        dragRotate: false,
        pitchWithRotate: false,
      });
      map.touchZoomRotate.disableRotation();
      map.addControl(new lib.NavigationControl({ showCompass: false }), 'bottom-right');
      return new Promise(function (resolve) {
        map.on('load', function () { resolve(venues(lib, map)); });
      });
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
      flyTo: function (lng, lat, zoom) {
        map.flyTo({ center: [lng, lat], zoom: zoom || 14 });
      },
    };
    return api;
  }

  window.TKMap = { mount: mount };
})();
