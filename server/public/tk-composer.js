// «Новый пост» (09.10.2026, partials/composer.ejs): текст, фото, видео, тема.
//
// Видео начинает ехать сразу, как выбрано, — фоновой загрузкой кусками
// (tk-upload.js): ролик в сотни мегабайт не должен держать форму, и уход
// со страницы загрузку не обрывает. Пост уходит с id черновиков, сервер
// отдаёт им «Опубликовать» (utils/posts.js) — доедут и пережмутся, пост
// появится в ленте. Фото — файлами вместе с постом (routes/posts.js).
// Порядок кадров — порядок выбора.
//
// После публикации страница перезагружается: новый пост — первым в ленте
// (у автора — и пока его ролики пережимаются). Что вышло — тостом после
// перезагрузки (tkNoticeNext, tk-app.js).
(function () {
  'use strict';

  var form = document.getElementById('composer');
  if (!form) return;

  var MAX = 10;              // фото и видео в посте — utils/posts.js, MEDIA_MAX
  var PHOTO_MB = 10;         // фото галереи — routes/streaming/uploads.js
  var openBtn = form.querySelector('[data-compose-open]');
  var body = form.querySelector('.tk-compose__body');
  var text = form.elements.text;
  var box = form.querySelector('[data-compose-media]');
  var input = form.querySelector('[data-compose-file]');
  var submit = form.querySelector('[type="submit"]');
  var video = !!form.dataset.video;
  var items = [];            // { kind: 'photo', file, url } | { kind: 'video', id, file, url, done }
  var busy = false;

  function open(on) {
    body.hidden = !on;
    openBtn.hidden = on;
    form.classList.toggle('is-open', on);
    if (on) text.focus();
  }

  openBtn.addEventListener('click', function () { open(true); });

  // Из системного «Поделиться» (/share → ?compose=1&text=): форма открыта
  // и текст уже в ней; из адреса параметры убираем — перезагрузка после
  // публикации не должна открыть её снова.
  var q = new URLSearchParams(location.search);
  if (q.get('compose') === '1') {
    text.value = q.get('text') || '';
    open(true);
    q.delete('compose');
    q.delete('text');
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));
  }

  // Отмена — всё прочь: и фото, и уже начатые ролики (черновик на сервере
  // тоже, иначе он висел бы до уборки через три дня).
  form.querySelector('[data-compose-cancel]').addEventListener('click', function () {
    items.slice().forEach(drop);
    text.value = '';
    form.elements.topic.value = '';
    open(false);
  });

  // Ролик в работе: проценты на плитке, пока едет.
  document.addEventListener('tk:upload', function (e) {
    var d = e.detail || {};
    items.forEach(function (it) {
      if (it.kind !== 'video' || it.id !== d.id) return;
      it.done = d.status !== 'uploading';
      var bar = it.el.querySelector('i');
      if (bar && d.size) bar.style.width = Math.round(100 * d.received / d.size) + '%';
      it.el.classList.toggle('is-done', it.done);
    });
  });

  function tile(it) {
    var el = document.createElement('div');
    el.className = 'tk-compose__tile tk-compose__tile--' + it.kind;
    el.innerHTML = (it.kind === 'photo' ? '<img alt="">' : '<video muted playsinline preload="metadata"></video><span class="tk-compose__bar-up"><i></i></span>') +
      '<button type="button" class="tk-compose__drop" aria-label="' + escapeHtml(t('common.delete')) + '" title="' + escapeHtml(t('common.delete')) + '">' +
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"></path></svg></button>';
    el.firstChild.src = it.url;
    el.querySelector('.tk-compose__drop').addEventListener('click', function () { drop(it); });
    it.el = el;
    box.appendChild(el);
    box.hidden = false;
  }

  function drop(it) {
    items.splice(items.indexOf(it), 1);
    if (it.el) it.el.remove();
    URL.revokeObjectURL(it.url);
    box.hidden = !items.length;
    if (it.kind === 'video' && it.id) {
      if (window.TKUpload) window.TKUpload.cancel(it.id);
      tkFetch('/video/' + encodeURIComponent(it.id), { method: 'DELETE', credentials: 'same-origin' }).catch(function () {});
    }
  }

  function add(files) {
    var room = MAX - items.length;
    var list = Array.prototype.slice.call(files);
    if (list.length > room) toast(t('post.mediaLimit', { n: MAX }));
    list.slice(0, Math.max(0, room)).forEach(function (file) {
      if (/^video\//.test(file.type)) {
        if (!video || !window.TKUpload) return toast(t('post.videoOff'), 'error');
        var it = { kind: 'video', file: file, url: URL.createObjectURL(file), done: false };
        items.push(it);
        tile(it);
        // Черновик и загрузка — сразу; не завёлся — плитка уходит со словами.
        window.TKUpload.add(file).then(function (v) { it.id = v.id; }, function (err) {
          toast(err.message || t('post.videoFailed'), 'error');
          drop(it);
        });
        return;
      }
      var why = TKNet.image(file, PHOTO_MB);
      if (why) return toast(why, 'error');
      var p = { kind: 'photo', file: file, url: URL.createObjectURL(file) };
      items.push(p);
      tile(p);
    });
  }

  input.addEventListener('change', function () { add(input.files); input.value = ''; });
  form.addEventListener('dragover', function (e) { e.preventDefault(); form.classList.add('is-over'); });
  form.addEventListener('dragleave', function () { form.classList.remove('is-over'); });
  form.addEventListener('drop', function (e) {
    e.preventDefault();
    form.classList.remove('is-over');
    open(true);
    add(e.dataTransfer.files);
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var words = text.value.trim();
    if (!words && !items.length) { text.focus(); return; }
    // Черновик ролика ещё заводится — секунда, и id будет.
    if (items.some(function (it) { return it.kind === 'video' && !it.id; })) return toast(t('post.videoWait'));
    var data = new FormData();
    data.append('text', words);
    data.append('topic', form.elements.topic.value);
    var photos = 0;
    var order = items.map(function (it) {
      if (it.kind === 'video') return 'v' + it.id;
      data.append('photos', it.file);
      return 'p' + photos++;
    });
    data.append('videos', JSON.stringify(items.filter(function (it) { return it.kind === 'video'; }).map(function (it) { return it.id; })));
    data.append('order', JSON.stringify(order));

    busy = true;
    submit.disabled = true;
    tkText(submit, 'post.publishing');
    tkFetch('/posts', { method: 'POST', body: data, credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw new Error(d.message || TKNet.explain(r));
          return d;
        });
      })
      .then(function (d) {
        window.tkNoticeNext(d.status === 'processing' ? 'post.sentVideo' : 'post.sent', 'ok');
        location.reload();
      })
      .catch(function (err) {
        busy = false;
        submit.disabled = false;
        tkText(submit, 'post.publish');
        toast(err.message, 'error');
      });
  });
})();
