/* Кадрирование картинки перед загрузкой (24.09): аватар, обложка эфира,
 * своя обложка видео. Сервер подгоняет картинку под формат сам (utils/
 * image.js, fit: cover) — но всегда по центру, и лицо на портретном фото
 * уезжало из квадрата аватара, а главное на обложке — из 16:9.
 *
 * window.tkCrop(file, { aspect, max, alpha }) → Promise<File|null>
 *   aspect — ширина к высоте кадра (1 — квадрат, 16 / 9 — обложка);
 *   max    — ширина результата не больше (сервер всё равно сожмёт до своей);
 *   alpha  — сохранить прозрачность (аватар-логотип на прозрачном фоне).
 * null — человек передумал. Картинка уже нужной формы — окна нет, файл
 * возвращается как есть: выбирать нечего.
 *
 * Окно — общая модалка кабинета (.tk-modal, app.css). Кадр стоит по центру
 * сцены, картинку под ним двигают пальцем или мышью и приближают щипком,
 * колесом или ползунком; стрелки и +/− — с клавиатуры. Картинка всегда
 * закрывает кадр целиком: пустых полос в результате не бывает.
 */
(function () {
  var t = function (k, v) { return window.t ? window.t(k, v) : k; };
  var ZOOM = 4;             // во сколько раз можно приблизить от «влезает в кадр»

  function load(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error(t('app.fileBad'))); };
      img.src = url;
    });
  }

  // Результат: webp, где браузер его пишет; иначе PNG (нужна прозрачность)
  // или JPEG. Safari до 17-й версии webp из canvas не отдаёт — молча PNG.
  function encode(canvas, alpha) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        if (blob && blob.type === 'image/webp') return resolve(blob);
        canvas.toBlob(resolve, alpha ? 'image/png' : 'image/jpeg', 0.92);
      }, 'image/webp', 0.92);
    });
  }

  function tkCrop(file, opts) {
    var aspect = opts.aspect || 1;
    return load(file).then(function (src) {
      var img = src.img;
      var W = img.naturalWidth, H = img.naturalHeight;
      if (Math.abs(W / H - aspect) / aspect < 0.01) {
        URL.revokeObjectURL(src.url);
        return file;
      }
      return open(file, src, W, H, aspect, opts);
    });
  }

  function open(file, src, W, H, aspect, opts) {
    return new Promise(function (resolve) {
      var box = document.createElement('div');
      box.className = 'tk-modal';
      box.innerHTML =
        '<div class="tk-modal__card tk-crop" role="dialog" aria-modal="true" aria-labelledby="tkCropTitle">' +
          '<div class="tk-modal__head">' +
            '<h3 class="tk-modal__title" id="tkCropTitle">' + escapeHtml(t('crop.title')) + '</h3>' +
            '<button type="button" class="tk-modal__close" data-crop="cancel" aria-label="' + escapeHtml(t('common.close')) + '">' +
              '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"></path></svg></button>' +
          '</div>' +
          '<div class="tk-crop__stage" tabindex="0" aria-label="' + escapeHtml(t('crop.hint')) + '">' +
            '<img class="tk-crop__img" alt="" draggable="false">' +
            '<div class="tk-crop__frame" aria-hidden="true"></div>' +
          '</div>' +
          '<div class="tk-modal__body tk-crop__body">' +
            '<p class="tk-note">' + escapeHtml(t('crop.hint')) + '</p>' +
            '<label class="tk-crop__zoom"><span>' + escapeHtml(t('crop.zoom')) + '</span>' +
              '<input type="range" min="0" max="1000" value="0" data-crop="zoom"></label>' +
          '</div>' +
          '<div class="tk-modal__foot tk-crop__foot">' +
            '<button type="button" class="tk-btn tk-btn--outline tk-btn--sm" data-crop="cancel">' + escapeHtml(t('common.cancel')) + '</button>' +
            '<button type="button" class="tk-btn tk-btn--primary tk-btn--sm" data-crop="done">' + escapeHtml(t('crop.done')) + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(box);

      var stage = box.querySelector('.tk-crop__stage');
      var frameEl = box.querySelector('.tk-crop__frame');
      var imgEl = box.querySelector('.tk-crop__img');
      var zoomEl = box.querySelector('[data-crop="zoom"]');
      imgEl.src = src.url;

      // Кадр в точках сцены; s — точек сцены на пиксель картинки;
      // x, y — где левый верхний угол картинки относительно угла кадра.
      var fw = 0, fh = 0, fx = 0, fy = 0, s = 1, minS = 1, x = 0, y = 0;

      function layout() {
        var sw = stage.clientWidth, sh = stage.clientHeight;
        var pad = 24;
        fw = Math.min(sw - pad * 2, (sh - pad * 2) * aspect);
        fh = fw / aspect;
        fx = (sw - fw) / 2;
        fy = (sh - fh) / 2;
        frameEl.style.cssText = 'left:' + fx + 'px;top:' + fy + 'px;width:' + fw + 'px;height:' + fh + 'px';
      }

      // Центр кадра в координатах картинки — чтобы при смене размера окна
      // кадр остался на том же месте снимка.
      function centre() { return { u: (fw / 2 - x) / s, v: (fh / 2 - y) / s }; }

      function clamp() {
        s = Math.min(Math.max(s, minS), minS * ZOOM);
        x = Math.min(0, Math.max(fw - W * s, x));
        y = Math.min(0, Math.max(fh - H * s, y));
      }

      function paint() {
        clamp();
        imgEl.style.transform = 'translate(' + (fx + x) + 'px,' + (fy + y) + 'px) scale(' + s + ')';
        zoomEl.value = String(Math.round(Math.log(s / minS) / Math.log(ZOOM) * 1000));
      }

      // Приблизить к точке (px, py) в координатах кадра: она остаётся на месте.
      function zoomTo(next, px, py) {
        var u = (px - x) / s, v = (py - y) / s;
        s = Math.min(Math.max(next, minS), minS * ZOOM);
        x = px - u * s;
        y = py - v * s;
        paint();
      }

      function fit(keep) {
        var c = keep ? centre() : null;
        var ratio = s / minS;
        layout();
        minS = Math.max(fw / W, fh / H);
        s = minS * (keep ? ratio : 1);
        if (c) { x = fw / 2 - c.u * s; y = fh / 2 - c.v * s; }
        else { x = (fw - W * s) / 2; y = (fh - H * s) / 2; }
        paint();
      }
      fit(false);

      // ── Жесты ──────────────────────────────────────────────────────────
      // Указатели по id: один — тащим, два — щипок (масштаб по расстоянию
      // между пальцами, точка — середина между ними).
      var ptrs = {};
      var pinch = null;
      function pt(e) { var r = stage.getBoundingClientRect(); return { x: e.clientX - r.left - fx, y: e.clientY - r.top - fy }; }
      function two() { var k = Object.keys(ptrs); return k.length === 2 ? [ptrs[k[0]], ptrs[k[1]]] : null; }
      function dist(p) { return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); }

      stage.addEventListener('pointerdown', function (e) {
        stage.setPointerCapture(e.pointerId);
        ptrs[e.pointerId] = pt(e);
        var p = two();
        pinch = p ? { d: dist(p), s: s } : null;
        stage.classList.add('is-drag');
      });
      stage.addEventListener('pointermove', function (e) {
        var was = ptrs[e.pointerId];
        if (!was) return;
        var now = pt(e);
        ptrs[e.pointerId] = now;
        var p = two();
        if (p && pinch) {
          zoomTo(pinch.s * dist(p) / pinch.d, (p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2);
        } else if (!p) {
          x += now.x - was.x;
          y += now.y - was.y;
          paint();
        }
      });
      function up(e) {
        delete ptrs[e.pointerId];
        var p = two();
        pinch = p ? { d: dist(p), s: s } : null;
        if (!Object.keys(ptrs).length) stage.classList.remove('is-drag');
      }
      stage.addEventListener('pointerup', up);
      stage.addEventListener('pointercancel', up);

      stage.addEventListener('wheel', function (e) {
        e.preventDefault();
        var p = pt(e);
        zoomTo(s * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
      }, { passive: false });

      zoomEl.addEventListener('input', function () {
        zoomTo(minS * Math.pow(ZOOM, zoomEl.value / 1000), fw / 2, fh / 2);
      });

      stage.addEventListener('keydown', function (e) {
        var step = e.shiftKey ? 40 : 10;
        var k = e.key;
        if (k === 'ArrowLeft') x += step;
        else if (k === 'ArrowRight') x -= step;
        else if (k === 'ArrowUp') y += step;
        else if (k === 'ArrowDown') y -= step;
        else if (k === '+' || k === '=') return zoomTo(s * 1.1, fw / 2, fh / 2);
        else if (k === '-') return zoomTo(s / 1.1, fw / 2, fh / 2);
        else return;
        e.preventDefault();
        paint();
      });

      function onResize() { fit(true); }
      window.addEventListener('resize', onResize);

      // ── Итог ───────────────────────────────────────────────────────────
      function finish(result) {
        window.removeEventListener('resize', onResize);
        document.removeEventListener('keydown', onKey, true);
        box.remove();
        URL.revokeObjectURL(src.url);
        resolve(result);
      }

      function onKey(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
      document.addEventListener('keydown', onKey, true);

      box.addEventListener('click', function (e) {
        var b = e.target.closest('[data-crop]');
        if (!b || b.tagName === 'INPUT') return;
        if (b.getAttribute('data-crop') === 'cancel') return finish(null);
        b.disabled = true;
        // Кусок снимка под кадром. Пикселей не выдумываем: результат не
        // больше того, что реально попало в кадр.
        var sw = fw / s, sh = fh / s;
        var ow = Math.round(Math.min(opts.max || 2048, sw));
        var oh = Math.round(ow / aspect);
        var canvas = document.createElement('canvas');
        canvas.width = ow;
        canvas.height = oh;
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src.img, -x / s, -y / s, sw, sh, 0, 0, ow, oh);
        encode(canvas, !!opts.alpha).then(function (blob) {
          if (!blob) return finish(file);
          var ext = blob.type.split('/')[1].replace('jpeg', 'jpg');
          finish(new File([blob], (file.name || 'image').replace(/\.[^.]+$/, '') + '.' + ext, { type: blob.type }));
        });
      });

      box.querySelector('[data-crop="done"]').focus();
    });
  }

  window.tkCrop = tkCrop;
})();
