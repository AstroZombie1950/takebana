/* Фоновая загрузка видео в галерею — с любой страницы сайта (21.09.2026).
 *
 * Раньше ролик уходил одним запросом со страницы профиля, и уход с неё
 * обрывал загрузку целиком: заказчик потерял так 400 МБ видео. Сайт
 * многостраничный — запрос живёт, пока жива страница, — поэтому загрузка
 * здесь устроена иначе:
 *
 *   — файл уходит кусками (PUT /upload/video/:id?offset=N, размер куска
 *     задаёт сервер), и сервер помнит, сколько доехало;
 *   — сам файл лежит в IndexedDB браузера, пока не доедет целиком;
 *   — на каждой странице tk-app.js, увидев метку в localStorage, подгружает
 *     этот скрипт, и загрузка продолжается с того же байта. Переход по ссылке
 *     теряет только кусок, который был в пути.
 *
 * Две вкладки не качают одно и то же: Web Locks держит загрузку за одной,
 * сервер вдобавок отвергает кусок не с того места (409).
 *
 * Снаружи: TKUpload.add(file) → черновик { id, … }; события tk:upload
 * в document — { id, status, received, size, name } на каждом шаге.
 * Плашка с процентами внизу экрана — на всех страницах, кроме /upload.
 */
(function () {
  if (window.TKUpload) return;

  var FLAG = 'tk.uploads';
  var DB_NAME = 'tk-upload';
  var STORE = 'files';
  var jobs = {};            // id → { id, name, size, received, status, chunk, file, running }

  // ── IndexedDB: файл черновика, пока не доехал ──
  var dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(STORE, { keyPath: 'id' }); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }
    return dbPromise;
  }

  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(STORE, mode);
        var out = fn(t.objectStore(STORE));
        t.oncomplete = function () { resolve(out && out.result); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  var save = function (rec) { return tx('readwrite', function (s) { return s.put(rec); }); };
  var drop = function (id) { return tx('readwrite', function (s) { return s.delete(id); }).catch(function () {}); };
  var every = function () { return tx('readonly', function (s) { return s.getAll(); }); };

  // Метка для tk-app.js: есть что докачивать — подгрузить этот скрипт.
  function mark() {
    var busy = Object.keys(jobs).some(function (id) { return jobs[id].status === 'uploading'; });
    try { if (busy) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch (e) {}
  }

  function emit(job) {
    document.dispatchEvent(new CustomEvent('tk:upload', {
      detail: { id: job.id, status: job.status, received: job.received, size: job.size, name: job.name, error: job.error || '' },
    }));
    chip();
  }

  // ── Плашка «Загрузка видео 45%» ──
  // На /upload не нужна: там всё видно и так.
  var chipEl = null;
  function chip() {
    if (location.pathname === '/upload') return;
    var list = Object.keys(jobs).map(function (id) { return jobs[id]; }).filter(function (j) { return j.status === 'uploading'; });
    if (!list.length) { if (chipEl) chipEl.hidden = true; return; }
    var size = 0, got = 0;
    list.forEach(function (j) { size += j.size; got += j.received + (j.inflight || 0); });
    var p = size ? Math.min(99, Math.floor(got / size * 100)) : 0;
    if (!chipEl) {
      chipEl = document.createElement('a');
      chipEl.href = '/upload';
      chipEl.className = 'tk-upchip';
      chipEl.innerHTML = '<span class="tk-upchip__ring" aria-hidden="true"></span><span class="tk-upchip__text"></span>';
      document.body.appendChild(chipEl);
    }
    chipEl.hidden = false;
    chipEl.style.setProperty('--p', p / 100);
    var text = chipEl.querySelector('.tk-upchip__text');
    if (window.tkText) window.tkText(text, 'upload.chip', { p: p });
    else text.textContent = p + '%';
  }

  function json(url, options) {
    options = options || {};
    options.headers = Object.assign({ Accept: 'application/json' }, options.headers);
    return fetch(url, options).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || d.success === false) {
          var e = new Error(d.message || 'HTTP ' + r.status);
          e.status = r.status;
          throw e;
        }
        return d;
      });
    });
  }

  // Один кусок: XHR, а не fetch — у fetch нет прогресса отправки, а без него
  // проценты на медленной сети стояли бы по полминуты.
  function sendChunk(job) {
    return new Promise(function (resolve) {
      var end = Math.min(job.size, job.received + job.chunk);
      var xhr = new XMLHttpRequest();
      job.xhr = xhr;
      xhr.open('PUT', '/upload/video/' + encodeURIComponent(job.id) + '?offset=' + job.received);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.onprogress = function (e) { job.inflight = e.loaded; emit(job); };
      xhr.onload = function () {
        var d = {};
        try { d = JSON.parse(xhr.responseText); } catch (_) {}
        resolve({ status: xhr.status, body: d });
      };
      xhr.onerror = xhr.onabort = xhr.ontimeout = function () { resolve({ status: 0, body: {} }); };
      xhr.send(job.file.slice(job.received, end));
    }).then(function (r) { job.xhr = null; job.inflight = 0; return r; });
  }

  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // Доехал, но не опубликован (draft) — файл остаётся в браузере: страница
  // загрузки показывает по нему превью и кадры обложки. Опубликован или
  // пропал — больше не нужен.
  function finish(job, status, error) {
    job.status = status;
    job.error = error || '';
    job.file = null;
    emit(job);
    if (status !== 'draft') drop(job.id);
    delete jobs[job.id];
    mark();
  }

  // Качать, пока не доедет. Сеть пропала — ждём и пробуем снова, с растущей
  // паузой; вернулась (событие online) — сразу.
  function pump(job) {
    var pause = 1000;
    function step() {
      if (!jobs[job.id]) return Promise.resolve();
      if (job.received >= job.size) return Promise.resolve();
      return sendChunk(job).then(function (r) {
        if (r.status === 200 && r.body.video) {
          pause = 1000;
          job.received = r.body.video.received;
          job.status = r.body.video.status;
          emit(job);
          if (job.status !== 'uploading') return finish(job, job.status);
          return step();
        }
        if (r.status === 409 && typeof r.body.received === 'number') {
          job.received = r.body.received;
          return (r.body.busy ? wait(2000) : Promise.resolve()).then(step);
        }
        // Кусок дошёл не целиком — сервер говорит, откуда повторить.
        if (r.status === 400 && typeof r.body.received === 'number') {
          job.received = r.body.received;
          return wait(pause).then(function () { pause = Math.min(pause * 2, 30000); return step(); });
        }
        // Черновик удалили (на профиле или в другой вкладке) — всё.
        if (r.status === 404) return finish(job, 'gone');
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
          return finish(job, 'failed', r.body.message || 'HTTP ' + r.status);
        }
        emit(job);
        return Promise.race([wait(pause), new Promise(function (res) { window.addEventListener('online', res, { once: true }); })])
          .then(function () { pause = Math.min(pause * 2, 30000); return step(); });
      });
    }
    return step();
  }

  function run(job) {
    if (job.running) return;
    job.running = true;
    var go = function () { return pump(job).then(function () { job.running = false; }); };
    // Вторая вкладка не берётся за то, что уже качает первая: она
    // просто показывает проценты из событий своей страницы (/upload спросит
    // сервер сам).
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request('tk-upload-' + job.id, { ifAvailable: true }, function (lock) {
        // Качает другая вкладка. Закроют её — подхватим.
        if (!lock) { job.running = false; setTimeout(function () { if (jobs[job.id]) run(job); }, 5000); return null; }
        return go();
      });
    } else {
      go();
    }
  }

  // Новый файл: черновик на сервере, файл — в IndexedDB, и поехали.
  // Не удалось сохранить файл в браузере (приватный режим, нет места) —
  // качаем с этой страницы, и уход с неё предупреждает (upload.js).
  function add(file) {
    return json('/upload/video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name.slice(0, 200), size: file.size }),
    }).then(function (d) {
      var job = { id: d.video.id, name: file.name, size: file.size, received: 0, status: 'uploading', chunk: d.chunk, file: file };
      jobs[job.id] = job;
      mark();
      return save({ id: job.id, name: job.name, size: job.size, chunk: job.chunk, file: file })
        .then(function () { job.saved = true; }, function () { job.saved = false; })
        .then(function () { run(job); emit(job); return d.video; });
    });
  }

  function cancel(id) {
    var job = jobs[id];
    if (!job) return drop(id);
    if (job.xhr) job.xhr.abort();
    finish(job, 'gone');
  }

  // Докачать то, что лежит в IndexedDB: спросить сервер, сколько доехало.
  function resume() {
    return every().then(function (recs) {
      return Promise.all((recs || []).map(function (rec) {
        if (jobs[rec.id]) return null;
        return json('/upload/video/' + encodeURIComponent(rec.id)).then(function (d) {
          if (d.video.status === 'draft') return null;
          if (d.video.status !== 'uploading') return drop(rec.id);
          var job = { id: rec.id, name: rec.name, size: rec.size, received: d.video.received, status: 'uploading', chunk: rec.chunk, file: rec.file, saved: true };
          jobs[job.id] = job;
          run(job);
          emit(job);
        }, function (e) { if (e.status === 404) return drop(rec.id); });
      }));
    }).catch(function () {}).then(mark);
  }

  var ready = window.indexedDB ? resume() : Promise.resolve();

  window.TKUpload = {
    add: add,
    cancel: cancel,
    // Докачка того, что лежало в браузере, запущена (или её нет).
    ready: ready,
    job: function (id) { return jobs[id] || null; },
    // Файл черновика из браузера — для превью; нет — null.
    file: function (id) {
      if (jobs[id] && jobs[id].file) return Promise.resolve(jobs[id].file);
      return tx('readonly', function (s) { return s.get(id); }).then(function (r) { return r ? r.file : null; }, function () { return null; });
    },
    drop: drop,
    // Есть ли загрузки, которые живут только на этой странице.
    unsaved: function () { return Object.keys(jobs).some(function (id) { return jobs[id].status === 'uploading' && !jobs[id].saved; }); },
  };
})();
