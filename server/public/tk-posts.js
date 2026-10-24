// Действия под постами «Ленты» (05.10.2026, views/partials/postCard.ejs):
// «нравится» и комментарий прямо в ленте, без перехода на страницу
// публикации; с 09.10 — и длинный текст разворачивается на месте
// (крошки страницы поста — в tk-watch.js, общие со страницами фото и видео). Те же маршруты, что у страницы (routes/watch.js): адрес поста —
// data-post (/photo/<id>, /video/<id>, с 09.10 и /post/<id>). Обработчики — на документе: посты
// следующих страниц приходят без перезагрузки (catalog.js).
// С 06.10 — ответ на комментарий (ник в поле) и удаление своего, чужого
// под своим постом и любого модератором — как на странице публикации.
// С 12.10 — ролики играют прямо в ленте (ниже, «Видео на месте»).
(function () {
  'use strict';

  var TRASH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

  function postOf(el) { return el.closest('[data-post]'); }

  // ── Несколько фото и видео в посте (09.10) ──
  // Лента кадров листается пальцем сама (scroll-snap); стрелки — на шаг,
  // счётчик и видимость стрелок — по прокрутке. Прокрутка не всплывает —
  // слушаем её на документе с перехватом: посты приходят и без перезагрузки.
  function slideAt(track) { return Math.round(track.scrollLeft / Math.max(1, track.clientWidth)); }
  function paintSlides(box) {
    var track = box.querySelector('.tk-post__track');
    var n = track.children.length;
    var i = slideAt(track);
    var label = box.querySelector('[data-slide-n]');
    if (label) label.textContent = (i + 1) + ' / ' + n;
    var dots = box.querySelectorAll('.tk-post__dots i');
    for (var d = 0; d < dots.length; d++) dots[d].classList.toggle('is-on', d === i);
    box.querySelector('[data-slide="-1"]').hidden = i <= 0;
    box.querySelector('[data-slide="1"]').hidden = i >= n - 1;
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-slide]');
    if (!btn) return;
    var track = btn.closest('[data-slides]').querySelector('.tk-post__track');
    track.scrollTo({ left: (slideAt(track) + Number(btn.dataset.slide)) * track.clientWidth, behavior: 'smooth' });
  });
  document.addEventListener('scroll', function (e) {
    var track = e.target;
    if (!track.classList || !track.classList.contains('tk-post__track')) return;
    var box = track.closest('[data-slides]');
    if (box.querySelector('[data-slide-n]')) paintSlides(box);
  }, true);

  // ── Длинный текст поста — разворачивается на месте (09.10) ──
  // В ленте и профиле видно начало, «Ещё» приносит текст целиком
  // (/post/<id>/text, routes/watch.js) — уходить на страницу поста не нужно.
  // «Свернуть» возвращает начало. Не вышло — ссылка ведёт на страницу поста,
  // как без скрипта.
  document.addEventListener('click', function (e) {
    var link = e.target.closest('[data-more]');
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    var box = link.closest('[data-more-box]');
    var text = box.querySelector('[data-more-text]');
    if (box.dataset.short) {
      text.innerHTML = box.dataset.short;
      delete box.dataset.short;
      tkText(link, 'rec.more');
      return;
    }
    if (link.getAttribute('aria-busy')) return;
    link.setAttribute('aria-busy', 'true');
    TKNet.json(postOf(link).dataset.post + '/text')
      .then(function (r) {
        box.dataset.short = text.innerHTML;
        text.innerHTML = r.html;
        tkText(link, 'rec.less');
      })
      .catch(function () { location.href = link.href; })
      .then(function () { link.removeAttribute('aria-busy'); });
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-like]');
    if (!btn || btn.disabled) return;
    var post = postOf(btn);
    var on = btn.getAttribute('aria-pressed') === 'true';
    btn.disabled = true;
    TKNet.json(post.dataset.post + '/reaction', { method: 'POST', body: { value: on ? 0 : 1 } })
      .then(function (r) {
        btn.setAttribute('aria-pressed', String(r.mine === 1));
        btn.querySelector('[data-likes]').textContent = num(r.likes);
      })
      .catch(function (err) { toast(err.message, 'error'); })
      .then(function () { btn.disabled = false; });
  });

  // Ответить — ник в начало поля, курсор за ним.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-reply]');
    if (!btn) return;
    var input = postOf(btn).querySelector('[data-say] input');
    if (!input) return;
    var at = '@' + btn.dataset.reply + ' ';
    if (input.value.indexOf(at) !== 0) input.value = at + input.value.replace(/^@\S+\s*/, '');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-cdel]');
    if (!btn || btn.disabled) return;
    var li = btn.closest('[data-cid]');
    var post = postOf(btn);
    confirmDialog(t('rec.commentDeleteQ'), { okText: t('common.delete') }).then(function (ok) {
      if (!ok) return;
      btn.disabled = true;
      return TKNet.json(post.dataset.post + '/comments/' + li.dataset.cid, { method: 'DELETE' }).then(function () {
        li.remove();
        count(post, -1);
      });
    }).catch(function (err) { btn.disabled = false; toast(err.message, 'error'); });
  });

  document.addEventListener('submit', function (e) {
    var form = e.target.closest('[data-say]');
    if (!form) return;
    e.preventDefault();
    var input = form.elements.text;
    var text = input.value.trim();
    if (!text || form.dataset.busy) return;
    var post = postOf(form);
    form.dataset.busy = '1';
    TKNet.json(post.dataset.post + '/comments', { method: 'POST', body: { text: text } })
      .then(function (c) {
        post.querySelector('[data-said]').appendChild(row(c));
        count(post, 1);
        input.value = '';
      })
      .catch(function (err) { toast(err.message, 'error'); })
      .then(function () { delete form.dataset.busy; });
  });

  // Строка комментария — как в partials/postCard.ejs. Свой: ответить
  // некому, удалить можно.
  function row(c) {
    var li = document.createElement('li');
    li.className = 'tk-post__c';
    li.dataset.cid = c._id;
    var p = document.createElement('p');
    p.className = 'tk-post__c-text';
    var who = document.createElement('a');
    who.className = 'tk-post__said-who';
    who.href = c.author.url;
    who.textContent = c.author.name;
    var said = document.createElement('span');
    said.textContent = c.text;
    p.append(who, ' ', said);
    li.appendChild(p);
    if (c.canDelete) li.insertAdjacentHTML('beforeend', '<button type="button" class="tk-post__c-btn" data-cdel aria-label="' + escapeHtml(t('common.delete')) + '" title="' + escapeHtml(t('common.delete')) + '">' + TRASH + '</button>');
    return li;
  }

  // ── Видео на месте (12.10, Иван: «как в Инстаграме») ──
  // Обложка с data-play — нажали, и ролик играет здесь же. Плеер один на
  // страницу (partials/feedPlayer.ejs): переезжает в нажатый ролик, прежний
  // снова показывает обложку. Его скрипты и стили — при первом намерении
  // (навели, коснулись, нажали). Ушёл с экрана или пролистан в карусели —
  // пауза. Просмотр — по тому же правилу, что на странице записи
  // (tk-watch.js): 10 секунд воспроизведения, у короткого — половина.
  var tpl = document.getElementById('feedPlayer');
  var root = null, player = null, box = null, loading = null;
  var watched = 0, last = null;

  function asset(tag, attrs) {
    return new Promise(function (ok, no) {
      var el = document.createElement(tag);
      Object.keys(attrs).forEach(function (k) { el[k] = attrs[k]; });
      el.onload = ok;
      el.onerror = function () { no(new Error(t('player.error'))); };
      document.head.appendChild(el);
    });
  }
  function need() {
    if (!loading) {
      loading = Promise.all([
        asset('link', { rel: 'stylesheet', href: tpl.dataset.css }),
        asset('script', { src: tpl.dataset.hls }),
        asset('script', { src: tpl.dataset.js })
      ]).catch(function (e) { loading = null; throw e; });
    }
    return loading;
  }
  ['pointerover', 'touchstart', 'focusin'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      if (tpl && !loading && e.target.closest && e.target.closest('[data-play]')) need().catch(function () {});
    }, { passive: true });
  });

  var seen = 'IntersectionObserver' in window ? new IntersectionObserver(function (list) {
    list.forEach(function (en) {
      if (en.target === box && en.intersectionRatio < 0.25 && player) player.video.pause();
    });
  }, { threshold: [0, 0.25] }) : null;

  function play(target) {
    if (!root) {
      root = tpl.content.firstElementChild.cloneNode(true);
      root.querySelector('video').removeAttribute('id');
    }
    if (box && box !== target) {
      if (player) player.stop();
      box.classList.remove('is-playing');
      if (seen) seen.unobserve(box);
    }
    box = target;
    watched = 0;
    last = null;
    box.classList.add('is-playing');
    box.appendChild(root);
    if (seen) seen.observe(box);
    // Запуск — прямо в нажатии: скрипт плеера может прийти позже, а Safari
    // пускает звук, только если воспроизведение началось с жеста.
    var p = root.querySelector('video').play();
    if (p && p.catch) p.catch(function () {});
    need().then(function () {
      if (box !== target) return;
      if (!player) {
        player = TKPlayer.mount(root);
        player.video.addEventListener('timeupdate', countView);
      }
      player.load(target.dataset.play, target.dataset.poster);
      root.focus({ preventScroll: true });
    }).catch(function () { location.href = target.querySelector('.tk-post__cover').href; });
  }

  document.addEventListener('click', function (e) {
    var cover = tpl && e.target.closest('[data-play] > .tk-post__cover');
    if (!cover || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    play(cover.parentNode);
  });

  function countView() {
    var v = player.video;
    if (!box || box.dataset.viewed || v.paused || v.seeking) { last = null; return; }
    var now = v.currentTime;
    if (last !== null && now > last && now - last < 1.5) watched += now - last;
    last = now;
    if (watched < Math.min(10, (v.duration || 20) / 2)) return;
    var at = box;
    at.dataset.viewed = '1';
    TKNet.json(at.dataset.view, { method: 'POST', body: {}, button: null }).then(function (r) {
      var line = r && r.counted && postOf(at).querySelector('.tk-post__views');
      if (!line) return;
      var n = (Number(JSON.parse(line.getAttribute('data-i18n-vars') || '{}').n.replace(/\D/g, '')) || 0) + 1;
      var key = window.tkPlural(n, 'rec.views');
      var vars = { n: num(n) };
      line.setAttribute('data-i18n', key);
      line.setAttribute('data-i18n-vars', JSON.stringify(vars));
      line.textContent = t(key, vars);
    }).catch(function () {});
  }

  function count(post, d) {
    var n = post.querySelector('[data-comments]');
    n.textContent = num(Math.max(0, (Number(n.textContent.replace(/\D/g, '')) || 0) + d));
  }

  function num(n) { return Number(n).toLocaleString(window.tkLocale()); }
})();
