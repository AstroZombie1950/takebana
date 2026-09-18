/* Страница записи эфира: плеер, просмотр, оценки, «Поделиться», правка
 * и удаление автором, комментарии. Разметка — views/recording.ejs,
 * маршруты — routes/recordings.js.
 */
(function () {
  var watch = document.getElementById('watch');
  if (!watch) return;
  var id = watch.dataset.id;
  var base = '/recording/' + id;
  var isOwner = watch.dataset.owner === '1';
  var lang = document.documentElement.lang === 'en' ? 'en-US' : 'ru-RU';
  var $ = function (i) { return document.getElementById(i); };

  function num(n) { return Number(n || 0).toLocaleString(lang); }

  // Форма слова по числу — как plural() в шаблонах (utils/i18n.js).
  function pluralKey(n, base) {
    var d10 = n % 10, d100 = n % 100;
    return base + (d10 === 1 && d100 !== 11 ? 'One' : d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14) ? 'Few' : 'Many');
  }

  // Подпись с числом, которая переживёт переключение языка.
  function setCounted(el, n, base) {
    var key = pluralKey(n, base);
    var vars = { n: num(n) };
    el.setAttribute('data-i18n', key);
    el.setAttribute('data-i18n-vars', JSON.stringify(vars));
    el.textContent = t(key, vars);
  }

  function send(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) throw new Error(b.message || 'HTTP ' + r.status);
        return b;
      });
    }, function () { throw new Error(t('common.noNetwork')); });
  }

  function fail(e) { toast(t('app.errorShort', { message: e.message }), 'error'); }

  // ── Плеер и широкий режим ──
  watch.addEventListener('tk-player:theater', function (e) {
    watch.classList.toggle('is-theater', e.detail);
  });
  var playerRoot = watch.querySelector('.tk-player');
  var player = playerRoot ? TKPlayer.mount(playerRoot) : null;

  // ── Просмотр: засчитываем, когда запись правда смотрят — 10 секунд
  // воспроизведения (у короткой — половина). Раз за открытие страницы.
  if (player) {
    var video = player.video;
    var watched = 0, last = null, sent = false;
    video.addEventListener('timeupdate', function () {
      if (sent || video.paused || video.seeking) { last = null; return; }
      var now = video.currentTime;
      if (last !== null && now > last && now - last < 1.5) watched += now - last;
      last = now;
      var need = Math.min(10, (video.duration || 20) / 2);
      if (watched < need) return;
      sent = true;
      send('POST', base + '/view').then(function (b) {
        var line = $('viewsLine');
        if (!b.counted || !line) return;
        var n = Number(JSON.parse(line.getAttribute('data-i18n-vars') || '{}').n.replace(/\D/g, '')) + 1;
        setCounted(line, n, 'rec.views');
      }).catch(function () {});
    });
  }

  // ── Оценки ──
  var rateButtons = Array.prototype.slice.call(watch.querySelectorAll('[data-rate]'));
  rateButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      var value = b.getAttribute('aria-pressed') === 'true' ? 0 : Number(b.dataset.rate);
      rateButtons.forEach(function (x) { x.disabled = true; });
      send('POST', base + '/reaction', { value: value }).then(function (r) {
        rateButtons.forEach(function (x) { x.setAttribute('aria-pressed', String(Number(x.dataset.rate) === r.mine)); });
        $('likes').textContent = num(r.likes);
        if (r.dislikes !== undefined && $('dislikes')) $('dislikes').textContent = num(r.dislikes);
      }).catch(fail).then(function () {
        rateButtons.forEach(function (x) { x.disabled = false; });
      });
    });
  });

  // ── Поделиться: на телефоне — системное меню, иначе ссылка в буфер ──
  var share = $('shareRecording');
  if (share) share.addEventListener('click', function () {
    var url = location.origin + base;
    if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
      navigator.share({ title: document.title, url: url }).catch(function () {});
      return;
    }
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
      .then(function () { toast(t('rec.linkCopied'), 'ok'); }, function () { prompt('', url); });
  });

  // ── Описание: длинное свёрнуто ──
  var desc = $('recDesc');
  var more = $('descMore');
  function clampDesc() {
    if (!desc || !more) return;
    desc.classList.add('is-clamped');
    var long = desc.scrollHeight > desc.clientHeight + 2;
    if (!long) desc.classList.remove('is-clamped');
    more.hidden = !long;
    tkText(more, 'rec.more');
  }
  if (more) more.addEventListener('click', function () {
    var open = desc.classList.toggle('is-clamped') === false;
    tkText(more, open ? 'rec.less' : 'rec.more');
  });
  clampDesc();

  // ── Правка и удаление — автор ──
  var editBtn = $('editRecording');
  var form = $('editForm');
  if (editBtn && form) {
    var owner = watch.querySelector('.tk-watch__owner');
    var showForm = function (on) {
      form.hidden = !on;
      owner.hidden = on;
      if (desc) desc.hidden = on;
      if (more) more.hidden = on || !desc.classList.contains('is-clamped');
      if (on) $('editTitle').focus();
    };
    editBtn.addEventListener('click', function () { showForm(true); });
    $('editCancel').addEventListener('click', function () { showForm(false); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      send('PATCH', base, { title: $('editTitle').value, description: $('editDesc').value }).then(function (r) {
        $('recTitle').textContent = r.title;
        document.title = r.title + ' — Takebana';
        if (!desc) {
          desc = document.createElement('p');
          desc.id = 'recDesc';
          form.parentNode.insertBefore(desc, owner);
        }
        desc.className = 'tk-watch__desc' + (r.description ? '' : ' tk-watch__desc--empty');
        if (r.description) {
          desc.removeAttribute('data-i18n');
          desc.textContent = r.description;
        } else {
          tkText(desc, 'rec.noDesc');
        }
        showForm(false);
        clampDesc();
        toast(t('rec.saved'), 'ok');
      }).catch(fail).then(function () { submit.disabled = false; });
    });
  }

  var del = $('deleteRecording');
  if (del) del.addEventListener('click', function () {
    confirmDialog(t('rec.deleteQ'), { okText: t('rec.delete') }).then(function (ok) {
      if (!ok) return;
      del.disabled = true;
      return send('DELETE', base).then(function () {
        location.href = watch.dataset.back + '#recordings';
      });
    }).catch(function (e) {
      del.disabled = false;
      toast(t('app.deleteError', { message: e.message }), 'error');
    });
  });

  // ── Комментарии ──
  var list = $('commentList');
  if (!list) return;
  var title = $('commentsTitle');
  var empty = $('commentsEmpty');
  var moreBtn = $('commentsMore');
  var count = Number(title.dataset.count) || 0;
  var oldest = null;
  var me = watch.dataset.user;

  function setCount(n) {
    count = Math.max(0, n);
    title.dataset.count = count;
    setCounted(title, count, 'rec.comments');
    empty.hidden = list.children.length > 0;
  }

  var WHEN = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' };
  var TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
  var FLAG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 21V4h11l-2 4 2 4H5"/></svg>';

  function item(c) {
    var li = document.createElement('li');
    li.className = 'tk-watch__c';
    li.id = 'c-' + c._id;
    li.dataset.id = c._id;
    var a = c.author, av = a.avatar || {};
    var profile = '/userPage/' + encodeURIComponent(a._id);
    var acts = '';
    if (c.canDelete) {
      acts += '<button type="button" class="tk-watch__c-btn" data-del aria-label="' + escapeHtml(t('common.delete')) + '" title="' + escapeHtml(t('common.delete')) + '">' + TRASH + '</button>';
    }
    if (me && !c.mine) {
      acts += '<button type="button" class="tk-watch__c-btn" data-report="comment" data-report-id="' + escapeHtml(c._id) + '" data-report-name="' + escapeHtml(a.name) + '" aria-label="' + escapeHtml(t('common.report')) + '" title="' + escapeHtml(t('common.report')) + '">' + FLAG + '</button>';
    }
    li.innerHTML =
      '<a class="tk-watch__c-ava" href="' + profile + '"' + (av.url ? '' : ' style="background:' + escapeHtml(av.gradient || '') + '"') + '>' +
        (av.url ? '<img src="' + escapeHtml(av.url) + '" alt="" loading="lazy">' : escapeHtml(av.initial || '')) + '</a>' +
      '<div><div class="tk-watch__c-head"><a class="tk-watch__c-name" href="' + profile + '">' + escapeHtml(a.name) + '</a>' +
        '<time class="tk-watch__c-when" datetime="' + escapeHtml(c.createdAt) + '">' + escapeHtml(tkDate(c.createdAt, WHEN)) + '</time></div>' +
        '<p class="tk-watch__c-text">' + escapeHtml(c.text) + '</p></div>' +
      '<div class="tk-watch__c-acts">' + acts + '</div>';
    return li;
  }

  function append(items) {
    items.forEach(function (c) { list.appendChild(item(c)); oldest = c.createdAt; });
    empty.hidden = list.children.length > 0;
  }

  append(JSON.parse($('commentsData').textContent || '[]'));

  // Переход из уведомления: комментарий подсвечен (:target) и в поле зрения.
  if (location.hash.indexOf('#c-') === 0) {
    var target = document.getElementById(location.hash.slice(1));
    if (target) target.scrollIntoView({ block: 'center' });
  }

  moreBtn.addEventListener('click', function () {
    moreBtn.disabled = true;
    send('GET', base + '/comments?before=' + encodeURIComponent(oldest)).then(function (r) {
      append(r.items);
      moreBtn.hidden = !r.more;
    }).catch(fail).then(function () { moreBtn.disabled = false; });
  });

  list.addEventListener('click', function (e) {
    var b = e.target.closest('[data-del]');
    if (!b) return;
    var li = b.closest('.tk-watch__c');
    confirmDialog(t('rec.commentDeleteQ'), { okText: t('common.delete') }).then(function (ok) {
      if (!ok) return;
      return send('DELETE', base + '/comments/' + li.dataset.id).then(function () {
        li.remove();
        setCount(count - 1);
      });
    }).catch(fail);
  });

  var cform = $('commentForm');
  if (!cform) return;
  var text = $('commentText');
  var cacts = cform.querySelector('.tk-watch__form-acts');

  // Поле растёт вместе с текстом; кнопки — когда в него начали писать.
  function grow() {
    text.style.height = 'auto';
    text.style.height = text.scrollHeight + 2 + 'px';
  }
  text.addEventListener('focus', function () { cacts.hidden = false; });
  text.addEventListener('input', grow);
  text.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); cform.requestSubmit(); }
  });
  $('commentCancel').addEventListener('click', function () {
    text.value = '';
    grow();
    cacts.hidden = true;
    text.blur();
  });

  cform.addEventListener('submit', function (e) {
    e.preventDefault();
    var value = text.value.trim();
    if (!value) return text.focus();
    var submit = cform.querySelector('[type="submit"]');
    submit.disabled = true;
    send('POST', base + '/comments', { text: value }).then(function (c) {
      list.insertBefore(item(c), list.firstChild);
      if (!oldest) oldest = c.createdAt;
      text.value = '';
      grow();
      setCount(count + 1);
    }).catch(fail).then(function () { submit.disabled = false; });
  });
})();
