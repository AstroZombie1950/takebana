/* Плеер Takebana: эфир, запись эфира, будущие загрузки видео.
 * Разметка — views/partials/player.ejs, вёрстка — css/player.css.
 *
 * Родных кнопок браузера нет: с ними уходила кнопка «Скачать». Полностью
 * видео так не спрятать — адрес виден в инструментах разработчика, — но
 * защита у нас в кадре: водяной знак (utils/hls.js).
 *
 * Источник: MP4 или плейлист HLS. Плейлист собирает hls.js (/tk-hls.js,
 * TKHls.load), свой HLS браузера — только где нет MediaSource. Качество
 * выбирается, когда источник отдаёт несколько и играет hls.js.
 *
 * TKPlayer.mount(root) → { video, attachHls(hls) }. Эфир подключает свой
 * hls.js сам (tk-viewer.js) и передаёт его сюда — ради качества и живого края.
 */
(function () {
  var t = function (key, arg) { return window.t ? window.t(key, arg) : key; };
  var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  var IDLE_MS = 2500;
  var SEEK_STEP = 10;
  // Эфир отстал от живого края больше чем на это — кнопка «В эфир» гаснет.
  var LIVE_LAG_S = 10;

  // Громкость и скорость помнятся между страницами. Хранилище может
  // быть недоступно (приватное окно) — тогда просто не помним.
  function load(key, def) {
    try { var v = localStorage.getItem('tk.player.' + key); return v === null ? def : JSON.parse(v); } catch (_) { return def; }
  }
  function save(key, v) {
    try { localStorage.setItem('tk.player.' + key, JSON.stringify(v)); } catch (_) {}
  }

  function clock(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return h ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
  }

  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement; }

  function typing(el) {
    return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  function mount(root) {
    var video = root.querySelector('video');
    var live = root.dataset.mode === 'live';
    var q = function (s) { return root.querySelector(s); };
    var qa = function (s) { return Array.prototype.slice.call(root.querySelectorAll(s)); };

    var progress = q('.tk-player__progress');
    var played = q('.tk-player__played');
    var buffered = q('.tk-player__buffered');
    var tip = q('.tk-player__tip');
    var cur = q('.tk-player__cur');
    var dur = q('.tk-player__dur');
    var volume = q('.tk-player__volume');
    var menu = q('.tk-player__menu');
    var menuBtn = q('[data-act="settings"]');
    var liveBtn = q('.tk-player__live');
    var spinner = q('.tk-player__spinner');
    var errorBox = q('.tk-player__error');
    var unmuteBtn = q('.tk-player__unmute');
    var hls = null;
    var coarse = window.matchMedia('(pointer: coarse)').matches;

    // ── Источник ──
    // Плейлист — через hls.js везде, где есть MediaSource (и iPhone с iOS 17.1,
    // у него ManagedMediaSource): только так есть выбор качества. Свой HLS
    // браузера — запасной путь: старые iPhone, где MediaSource нет вовсе.
    function useSource(src, ready) {
      var mse = window.MediaSource || window.ManagedMediaSource;
      if (!/\.m3u8(\?|$)/.test(src) || !mse) {
        video.src = src;
        return ready();
      }
      TKHls.load().then(function (Hls) {
        if (!Hls.isSupported()) {
          video.src = src;
          return ready();
        }
        var h = new Hls({ capLevelToPlayerSize: true, startLevel: -1 });
        h.once(Hls.Events.MANIFEST_PARSED, ready);
        h.on(Hls.Events.ERROR, function (_e, d) {
          if (!d.fatal) return;
          if (d.type === Hls.ErrorTypes.MEDIA_ERROR) h.recoverMediaError();
          else showError();
        });
        h.loadSource(src);
        h.attachMedia(video);
        attachHls(h);
      }, showError);
    }

    function showError() {
      errorBox.hidden = false;
      spinner.hidden = true;
      root.classList.add('is-error');
    }

    // ── Воспроизведение ──
    function playPause() {
      if (video.paused || video.ended) {
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        video.pause();
      }
    }

    function syncPlay() {
      var paused = video.paused;
      root.classList.toggle('is-paused', paused);
      root.classList.toggle('is-started', root.classList.contains('is-started') || !paused);
      var key = paused ? 'player.play' : 'player.pause';
      qa('[data-act="play"]').forEach(function (b) {
        b.setAttribute('aria-label', t(key));
        b.setAttribute('data-i18n-aria', key);
        if (b.title) b.title = t(key) + ' (k)';
      });
      wake();
    }

    // ── Звук ──
    function syncVolume() {
      var muted = video.muted || video.volume === 0;
      root.classList.toggle('is-muted', muted);
      if (volume) volume.value = muted ? 0 : video.volume;
      if (volume) volume.style.setProperty('--fill', (muted ? 0 : video.volume * 100) + '%');
      var b = q('[data-act="mute"]');
      var key = muted ? 'player.unmuteShort' : 'player.mute';
      b.setAttribute('aria-label', t(key));
      b.setAttribute('data-i18n-aria', key);
      b.title = t(key) + ' (m)';
      if (!muted) unmuteBtn.hidden = true;
    }

    function setMuted(on) {
      video.muted = on;
      if (!on && video.volume === 0) video.volume = 0.5;
      save('muted', on);
    }

    function setVolume(v) {
      v = Math.min(1, Math.max(0, v));
      video.volume = v;
      video.muted = v === 0;
      save('volume', v);
      save('muted', video.muted);
    }

    // ── Время и перемотка ──
    function duration() { return isFinite(video.duration) ? video.duration : 0; }

    function syncTime() {
      if (live) return syncLive();
      var d = duration();
      var pct = d ? video.currentTime / d * 100 : 0;
      played.style.width = pct + '%';
      cur.textContent = clock(video.currentTime);
      dur.textContent = clock(d);
      progress.setAttribute('aria-valuemax', String(Math.floor(d)));
      progress.setAttribute('aria-valuenow', String(Math.floor(video.currentTime)));
      progress.setAttribute('aria-valuetext', clock(video.currentTime) + ' / ' + clock(d));
    }

    function syncBuffered() {
      if (live || !buffered) return;
      var d = duration(), b = video.buffered, end = 0;
      for (var i = 0; i < b.length; i++) {
        if (b.start(i) <= video.currentTime + 0.5) end = Math.max(end, b.end(i));
      }
      buffered.style.width = (d ? end / d * 100 : 0) + '%';
    }

    function seekTo(s) {
      var d = duration();
      if (!d) return;
      video.currentTime = Math.min(d - 0.1, Math.max(0, s));
      syncTime();
    }

    function seekBy(delta) {
      if (live) return;
      seekTo(video.currentTime + delta);
      flash(delta < 0 ? 'back' : 'fwd');
    }

    function flash(side) {
      var el = q('.tk-player__flash--' + side);
      if (!el) return;
      el.classList.remove('is-on');
      void el.offsetWidth; // перезапуск анимации
      el.classList.add('is-on');
    }

    function pointerTime(e) {
      var r = progress.getBoundingClientRect();
      var x = Math.min(r.width, Math.max(0, e.clientX - r.left));
      return { x: x, time: r.width ? x / r.width * duration() : 0 };
    }

    if (progress) {
      var dragging = false;
      progress.addEventListener('pointerdown', function (e) {
        if (e.button) return;
        dragging = true;
        progress.setPointerCapture(e.pointerId);
        root.classList.add('is-seeking');
        seekTo(pointerTime(e).time);
      });
      progress.addEventListener('pointermove', function (e) {
        var p = pointerTime(e);
        tip.hidden = !duration();
        tip.textContent = clock(p.time);
        var half = tip.offsetWidth / 2, w = progress.clientWidth;
        tip.style.left = Math.min(w - half, Math.max(half, p.x)) + 'px';
        if (dragging) seekTo(p.time);
      });
      var endDrag = function () { dragging = false; root.classList.remove('is-seeking'); };
      progress.addEventListener('pointerup', endDrag);
      progress.addEventListener('pointercancel', endDrag);
      progress.addEventListener('pointerleave', function () { if (!dragging) tip.hidden = true; });
      progress.addEventListener('keydown', function (e) {
        var step = { ArrowLeft: -5, ArrowRight: 5, PageDown: -60, PageUp: 60 }[e.key];
        if (e.key === 'Home') step = -Infinity;
        if (e.key === 'End') step = Infinity;
        if (step === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        seekTo(isFinite(step) ? video.currentTime + step : step < 0 ? 0 : duration());
      });
    }

    // ── Живой край эфира ──
    function liveEdge() {
      if (hls && isFinite(hls.liveSyncPosition) && hls.liveSyncPosition) return hls.liveSyncPosition;
      var s = video.seekable;
      return s.length ? s.end(s.length - 1) : 0;
    }

    function syncLive() {
      if (!liveBtn) return;
      var edge = liveEdge();
      var behind = !!edge && edge - video.currentTime > LIVE_LAG_S;
      liveBtn.classList.toggle('is-behind', behind || video.paused);
    }

    function toLive() {
      var edge = liveEdge();
      if (edge) video.currentTime = Math.max(0, edge - 1);
      if (video.paused) playPause();
    }

    // После долгой паузы в эфире смотреть прошлое нечего — плейлист держит
    // только последние секунды. Продолжаем с живого края.
    var pausedAt = 0;
    if (live) {
      video.addEventListener('pause', function () { pausedAt = Date.now(); });
      video.addEventListener('play', function () {
        if (pausedAt && Date.now() - pausedAt > LIVE_LAG_S * 1000) toLive();
        pausedAt = 0;
      });
    }

    // ── Меню: скорость и качество ──
    var speed = live ? 1 : load('speed', 1);
    if (SPEEDS.indexOf(speed) < 0) speed = 1;

    function levels() {
      if (!hls || !hls.levels || hls.levels.length < 2) return null;
      return hls.levels.map(function (l, i) { return { i: i, height: l.height }; })
        .sort(function (a, b) { return b.height - a.height; });
    }

    function qualityLabel() {
      if (!hls || hls.autoLevelEnabled) {
        var l = hls && hls.levels[hls.currentLevel];
        return t('player.auto') + (l ? ' (' + l.height + 'p)' : '');
      }
      return hls.levels[hls.currentLevel].height + 'p';
    }

    function speedLabel(s) { return s === 1 ? t('player.normal') : String(s).replace('.', ',') + '×'; }

    function item(label, value, on, act) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tk-player__item';
      b.setAttribute('role', on === undefined ? 'menuitem' : 'menuitemradio');
      if (on !== undefined) b.setAttribute('aria-checked', String(on));
      b.innerHTML = '<span></span>' + (value !== null ? '<span class="tk-player__item-val"></span>' : '');
      b.firstChild.textContent = label;
      if (value !== null) b.lastChild.textContent = value;
      b.addEventListener('click', function (e) { e.stopPropagation(); act(); });
      return b;
    }

    function openMenu(view) {
      menu.textContent = '';
      var lv = levels();
      if (view === 'speed') {
        menu.appendChild(item('‹ ' + t('player.speed'), null, undefined, function () { openMenu('main'); }));
        SPEEDS.forEach(function (s) {
          menu.appendChild(item(speedLabel(s), null, s === video.playbackRate, function () {
            video.playbackRate = s;
            speed = s;
            save('speed', s);
            closeMenu();
          }));
        });
      } else if (view === 'quality' && lv) {
        menu.appendChild(item('‹ ' + t('player.quality'), null, undefined, function () { openMenu('main'); }));
        menu.appendChild(item(t('player.auto'), null, hls.autoLevelEnabled, function () {
          hls.currentLevel = -1;
          closeMenu();
        }));
        lv.forEach(function (l) {
          menu.appendChild(item(l.height + 'p', null, !hls.autoLevelEnabled && hls.currentLevel === l.i, function () {
            hls.currentLevel = l.i;
            closeMenu();
          }));
        });
      } else {
        if (!live) menu.appendChild(item(t('player.speed'), speedLabel(video.playbackRate), undefined, function () { openMenu('speed'); }));
        menu.appendChild(item(t('player.quality'), lv ? qualityLabel() : t('player.auto'), undefined, function () {
          if (lv) openMenu('quality');
        }));
      }
      menu.hidden = false;
      menuBtn.setAttribute('aria-expanded', 'true');
      root.classList.add('is-menu');
      var first = menu.querySelector('[aria-checked="true"]') || menu.firstChild;
      if (first && !coarse) first.focus({ preventScroll: true });
    }

    function closeMenu() {
      if (menu.hidden) return;
      menu.hidden = true;
      menuBtn.setAttribute('aria-expanded', 'false');
      root.classList.remove('is-menu');
      wake();
    }

    document.addEventListener('click', function (e) {
      if (!menu.hidden && !menu.parentNode.contains(e.target)) closeMenu();
    });

    // ── Весь экран, картинка в картинке, широкий режим ──
    function toggleFullscreen() {
      if (live) {
        var b = q('[data-fullscreen]');
        if (b) b.click();
        return;
      }
      if (fsElement()) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        return;
      }
      var req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (req) {
        var p = req.call(root);
        if (p && p.catch) p.catch(function () {});
      } else if (video.webkitEnterFullscreen) {
        // iPhone отдаёт весь экран только самому <video>, со своими кнопками.
        video.webkitEnterFullscreen();
      }
    }

    function syncFullscreen() {
      if (live) return;
      var on = fsElement() === root;
      root.classList.toggle('is-fullscreen', on);
      var b = q('.tk-player__fs');
      var key = on ? 'stream.exitFullscreen' : 'stream.fullscreen';
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', t(key));
      b.setAttribute('data-i18n-aria', key);
      b.title = t(key) + ' (f)';
    }
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
      document.addEventListener(ev, syncFullscreen);
    });

    var pipBtn = q('[data-act="pip"]');
    if (document.pictureInPictureEnabled && !video.disablePictureInPicture) pipBtn.hidden = false;
    function togglePip() {
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(function () {});
      else video.requestPictureInPicture().catch(function () {});
    }

    // Широкий режим — дело страницы: плеер сообщает, страница перестраивается
    // (у записи — класс на .tk-watch). Выбор помнится.
    var theaterBtn = q('[data-act="theater"]');
    function setTheater(on) {
      if (!theaterBtn) return;
      theaterBtn.setAttribute('aria-pressed', String(on));
      var key = on ? 'player.theaterOff' : 'player.theater';
      theaterBtn.setAttribute('aria-label', t(key));
      theaterBtn.setAttribute('data-i18n-aria', key);
      theaterBtn.title = t(key) + ' (t)';
      root.dispatchEvent(new CustomEvent('tk-player:theater', { bubbles: true, detail: on }));
      save('theater', on);
    }
    if (theaterBtn && load('theater', false)) setTheater(true);

    // ── Кнопки ──
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b || !root.contains(b)) return;
      var act = b.dataset.act;
      if (act === 'play') playPause();
      else if (act === 'mute') setMuted(!(video.muted || video.volume === 0));
      else if (act === 'unmute') { setMuted(false); if (video.paused) playPause(); }
      else if (act === 'live') toLive();
      else if (act === 'settings') { e.stopPropagation(); menu.hidden ? openMenu('main') : closeMenu(); }
      else if (act === 'fullscreen') toggleFullscreen();
      else if (act === 'pip') togglePip();
      else if (act === 'theater') setTheater(theaterBtn.getAttribute('aria-pressed') !== 'true');
    });

    if (volume) volume.addEventListener('input', function () { setVolume(Number(volume.value)); });

    // Щелчок по картинке — пауза, двойной — весь экран. На телефоне касание
    // показывает и прячет кнопки, двойное по краю — ±10 секунд.
    var lastTap = 0, tapTimer = null;
    video.addEventListener('click', function (e) {
      if (root.classList.contains('is-error')) return;
      if (!coarse) {
        clearTimeout(tapTimer);
        if (Date.now() - lastTap < 300) { lastTap = 0; toggleFullscreen(); return; }
        lastTap = Date.now();
        tapTimer = setTimeout(playPause, 220);
        return;
      }
      var r = video.getBoundingClientRect();
      var side = e.clientX < r.left + r.width / 3 ? -1 : e.clientX > r.right - r.width / 3 ? 1 : 0;
      if (!live && side && Date.now() - lastTap < 300) {
        clearTimeout(tapTimer);
        seekBy(side * SEEK_STEP);
        lastTap = Date.now();
        return;
      }
      lastTap = Date.now();
      clearTimeout(tapTimer);
      tapTimer = setTimeout(function () {
        if (root.classList.contains('is-idle') || !root.classList.contains('is-started')) wake();
        else sleep();
      }, 260);
    });

    root.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // ── Кнопки прячутся, пока смотрят ──
    var idleTimer = null;
    function sleep() {
      if (video.paused || !menu.hidden || root.classList.contains('is-seeking')) return;
      root.classList.add('is-idle');
    }
    function wake() {
      root.classList.remove('is-idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(sleep, IDLE_MS);
    }
    root.addEventListener('pointermove', function (e) { if (e.pointerType === 'mouse') wake(); });
    root.addEventListener('focusin', wake);
    root.addEventListener('mouseleave', function () { clearTimeout(idleTimer); idleTimer = setTimeout(sleep, 600); });

    // ── Клавиши: страница с одним плеером, поэтому слушаем документ ──
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if (e.target.closest && e.target.closest('button, a, [role="slider"]') && (e.key === ' ' || e.key === 'Enter')) return;
      var k = e.key.toLowerCase();
      var handled = true;
      if (k === ' ' || k === 'k') playPause();
      else if (k === 'm') setMuted(!(video.muted || video.volume === 0));
      else if (k === 'f') toggleFullscreen();
      else if (k === 't' && theaterBtn) setTheater(theaterBtn.getAttribute('aria-pressed') !== 'true');
      else if (k === 'arrowup') setVolume(video.volume + 0.05);
      else if (k === 'arrowdown') setVolume(video.volume - 0.05);
      else if (!live && (k === 'arrowleft' || k === 'j')) seekBy(k === 'j' ? -SEEK_STEP : -5);
      else if (!live && (k === 'arrowright' || k === 'l')) seekBy(k === 'l' ? SEEK_STEP : 5);
      else if (!live && /^[0-9]$/.test(k)) seekTo(duration() * Number(k) / 10);
      else if (k === 'escape' && !menu.hidden) closeMenu();
      else handled = false;
      if (handled) { e.preventDefault(); wake(); }
    });

    // ── События видео ──
    video.addEventListener('play', syncPlay);
    video.addEventListener('pause', syncPlay);
    video.addEventListener('ended', syncPlay);
    video.addEventListener('volumechange', syncVolume);
    video.addEventListener('timeupdate', syncTime);
    video.addEventListener('durationchange', syncTime);
    video.addEventListener('loadedmetadata', function () { syncTime(); video.playbackRate = speed; });
    video.addEventListener('progress', syncBuffered);
    video.addEventListener('waiting', function () { spinner.hidden = false; });
    ['playing', 'canplay', 'seeked', 'pause'].forEach(function (ev) {
      video.addEventListener(ev, function () { spinner.hidden = true; });
    });
    video.addEventListener('error', function () { if (!live && video.getAttribute('src')) showError(); });
    video.addEventListener('ratechange', function () { if (!live) speed = video.playbackRate; });

    // ── Старт ──
    // Запись пробуем запустить сразу со звуком; браузер не дал — без звука
    // и с кнопкой «Включить звук». Эфир стартует без звука всегда (TKHls).
    video.volume = load('volume', 1);
    video.muted = live || load('muted', false);
    syncPlay();
    syncVolume();
    syncFullscreen();
    if (root.dataset.src) {
      useSource(root.dataset.src, function () {
        var p = video.play();
        if (p && p.catch) p.catch(function () {
          video.muted = true;
          var p2 = video.play();
          if (p2 && p2.then) p2.then(function () { unmuteBtn.hidden = false; }, function () { video.muted = load('muted', false); });
        });
      });
    }
    if (live) {
      video.addEventListener('playing', function once() {
        video.removeEventListener('playing', once);
        if (video.muted) unmuteBtn.hidden = false;
      });
    }

    function attachHls(h) {
      hls = h;
      if (!window.Hls) return;
      h.on(window.Hls.Events.LEVEL_SWITCHED, function () {
        if (!menu.hidden && !menu.querySelector('[aria-checked]')) openMenu('main');
      });
    }

    return { video: video, attachHls: attachHls };
  }

  window.TKPlayer = { mount: mount };
})();
