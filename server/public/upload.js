/* Страница загрузки фото и видео в галерею (/upload, 21.09.2026).
 *
 * Фото: выбрали — видны снимки, «Опубликовать фото» отправляет их пачками
 * по 20 (POST /profile/gallery, сжатие и знак — на сервере).
 *
 * Видео: выбрали — сразу поехало в фоне (tk-upload.js), а на карточке можно
 * смотреть его и править, не дожидаясь конца: обрезать начало и конец,
 * убрать звук, выбрать обложку — кадр из видео или свою картинку.
 * «Опубликовать» можно нажать и во время загрузки: пережатие начнётся,
 * как только файл доедет. Правка применяется при пережатии на сервере
 * (utils/videoEncode.js), исходник не меняется.
 *
 * Маршруты — routes/streaming/upload.js, вёрстка — views/upload.ejs,
 * css/upload.css.
 */
(function () {
  var D = window.TK_UPLOAD || { drafts: [], maxSeconds: 3600, videoEnabled: false };
  var t = function (k, v) { return window.t ? window.t(k, v) : k; };
  var $ = function (id) { return document.getElementById(id); };

  var PHOTO_MB = 10;
  var PHOTOS_AT_ONCE = 100;
  var MIN_LEN = 1;          // короче секунды обрезать нельзя (сервер проверяет то же)

  function json(url, options) {
    options = options || {};
    options.headers = Object.assign({ Accept: 'application/json' }, options.headers);
    return fetch(url, options).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || d.success === false) throw new Error(d.message || 'HTTP ' + r.status);
        return d;
      });
    });
  }

  function post(url, body) {
    return json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  function clock(s) {
    s = Math.max(0, Math.round(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  }

  function bytes(n) {
    return n >= 1024 * 1024 * 1024
      ? t('upload.gb', { n: (n / 1024 / 1024 / 1024).toFixed(1) })
      : t('upload.mb', { n: Math.max(1, Math.round(n / 1024 / 1024)) });
  }

  // Длительность из заголовка, не загружая файл: узнать о пределе после
  // часа загрузки было бы обидно. Не разобрал браузер — проверит сервер.
  function duration(file) {
    return new Promise(function (resolve) {
      var v = document.createElement('video');
      var url = URL.createObjectURL(file);
      var done = function (s) { URL.revokeObjectURL(url); resolve(s); };
      v.preload = 'metadata';
      v.onloadedmetadata = function () { done(isFinite(v.duration) ? v.duration : 0); };
      v.onerror = function () { done(0); };
      setTimeout(function () { done(0); }, 8000);
      v.src = url;
    });
  }

  // ── Выбор файлов ──────────────────────────────────────────────────────
  var drop = $('upDrop');
  var input = $('upInput');

  function pick(list) {
    var all = Array.prototype.slice.call(list || []);
    var videos = D.videoEnabled ? all.filter(function (f) { return /^video\//.test(f.type); }) : [];
    var photos = all.filter(function (f) { return /^image\/(png|jpeg|webp)$/.test(f.type); });
    if (videos.length + photos.length < all.length) toast(t('user.galleryBadType'), 'error');
    var heavy = photos.filter(function (f) { return f.size > PHOTO_MB * 1024 * 1024; });
    if (heavy.length) toast(t(heavy.length === 1 ? 'user.photoHeavy' : 'user.photosHeavy', { name: heavy[0].name, n: heavy.length, mb: PHOTO_MB }), 'error');
    addPhotos(photos.filter(function (f) { return heavy.indexOf(f) === -1; }));
    videos.forEach(function (f) {
      duration(f).then(function (s) {
        if (s > D.maxSeconds + 1) return toast(t('user.videoTooLong', { name: f.name }), 'error');
        return window.TKUpload.add(f).then(function (v) { card(v, f).el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
      }).catch(function (e) { toast(t('app.errorShort', { message: e.message }), 'error'); });
    });
  }

  input.addEventListener('change', function () { pick(input.files); input.value = ''; });
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', function (e) { if (!drop.contains(e.relatedTarget)) drop.classList.remove('is-over'); });
  drop.addEventListener('drop', function (e) {
    e.preventDefault();
    drop.classList.remove('is-over');
    pick(e.dataTransfer.files);
  });

  // ── Фото ──────────────────────────────────────────────────────────────
  var photos = [];          // { file, url }
  var shots = $('upShots');
  var photoSend = $('upPhotoSend');
  var photoBar = $('upPhotoBar');

  function paintPhotos() {
    $('upPhotos').hidden = !photos.length;
    shots.innerHTML = photos.map(function (p, i) {
      return '<div class="tk-up__shot"><img src="' + p.url + '" alt="">' +
        '<button type="button" class="tk-thumb__del" data-photo="' + i + '" aria-label="' + escapeHtml(t('common.delete')) + '">' +
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"></path></svg></button></div>';
    }).join('');
    window.tkText(photoSend, 'upload.photosPublish', { n: photos.length });
  }

  function addPhotos(list) {
    if (!list.length) return;
    if (photos.length + list.length > PHOTOS_AT_ONCE) {
      toast(t('user.galleryTooMany', { n: PHOTOS_AT_ONCE }), 'error');
      list = list.slice(0, PHOTOS_AT_ONCE - photos.length);
    }
    list.forEach(function (f) { photos.push({ file: f, url: URL.createObjectURL(f) }); });
    paintPhotos();
  }

  shots.addEventListener('click', function (e) {
    var b = e.target.closest('[data-photo]');
    if (!b || photoSend.disabled) return;
    var p = photos.splice(Number(b.getAttribute('data-photo')), 1)[0];
    URL.revokeObjectURL(p.url);
    paintPhotos();
  });

  // XHR — ради процентов отправки. Пачками по PHOTOS_PER_REQUEST: сервер
  // держит присланное в памяти и больше за раз не принимает
  // (routes/streaming/profile.js). Отправленное уходит из списка сразу —
  // оборвалось на третьей пачке, повтор отправит только оставшееся.
  var PHOTOS_PER_REQUEST = 20;
  photoSend.addEventListener('click', function () {
    if (!photos.length) return;
    var bytes = function (list) { return list.reduce(function (n, p) { return n + p.file.size; }, 0); };
    var total = bytes(photos);
    var done = 0;
    photoSend.disabled = true;
    photoBar.hidden = false;
    photoBar.firstElementChild.style.width = '0%';
    var end = function () { photoSend.disabled = false; photoBar.hidden = true; paintPhotos(); };

    (function next() {
      var part = photos.slice(0, PHOTOS_PER_REQUEST);
      var form = new FormData();
      part.forEach(function (p) { form.append('photos', p.file); });
      var size = bytes(part);
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/profile/gallery');
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) photoBar.firstElementChild.style.width = Math.round((done + e.loaded / e.total * size) / total * 100) + '%';
      };
      xhr.onload = function () {
        var d = {};
        try { d = JSON.parse(xhr.responseText); } catch (_) {}
        if (xhr.status !== 200 || d.success === false) {
          end();
          return toast(t('app.errorShort', { message: d.message || 'HTTP ' + xhr.status }), 'error');
        }
        photos.splice(0, part.length).forEach(function (p) { URL.revokeObjectURL(p.url); });
        done += size;
        if (photos.length) return next();
        end();
        toast(t('app.galleryDone', { total: d.total }), 'ok');
      };
      xhr.onerror = function () { end(); toast(t('common.noNetwork'), 'error'); };
      xhr.send(form);
    })();
  });

  // ── Видео ─────────────────────────────────────────────────────────────
  var list = $('upVideos');
  var tpl = $('upVideoTpl');
  var cards = {};           // id → карточка

  function card(v, file) {
    if (cards[v.id]) return cards[v.id];
    var el = tpl.content.firstElementChild.cloneNode(true);
    el.id = 'v' + v.id;
    list.insertBefore(el, list.firstChild);
    var q = function (s) { return el.querySelector(s); };
    var c = {
      el: el, v: v, dur: 0, cover: v.edit.cover ? 'own' : 'frame',
      video: q('.tk-upv__video'), from: q('.tk-upv__from'), to: q('.tk-upv__to'), at: q('.tk-upv__at'),
      mute: q('.tk-upv__mute'), canvas: q('canvas'), img: q('.tk-upv__covershot img'),
      title: q('.tk-upv__title'), desc: q('.tk-upv__desc'),
    };
    cards[v.id] = c;
    q('.tk-upv__name').textContent = v.name || '';
    c.title.value = v.title || '';
    c.desc.value = v.description || '';
    c.mute.checked = v.edit.mute;
    c.video.muted = v.edit.mute;

    var url = null;
    var withFile = function (f) {
      if (!f) {
        // Файла в этом браузере нет (загружали с другого устройства или
        // браузер его не сохранил): смотреть и резать нечего — остаются
        // звук, своя обложка и «Опубликовать».
        el.classList.add('is-nofile');
        q('.tk-upv__nofile').hidden = false;
        c.video.hidden = true;
        setCover(c, v.edit.cover ? 'own' : 'none');
        return;
      }
      url = URL.createObjectURL(f);
      c.video.src = url;
      // Второй, невидимый — снимать кадры обложки, не сбивая просмотр.
      c.grab = document.createElement('video');
      c.grab.muted = true;
      c.grab.preload = 'auto';
      c.grab.playsInline = true;
      c.grab.src = url;
      c.grab.addEventListener('seeked', function () { frame(c); });
    };
    if (file) withFile(file); else window.TKUpload.file(v.id).then(withFile);

    c.video.addEventListener('loadedmetadata', function () {
      c.dur = isFinite(c.video.duration) ? c.video.duration : 0;
      [c.from, c.to, c.at].forEach(function (r) { r.max = c.dur.toFixed(1); });
      c.from.value = v.edit.start || 0;
      c.to.value = v.edit.end || c.dur;
      c.at.value = v.edit.coverAt >= 0 ? v.edit.coverAt : Math.min(3, c.dur / 2);
      trim(c, null);
      setCover(c, c.cover);
    });
    // Просмотр идёт по кругу внутри обрезки.
    c.video.addEventListener('timeupdate', function () {
      var a = Number(c.from.value), b = Number(c.to.value);
      if (c.video.currentTime > b || c.video.currentTime < a - 0.3) c.video.currentTime = a;
    });

    c.from.addEventListener('input', function () { trim(c, 'from'); });
    c.to.addEventListener('input', function () { trim(c, 'to'); });
    c.at.addEventListener('input', function () { seekGrab(c); });
    c.mute.addEventListener('change', function () { c.video.muted = c.mute.checked; });

    q('.tk-seg').addEventListener('click', function (e) {
      var b = e.target.closest('[data-cover]');
      if (!b || c.locked) return;
      var want = b.getAttribute('data-cover');
      if (want === 'own') return q('.tk-upv__coverfile').click();
      if (c.cover === 'own') json('/upload/video/' + encodeURIComponent(v.id) + '/cover', { method: 'DELETE' }).catch(function () {});
      setCover(c, 'frame');
    });
    q('.tk-upv__coverpick').addEventListener('click', function () { q('.tk-upv__coverfile').click(); });
    q('.tk-upv__coverfile').addEventListener('change', function (e) {
      var f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      var form = new FormData();
      form.append('cover', f);
      json('/upload/video/' + encodeURIComponent(v.id) + '/cover', { method: 'POST', body: form }).then(function () {
        if (c.img.src) URL.revokeObjectURL(c.img.src);
        c.img.src = URL.createObjectURL(f);
        setCover(c, 'own');
      }).catch(function (err) { toast(t('app.errorShort', { message: err.message }), 'error'); });
    });

    q('.tk-upv__publish').addEventListener('click', function () { publish(c); });
    q('.tk-upv__delete').addEventListener('click', function () {
      confirmDialog(t('upload.deleteQ'), { okText: t('common.delete') }).then(function (yes) {
        if (!yes) return;
        window.TKUpload.cancel(v.id);
        json('/profile/gallery/video/' + encodeURIComponent(v.id), { method: 'DELETE' }).catch(function () {});
        if (url) URL.revokeObjectURL(url);
        delete cards[v.id];
        el.remove();
      });
    });

    paint(c);
    return c;
  }

  // Обрезка: начало не заходит за конец (и наоборот) ближе MIN_LEN.
  function trim(c, moved) {
    var a = Number(c.from.value), b = Number(c.to.value);
    if (moved === 'from' && a > b - MIN_LEN) { a = Math.max(0, b - MIN_LEN); c.from.value = a; }
    if (moved === 'to' && b < a + MIN_LEN) { b = Math.min(c.dur, a + MIN_LEN); c.to.value = b; }
    var k = c.dur ? 100 / c.dur : 0;
    var box = c.el.querySelector('.tk-upv__trim');
    box.style.setProperty('--a', (a * k) + '%');
    box.style.setProperty('--b', (b * k) + '%');
    c.el.querySelector('.tk-upv__t0').textContent = clock(a);
    c.el.querySelector('.tk-upv__t1').textContent = clock(b);
    window.tkText(c.el.querySelector('.tk-upv__len'), 'upload.length', { t: clock(b - a) });
    if (moved === 'from') c.video.currentTime = a;
    if (moved === 'to') c.video.currentTime = Math.max(a, b - 2);
    // Кадр обложки — внутри обрезанного.
    c.at.min = a.toFixed(1);
    c.at.max = b.toFixed(1);
    if (Number(c.at.value) < a || Number(c.at.value) > b) { c.at.value = Math.min(b, a + Math.min(3, (b - a) / 2)); seekGrab(c); }
  }

  function seekGrab(c) {
    if (c.grab && c.cover === 'frame') c.grab.currentTime = Number(c.at.value);
  }

  function frame(c) {
    var g = c.grab;
    if (!g.videoWidth) return;
    var cv = c.canvas;
    cv.width = 320;
    cv.height = Math.round(320 * g.videoHeight / g.videoWidth) || 180;
    cv.getContext('2d').drawImage(g, 0, 0, cv.width, cv.height);
  }

  // mode: frame — кадр из видео, own — своя картинка, none — без превью.
  function setCover(c, mode) {
    c.cover = mode === 'none' ? 'frame' : mode;
    c.el.querySelectorAll('[data-cover]').forEach(function (b) { b.setAttribute('aria-checked', String(b.getAttribute('data-cover') === c.cover)); });
    c.at.hidden = mode !== 'frame';
    c.canvas.hidden = mode !== 'frame';
    c.img.hidden = mode !== 'own' || !c.img.src;
    c.el.querySelector('.tk-upv__coverpick').hidden = mode !== 'own';
    c.el.querySelector('.tk-upv__covershot').hidden = mode === 'none' || (mode === 'own' && !c.img.src);
    if (mode === 'frame') seekGrab(c);
  }

  function publish(c) {
    var btn = c.el.querySelector('.tk-upv__publish');
    btn.disabled = true;
    var a = Number(c.from.value) || 0, b = Number(c.to.value) || 0;
    post('/upload/video/' + encodeURIComponent(c.v.id) + '/edit', {
      start: c.dur ? Math.round(a * 10) / 10 : 0,
      // До самого конца — 0: так сервер не гадает о длительности.
      end: c.dur && b < c.dur - 0.2 ? Math.round(b * 10) / 10 : 0,
      mute: c.mute.checked,
      coverAt: c.cover === 'frame' && c.dur ? Math.round(Number(c.at.value) * 10) / 10 : -1,
      title: c.title.value,
      description: c.desc.value,
      publish: true,
    }).then(function (d) {
      c.v = Object.assign(c.v, d.video);
      if (d.video.status === 'processing') window.TKUpload.drop(c.v.id);
      paint(c);
    }).catch(function (err) {
      btn.disabled = false;
      toast(t('app.errorShort', { message: err.message }), 'error');
    });
  }

  // Состояние карточки: полоса, подпись, что можно нажать.
  function paint(c) {
    var v = c.v;
    var job = window.TKUpload.job(v.id);
    var got = job ? job.received + (job.inflight || 0) : v.received;
    var bar = c.el.querySelector('.tk-up__bar');
    var state = c.el.querySelector('.tk-upv__state');
    var done = v.status === 'processing' || v.status === 'ready';
    c.locked = v.publish || done || v.status === 'failed';
    c.el.classList.toggle('is-locked', c.locked);
    c.el.setAttribute('data-status', v.status);
    bar.hidden = v.status !== 'uploading';
    bar.firstElementChild.style.width = (v.size ? Math.min(100, got / v.size * 100) : 0) + '%';
    [c.from, c.to, c.at, c.mute, c.title, c.desc].forEach(function (x) { x.disabled = c.locked; });
    c.el.querySelector('.tk-upv__publish').hidden = c.locked;
    c.el.querySelector('.tk-upv__delete').hidden = done;
    var open = c.el.querySelector('.tk-upv__open');
    open.hidden = v.status !== 'ready';
    open.href = '/video/' + encodeURIComponent(v.id);

    if (v.status === 'uploading' && !job) {
      window.tkText(state, 'upload.lost');
    } else if (v.status === 'uploading') {
      window.tkText(state, v.publish ? 'upload.waiting' : 'upload.progress', {
        p: v.size ? Math.floor(got / v.size * 100) : 0, got: bytes(got), total: bytes(v.size),
      });
    } else if (v.status === 'draft') {
      window.tkText(state, 'upload.uploaded');
    } else if (v.status === 'processing') {
      window.tkText(state, 'upload.processing');
      watch(c);
    } else if (v.status === 'ready') {
      window.tkText(state, 'upload.ready');
    } else if (v.status === 'failed') {
      window.tkText(state, v.error === 'long' ? 'user.videoLong' : 'user.videoFailed');
    }
  }

  // Пережимается — спрашиваем раз в 4 секунды, пока не станет готово.
  function watch(c) {
    if (c.watching) return;
    c.watching = true;
    (function tick() {
      setTimeout(function () {
        if (!cards[c.v.id]) return;
        json('/profile/gallery/video/' + encodeURIComponent(c.v.id)).then(function (d) {
          if (d.video.status === 'processing') return tick();
          c.watching = false;
          c.v.status = d.video.status;
          c.v.error = d.video.error;
          paint(c);
        }, tick);
      }, 4000);
    })();
  }

  // Проценты и смена состояния — от фоновой загрузки (tk-upload.js).
  document.addEventListener('tk:upload', function (e) {
    var d = e.detail;
    var c = cards[d.id];
    if (!c) return;
    if (d.status === 'gone') { delete cards[d.id]; c.el.remove(); return; }
    if (d.status === 'failed') toast(t('app.errorShort', { message: d.error }), 'error');
    c.v.status = d.status;
    c.v.error = d.error;
    c.v.received = d.received;
    paint(c);
  });

  // Уход со страницы — загрузке не помеха (она продолжится на следующей).
  // Кроме случая, когда браузер не сохранил файл: тогда уход её оборвёт.
  window.addEventListener('beforeunload', function (e) {
    if (window.TKUpload && window.TKUpload.unsaved()) { e.preventDefault(); e.returnValue = ''; }
  });

  // Незаконченное с прошлых раз — после того, как фоновая загрузка подняла
  // своё из браузера: иначе черновик в пути выглядел бы брошенным.
  window.TKUpload.ready.then(function () {
    D.drafts.slice().reverse().forEach(function (v) { card(v, null); });
    if (location.hash) {
      var el = document.querySelector(location.hash);
      if (el) el.scrollIntoView({ block: 'start' });
    }
  });
  paintPhotos();
})();
