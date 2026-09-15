/* Студия эфира: настройки, источник (браузер или OBS), камера с предпросмотром.
 * «Выйти в эфир» отправляет настройки (/start-stream) и открывает пульт
 * с ?go=1 — дальше камеру подключает /tk-console.js.
 *
 * Разметка — views/streamPage.ejs (фаза setup). Раньше настройки были окном
 * в tk-app.js, а камера и источник — на отдельной странице пульта.
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var form = $('studioForm');
  var go = $('studioGo');
  var select = $('cameraSelect');
  var video = $('previewVideo');
  var hint = $('previewHint');
  var media = null;
  // Камера, выбранная в прошлый раз: до разрешения браузер списка не отдаёт.
  var saved = '';
  try { saved = localStorage.getItem('tk_camera') || ''; } catch (e) {}

  function source() { return form.elements.source.value; }

  // ── Источник ──────────────────────────────────────────────────────────
  function showSource() {
    var web = source() === 'web';
    document.querySelectorAll('[data-for]').forEach(function (el) {
      el.hidden = el.getAttribute('data-for') !== source();
    });
    tkText(go, web ? 'studio.go' : 'studio.goObs');
    if (web) startPreview(); else stopPreview();
  }
  form.addEventListener('change', function (e) {
    if (e.target.name === 'source') showSource();
  });

  // ── Предпросмотр камеры ───────────────────────────────────────────────
  function stopPreview() {
    if (media) media.getTracks().forEach(function (track) { track.stop(); });
    media = null;
    video.hidden = true;
    hint.hidden = false;
  }

  // Камера в списке: «device:<id>», а если браузер список не отдал (iOS) —
  // «facing:user» или «facing:environment». То же понимает пульт. Пожелание,
  // а не требование: камеру могли отключить — тогда возьмётся другая.
  function constraint(value) {
    if (!value) return true;
    var v = value.slice(value.indexOf(':') + 1);
    return value.indexOf('device:') === 0 ? { deviceId: v } : { facingMode: v };
  }

  function startPreview() {
    if (!navigator.mediaDevices || source() !== 'web') return;
    stopPreview();
    navigator.mediaDevices.getUserMedia({ video: constraint(select.value || saved), audio: true })
      .then(function (m) {
        if (source() !== 'web') { m.getTracks().forEach(function (track) { track.stop(); }); return; }
        media = m;
        video.srcObject = m;
        video.hidden = false;
        hint.hidden = true;
        return fillCameras();
      })
      .catch(function (err) {
        toast(err.name === 'NotAllowedError' ? t('stream.mediaDenied') : t('stream.mediaFailed', { error: err.name }), 'error');
      });
  }

  // Названия камер браузер отдаёт только после разрешения — поэтому список
  // собирается после первого предпросмотра. Выбор уходит пульту в localStorage.
  function fillCameras() {
    return navigator.mediaDevices.enumerateDevices().then(function (devices) {
      var cams = devices.filter(function (d) { return d.kind === 'videoinput'; });
      var current = media && media.getVideoTracks()[0] && media.getVideoTracks()[0].getSettings().deviceId;
      var options = cams.length
        ? cams.map(function (c, i) { return ['device:' + c.deviceId, c.label ? null : 'stream.cameraN', { n: i + 1 }, c.label]; })
        : [['facing:user', 'stream.cameraFront'], ['facing:environment', 'stream.cameraBack']];
      var was = current ? 'device:' + current : select.value;
      select.replaceChildren.apply(select, options.map(function (o) {
        var option = new Option(o[1] ? t(o[1], o[2]) : o[3], o[0]);
        if (o[1]) {
          option.setAttribute('data-i18n', o[1]);
          option.setAttribute('data-i18n-vars', JSON.stringify(o[2] || {}));
        }
        return option;
      }));
      if (options.some(function (o) { return o[0] === was; })) select.value = was;
    }).catch(function () {});
  }

  select.addEventListener('change', function () {
    saved = select.value;
    try { localStorage.setItem('tk_camera', saved); } catch (e) {}
    startPreview();
  });

  // ── Подкатегории ──────────────────────────────────────────────────────
  // Список — из config/catalog.js атрибутом data-subs: [[код, подпись], …].
  // Подпись из атрибута русская; на английском её отдаёт словарь sub.<код>.
  var category = $('streamCategory');
  var sub = $('streamSubcategory');
  var subs = JSON.parse(sub.dataset.subs || '{}');

  function fillSubs(value) {
    var list = subs[category.value];
    sub.disabled = !list;
    var firstKey = list ? 'studio.subcategoryPick' : 'studio.subcategoryPh';
    var first = new Option(t(firstKey), '');
    first.setAttribute('data-i18n', firstKey);
    sub.replaceChildren.apply(sub, [first].concat((list || []).map(function (s) {
      var option = new Option(t('sub.' + s[0], s[1]), s[0]);
      option.setAttribute('data-i18n', 'sub.' + s[0]);
      return option;
    })));
    if (value && list && list.some(function (s) { return s[0] === value; })) sub.value = value;
  }
  category.addEventListener('change', function () { fillSubs(''); });
  fillSubs(sub.dataset.value);

  // ── Выйти в эфир ──────────────────────────────────────────────────────
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = form.elements;
    if (!f.title.value.trim() || !f.category.value || !f.subcategory.value) {
      toast(t('studio.fields'), 'error');
      return;
    }
    go.disabled = true;
    fetch('/start-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: f.title.value.trim(),
        category: f.category.value,
        subcategory: f.subcategory.value,
        city: f.city.value,
        description: f.description.value.trim(),
        isAdult: f.isAdult.checked,
        source: source()
      })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (res.b.streamId) {
          // Камеру освобождаем до перехода: на телефоне её держит один владелец.
          stopPreview();
          location.href = '/stream/' + res.b.streamId + (res.ok && source() === 'web' ? '?go=1' : '');
          return;
        }
        throw new Error(res.b.message || 'HTTP');
      })
      .catch(function (err) {
        go.disabled = false;
        toast(t('app.errorShort', { message: err.message }), 'error');
      });
  });

  showSource();
})();
