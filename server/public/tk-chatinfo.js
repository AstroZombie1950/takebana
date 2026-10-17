/* Панель диалога (17.10), как в Telegram: нажали на шапку переписки —
 * поверх диалога экран с собеседником: фото и имя (своё имя контакта
 * задаётся здесь же), ник, описание одной строкой, звонок, «без звука»,
 * поиск; контакты, избранное, общие группы, ограничение, жалоба, удаление
 * переписки; ниже — вкладки «Медиа», «Файлы», «Голосовые», «Публикации».
 * Профиль на сайте — по фото и нику. У группы те же действия и вкладки
 * встают в экран группы (tk-groups.js, TKChatInfo.groupBlock).
 *
 * Поиск по переписке — полосой на месте шапки (#findBar): найденное
 * списком поверх ленты, выбор ставит ленту к сообщению (chats.js, reveal),
 * стрелки — к соседним совпадениям.
 *
 * Сервер — routes/chatInfo.js. С лентой говорит через window.TKChats.
 */
(function () {
  var t = window.t || function () { return ''; };
  var $ = function (id) { return document.getElementById(id); };
  var pane = $('infoPane');
  var chat = $('chat');
  if (!pane || !window.TKChats) return;
  var C = window.TKChats;

  var info = null;          // /api/chat/peer/:id открытой панели
  var media = null;         // вкладки: { ctx, root, tab, items, before, loading, q, error }
  var renaming = false;

  var get = TKNet.json;
  function post(url, body) { return TKNet.json(url, { method: 'POST', body: body || {} }); }

  var ICON = {
    back: '<path d="M15 5l-7 7 7 7"></path>',
    phone: '<path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 006 6l1.5-2 4 1.5v3c0 1.1-.9 2-2 2A15.5 15.5 0 014.5 5.5c0-1.1.9-2 2-2z"></path>',
    video: '<path d="M3.5 6.5h11v11h-11zM14.5 10.5l6-3v9l-6-3z"></path>',
    bell: '<path d="M6 16.5V11a6 6 0 0112 0v5.5l1.5 1.5h-15zM10 20.5h4"></path>',
    bellOff: '<path d="M6 16.5V11a6 6 0 0110-4.5M18 11v5.5l1.5 1.5H8M10 20.5h4M4 4l16 16"></path>',
    search: '<circle cx="11" cy="11" r="6.5"></circle><path d="M16 16l4.5 4.5"></path>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"></path>',
    close: '<path d="M6 6l12 12M18 6L6 18"></path>',
    file: '<path d="M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4"></path>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21"></path>',
    round: '<circle cx="12" cy="12" r="8.5"></circle><circle cx="12" cy="12" r="3.5"></circle>',
    music: '<path d="M9 17.5V5.5l10-2v12"></path><circle cx="6.5" cy="17.5" r="2.5"></circle><circle cx="16.5" cy="15.5" r="2.5"></circle>',
    goto: '<path d="M4 5.5h16v10.5H9.5L5.5 19.5V16H4z"></path><path d="M9 10.75h6M12.5 8.25l2.5 2.5-2.5 2.5"></path>',
    play: '<path d="M8 5.5v13L19 12z" fill="currentColor" stroke="none"></path>',
  };
  function svg(name, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[name] + '</svg>';
  }
  function tool(act, icon, label, extra) {
    return '<button type="button" class="tk-cinfo__act" data-ci="' + act + '" aria-label="' + escapeHtml(label) + '" title="' + escapeHtml(label) + '"' + (extra || '') + '>' + svg(icon, 22) + '</button>';
  }
  function row(act, key, cls) {
    return '<button type="button" class="tk-cinfo__row' + (cls ? ' ' + cls : '') + '" data-ci="' + act + '">' + escapeHtml(t(key)) + '</button>';
  }
  function face(x) {
    var a = x.avatarStyle || {};
    return { url: a.full || a.url || '', bg: a.gradient || '', initial: a.initial || '?' };
  }

  // ── Без звука ─────────────────────────────────────────────────────────
  // Срок — на выбор (routes/chatInfo.js, MUTE_HOURS); выключенный звук
  // включается одним нажатием.
  var MUTE = [[1, 'chatinfo.mute1'], [8, 'chatinfo.mute8'], [48, 'chatinfo.mute48'], [24 * 365, 'chatinfo.muteForever']];

  function muteLabel(until) {
    if (!until) return t('chatinfo.mute');
    // Больше полугода — «пока не включу».
    return new Date(until) - Date.now() > 180 * 86400e3 ? t('chatinfo.mutedForever') : t('chatinfo.mutedUntil', { when: tkDate(until) });
  }

  function muteHtml(until) {
    return tool('mute', until ? 'bellOff' : 'bell', muteLabel(until), ' aria-pressed="' + !!until + '"');
  }

  // ctx — { peerId } или { groupId }. Ответ — новое until или null.
  function toggleMute(ctx, until) {
    var ask = until ? Promise.resolve(0) : chooseDialog(t('chatinfo.muteQ'), MUTE.map(function (m) {
      return { value: m[0], text: t(m[1]), danger: false };
    }));
    return ask.then(function (hours) {
      if (hours === null || hours === undefined) return undefined;
      return post('/api/chat/mute', Object.assign({ hours: hours }, ctx)).then(function (d) { return d.until; });
    }).catch(function (e) { toast(t('chatinfo.muteFailed', { why: e.message }), 'error'); return undefined; });
  }

  function paintMute(root, until) {
    var b = root.querySelector('[data-ci="mute"]');
    if (b) b.outerHTML = muteHtml(until);
  }

  // ── Каркас ────────────────────────────────────────────────────────────
  function show(body) {
    pane.innerHTML =
      '<header class="tk-gpane__head">' +
        '<button type="button" class="tk-chat__tool" data-ci="close" aria-label="' + escapeHtml(t('groups.back')) + '" title="' + escapeHtml(t('groups.back')) + '">' + svg('back') + '</button>' +
        '<h2 class="tk-gpane__title">' + escapeHtml(t('chatinfo.title')) + '</h2>' +
      '</header>' +
      '<div class="tk-gpane__body tk-cinfo__body">' + body + '</div>';
    pane.hidden = false;
    chat.classList.add('is-pane');
  }

  function close() {
    info = null;
    media = null;
    renaming = false;
    pane.hidden = true;
    pane.innerHTML = '';
    chat.classList.remove('is-pane');
  }

  function open() {
    var p = C.peer();
    if (!p) return;
    var key = C.key();
    renaming = false;
    show('<p class="tk-note tk-note--center">' + escapeHtml(t('chatinfo.loading')) + '</p>');
    get('/api/chat/peer/' + encodeURIComponent(p.id)).then(function (d) {
      if (C.key() !== key || pane.hidden) return;
      info = d;
      media = { ctx: { peerId: p.id }, tab: (media && media.tab) || 'media' };
      paint();
      loadTab();
    }).catch(function (e) {
      if (C.key() !== key) return;
      show('<p class="tk-note tk-note--center">' + escapeHtml(t('chatinfo.loadFailed', { why: e.message })) + '</p>');
    });
  }

  // ── Собеседник ────────────────────────────────────────────────────────
  function cardHtml() {
    var p = info.peer;
    var name = renaming
      ? '<form class="tk-cinfo__rename" data-ci-form="rename">' +
          '<input class="tk-field" name="name" maxlength="64" autocomplete="off" value="' + escapeHtml(p.name) + '" placeholder="' + escapeHtml(p.nickname || p.displayName) + '" aria-label="' + escapeHtml(t('chatinfo.rename')) + '">' +
          '<button type="submit" class="tk-chat__tool" aria-label="' + escapeHtml(t('common.save')) + '" title="' + escapeHtml(t('common.save')) + '">' + svg('check') + '</button>' +
          '<button type="button" class="tk-chat__tool" data-ci="rename-cancel" aria-label="' + escapeHtml(t('common.cancel')) + '" title="' + escapeHtml(t('common.cancel')) + '">' + svg('close') + '</button>' +
        '</form>'
      : '<button type="button" class="tk-cinfo__name" data-ci="rename" aria-label="' + escapeHtml(t('chatinfo.rename')) + ': ' + escapeHtml(p.displayName) + '">' +
          escapeHtml(p.displayName) + (p.official && window.tkOfficial ? window.tkOfficial() : '') + '</button>';
    return '<div class="tk-cinfo__card">' +
      C.avatar('tk-cinfo__ava', face(p), ' href="' + escapeHtml(p.url) + '" aria-label="' + escapeHtml(p.displayName) + '"', 'a') +
      name +
      (p.nickname ? '<a class="tk-cinfo__nick" href="' + escapeHtml(p.url) + '">@' + escapeHtml(p.nickname) + '</a>' : '') +
      '<span class="tk-cinfo__seen" data-presence-user="' + escapeHtml(p.id) + '">' +
        '<span class="presence-dot ' + (p.isOnline ? 'presence-online' : 'presence-offline') + '"></span>' +
        '<span data-presence-text>' + escapeHtml(t(p.isOnline ? 'common.online' : 'common.offline')) + '</span></span>' +
      // Описание — одной строкой, целиком по нажатию: оно бывает длинным.
      (p.bio ? '<button type="button" class="tk-cinfo__bio" data-ci="bio" aria-expanded="false">' + escapeHtml(p.bio) + '</button>' : '') +
    '</div>';
  }

  function paint() {
    var p = info.peer;
    var barred = !!info.restricted;
    var known = C.contact(p.id);
    var acts = '<div class="tk-cinfo__acts">' +
      (barred ? '' : tool('audio', 'phone', t('calls.audio')) + tool('video', 'video', t('calls.video'))) +
      muteHtml(info.muted) +
      tool('search', 'search', t('chatinfo.search')) +
    '</div>';
    var common = info.groups.length
      ? '<section class="tk-gsec"><h3 class="tk-kicker">' + escapeHtml(t('chatinfo.groups')) + '</h3><div class="tk-gmembers">' +
        info.groups.map(function (g) {
          return '<button type="button" class="tk-gmember tk-cinfo__group" data-ci-group="' + escapeHtml(g.id) + '">' +
            C.avatar('tk-gmember__ava', face(g)) + '<span class="tk-gmember__name">' + escapeHtml(g.title) + '</span></button>';
        }).join('') + '</div></section>'
      : '';
    var rows = '<div class="tk-cinfo__rows">' +
      (known ? row('contact-remove', 'contacts.remove') + row(known.favorite ? 'unfavorite' : 'favorite', known.favorite ? 'contacts.unfavorite' : 'contacts.favorite')
        : barred ? '' : row('contact-add', 'contacts.add')) +
      (C.restricted() ? row('unrestrict', 'user.unrestrict') : row('restrict', 'user.restrict', 'is-danger')) +
      '<button type="button" class="tk-cinfo__row" data-report="user" data-report-id="' + escapeHtml(p.id) + '" data-report-name="' + escapeHtml(p.displayName) + '">' + escapeHtml(t('common.report')) + '</button>' +
      row('delete', 'chats.deleteChat', 'is-danger') +
    '</div>';
    show(cardHtml() + acts + common + rows + mediaHtml());
    media.root = pane.querySelector('.tk-cinfo__media');
    paintTab();
  }

  function repaintCard() {
    var card = pane.querySelector('.tk-cinfo__card');
    if (!card) return;
    card.outerHTML = cardHtml();
    var f = renaming && pane.querySelector('[data-ci-form="rename"] input');
    if (f) { f.focus(); f.select(); }
  }

  function rename(name) {
    var p = info.peer;
    post('/api/contacts/rename', { peerId: p.id, name: name }).then(function (d) {
      var c = d.contact;
      p.name = c.name || '';
      p.displayName = c.displayName;
      if (c.avatarStyle && !c.avatarStyle.url) p.avatarStyle = Object.assign({}, p.avatarStyle, { initial: c.avatarStyle.initial });
      renaming = false;
      C.renamed(c);
      if (info) paint();
    }).catch(function (e) { toast(t('chatinfo.renameFailed', { why: e.message }), 'error'); });
  }

  // ── Вкладки ───────────────────────────────────────────────────────────
  // Медиа — сеткой, остальное — строками. Листается вниз до конца: страница
  // за страницей, когда до низа меньше экрана (routes/chatInfo.js, /api/chat/tab).
  var TABS = [['media', 'chatinfo.tab.media'], ['files', 'chatinfo.tab.files'], ['voice', 'chatinfo.tab.voice'], ['shares', 'chatinfo.tab.shares']];

  function mediaHtml() {
    return '<section class="tk-cinfo__media">' +
      '<div class="tk-cinfo__tabs" role="tablist" aria-label="' + escapeHtml(t('chatinfo.tabs')) + '">' +
        TABS.map(function (x) {
          return '<button type="button" role="tab" class="tk-cinfo__tab" data-ci-tab="' + x[0] + '" aria-selected="' + (media.tab === x[0]) + '">' + escapeHtml(t(x[1])) + '</button>';
        }).join('') +
      '</div>' +
      '<div class="tk-cinfo__filefind"' + (media.tab === 'files' ? '' : ' hidden') + '>' +
        '<input type="search" class="tk-field" data-ci-filefind maxlength="100" autocomplete="off" value="' + escapeHtml(media.q || '') + '" placeholder="' + escapeHtml(t('chatinfo.fileSearch')) + '" aria-label="' + escapeHtml(t('chatinfo.fileSearch')) + '">' +
      '</div>' +
      '<div class="tk-cinfo__items" role="tabpanel"></div>' +
    '</section>';
  }

  function query(ctx) {
    return ctx.groupId ? 'group=' + encodeURIComponent(ctx.groupId) : 'peer=' + encodeURIComponent(ctx.peerId);
  }

  function loadTab(more) {
    var m = media;
    if (!m || m.loading || (more && !m.before)) return;
    if (!more) { m.items = null; m.before = null; m.error = ''; m.people = {}; }
    m.loading = true;
    paintTab();
    var tab = m.tab;
    var q = tab === 'files' ? (m.q || '') : '';
    get('/api/chat/tab?' + query(m.ctx) + '&tab=' + tab + (q ? '&q=' + encodeURIComponent(q) : '') + (more ? '&before=' + encodeURIComponent(m.before) : ''))
      .then(function (d) {
        if (media !== m || m.tab !== tab || (m.tab === 'files' && (m.q || '') !== q)) return;
        m.items = (more && m.items ? m.items : []).concat(d.items);
        m.before = d.before;
        Object.assign(m.people, d.people || {});
      })
      .catch(function (e) { if (media === m) m.error = e.message; })
      .finally(function () {
        if (media !== m) return;
        m.loading = false;
        paintTab();
        fill();
      });
  }

  // Страница не заполнила экран — следующую сразу, иначе листать нечего.
  function fill() {
    var body = media && media.root && media.root.closest('.tk-gpane__body');
    if (body && media.before && !media.loading && body.scrollHeight - body.scrollTop - body.clientHeight < body.clientHeight) loadTab(true);
  }

  function who(id) {
    var p = media.people && media.people[id];
    return p ? p.displayName : C.nameOf(id);
  }

  function when(at) { return tkDate(at); }

  function itemHtml(x, i) {
    var a = x.a;
    if (media.tab === 'media') {
      var thumb = a.preview || (a.kind === 'image' ? a.url : '');
      return '<button type="button" class="tk-cinfo__tile" data-ci-item="' + i + '" aria-label="' + escapeHtml(t('chats.att.' + a.kind)) + ', ' + escapeHtml(when(x.sentAt)) + '">' +
        (thumb ? '<img src="' + escapeHtml(C.src(thumb)) + '" alt="" loading="lazy" decoding="async">' : '') +
        (a.kind === 'video' ? '<span class="tk-cinfo__len">' + svg('play', 12) + (a.duration ? escapeHtml(C.clock(a.duration)) : '') + '</span>' : '') +
      '</button>';
    }
    var go = '<button type="button" class="tk-chat__tool" data-ci-goto="' + i + '" aria-label="' + escapeHtml(t('chatinfo.goto')) + '" title="' + escapeHtml(t('chatinfo.goto')) + '">' + svg('goto', 18) + '</button>';
    if (media.tab === 'shares') {
      var s = x.share;
      return '<div class="tk-cinfo__line">' +
        '<a class="tk-cinfo__main" href="' + escapeHtml(s.url) + '">' +
          '<span class="tk-cinfo__thumb">' + (s.image ? '<img src="' + escapeHtml(C.src(s.image)) + '" alt="" loading="lazy" onerror="this.remove()">' : '') + '</span>' +
          '<span class="tk-cinfo__text"><span class="tk-cinfo__title">' + escapeHtml(s.title || t('chats.att.share')) + '</span>' +
          '<span class="tk-cinfo__meta">' + escapeHtml([s.author, when(x.sentAt)].filter(Boolean).join(' · ')) + '</span></span>' +
        '</a>' + go + '</div>';
    }
    if (media.tab === 'files') {
      return '<div class="tk-cinfo__line">' +
        '<a class="tk-cinfo__main" href="' + escapeHtml(C.src(a.url)) + '" download="' + escapeHtml(a.name || '') + '" target="_blank" rel="noopener" aria-label="' + escapeHtml(t('chatinfo.download')) + ': ' + escapeHtml(a.name || '') + '">' +
          '<span class="tk-cinfo__thumb tk-cinfo__thumb--icon">' + svg(a.kind === 'audio' ? 'music' : 'file') + '</span>' +
          '<span class="tk-cinfo__text"><span class="tk-cinfo__title">' + escapeHtml(a.name || t('chats.att.' + a.kind)) + '</span>' +
          '<span class="tk-cinfo__meta">' + escapeHtml([a.size ? C.fileSize(a.size) : '', who(x.sender), when(x.sentAt)].filter(Boolean).join(' · ')) + '</span></span>' +
        '</a>' + go + '</div>';
    }
    // Голосовые и кружки — к сообщению в ленте: там их и слушают.
    return '<div class="tk-cinfo__line">' +
      '<button type="button" class="tk-cinfo__main" data-ci-goto="' + i + '">' +
        '<span class="tk-cinfo__thumb tk-cinfo__thumb--icon">' + svg(a.kind === 'round' ? 'round' : 'mic') + '</span>' +
        '<span class="tk-cinfo__text"><span class="tk-cinfo__title">' + escapeHtml(who(x.sender)) + '</span>' +
        '<span class="tk-cinfo__meta">' + escapeHtml([a.duration ? C.clock(a.duration) : '', when(x.sentAt)].filter(Boolean).join(' · ')) + '</span></span>' +
      '</button></div>';
  }

  function paintTab() {
    if (!media || !media.root) return;
    media.root.querySelectorAll('[data-ci-tab]').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-ci-tab') === media.tab)); });
    media.root.querySelector('.tk-cinfo__filefind').hidden = media.tab !== 'files';
    var box = media.root.querySelector('.tk-cinfo__items');
    var items = media.items || [];
    var note = media.error ? t('chatinfo.loadFailed', { why: media.error })
      : media.loading ? t('chatinfo.loading')
      : !items.length ? t(media.tab === 'files' && media.q ? 'chatinfo.findNone' : 'chatinfo.empty') : '';
    box.className = 'tk-cinfo__items' + (media.tab === 'media' ? ' tk-cinfo__items--grid' : '');
    box.innerHTML = items.map(itemHtml).join('') +
      (note ? '<p class="tk-note tk-note--center tk-cinfo__note">' + escapeHtml(note) + '</p>' : '') +
      (media.error ? '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs tk-cinfo__retry" data-ci="retry">' + escapeHtml(t('common.retry')) + '</button>' : '');
  }

  // Перейти к сообщению: экран закрывается, лента встаёт к нему.
  function gotoItem(x) {
    if (pane.hidden) window.TKGroups && window.TKGroups.close(); else close();
    C.reveal(x.id);
  }

  function openItem(x) {
    var a = x.a;
    var go = function () { gotoItem(x); };
    if (a.kind === 'image') C.showImage(a.url, go);
    else C.showVideo(a.url, a.preview, go);
  }

  // Вкладки — одни на панель диалога и экран группы: события ловит
  // документ, root — куда нарисованы.
  function onMediaClick(e) {
    if (!media || !media.root || !media.root.contains(e.target)) return false;
    var tabBtn = e.target.closest('[data-ci-tab]');
    if (tabBtn) {
      var name = tabBtn.getAttribute('data-ci-tab');
      if (name !== media.tab) { media.tab = name; loadTab(); }
      return true;
    }
    var item = e.target.closest('[data-ci-item]');
    if (item) { openItem(media.items[Number(item.getAttribute('data-ci-item'))]); return true; }
    var go = e.target.closest('[data-ci-goto]');
    if (go) { e.preventDefault(); gotoItem(media.items[Number(go.getAttribute('data-ci-goto'))]); return true; }
    if (e.target.closest('[data-ci="retry"]')) { loadTab(); return true; }
    return false;
  }

  var fileTimer = null;
  document.addEventListener('input', function (e) {
    if (!e.target.hasAttribute('data-ci-filefind') || !media) return;
    clearTimeout(fileTimer);
    var q = e.target.value.trim();
    fileTimer = setTimeout(function () {
      if (!media || (media.q || '') === q) return;
      media.q = q;
      loadTab();
    }, 300);
  });

  document.addEventListener('scroll', function (e) {
    if (media && media.root && e.target.classList && e.target.classList.contains('tk-gpane__body') && e.target.contains(media.root)) fill();
  }, true);

  // ── Действия панели ───────────────────────────────────────────────────
  pane.addEventListener('click', function (e) {
    if (onMediaClick(e)) return;
    var g = e.target.closest('[data-ci-group]');
    if (g) {
      var brief = info.groups.find(function (x) { return x.id === g.getAttribute('data-ci-group'); });
      close();
      return C.openGroup(brief);
    }
    var btn = e.target.closest('[data-ci]');
    if (!btn || !info && btn.getAttribute('data-ci') !== 'close') return;
    var act = btn.getAttribute('data-ci');
    var p = info && info.peer;
    if (act === 'close') return close();
    if (act === 'audio' || act === 'video') return C.call(act);
    if (act === 'search') { close(); return find.open({ peerId: p.id }); }
    if (act === 'bio') return btn.setAttribute('aria-expanded', String(btn.getAttribute('aria-expanded') !== 'true'));
    if (act === 'rename') { renaming = true; return repaintCard(); }
    if (act === 'rename-cancel') { renaming = false; return repaintCard(); }
    if (act === 'mute') {
      return toggleMute({ peerId: p.id }, info.muted).then(function (until) {
        if (until === undefined || !info) return;
        info.muted = until;
        paintMute(pane, until);
      });
    }
    // Контакты, ограничение и удаление — те же функции, что у меню человека
    // в списках (chats.js); панель перерисовывается по их итогу.
    var after = function () { if (info) paint(); };
    if (act === 'contact-add') return C.addContact().then(after);
    if (act === 'contact-remove') return C.removeContact().then(after);
    if (act === 'favorite' || act === 'unfavorite') return C.setFavorite(act === 'favorite').then(after);
    if (act === 'restrict' || act === 'unrestrict') {
      return C.setRestricted(act === 'restrict').then(function () {
        if (!info) return;
        info.restricted = C.restricted() ? 'me' : null;
        paint();
      });
    }
    if (act === 'delete') return C.deleteChat();
  });

  pane.addEventListener('submit', function (e) {
    var form = e.target.closest('[data-ci-form="rename"]');
    if (!form) return;
    e.preventDefault();
    rename(form.name.value.trim());
  });

  // Контакты сменились (здесь или в меню списка) — строки панели тоже.
  document.addEventListener('tk:contacts', function () {
    if (info && !renaming && pane.querySelector('.tk-cinfo__rows')) paint();
  });

  // ── Экран группы (tk-groups.js) ───────────────────────────────────────
  // Те же действия — «без звука» и поиск — и те же вкладки. Экран группы
  // перерисовывается целиком при каждой правке: открытая вкладка и её
  // страницы остаются, пока это та же группа.
  function groupBlock(g) {
    if (!media || !media.ctx.groupId || media.ctx.groupId !== g.id) media = { ctx: { groupId: g.id }, tab: 'media' };
    media.mutedUntil = g.mutedUntil || null;
    return '<div class="tk-cinfo__acts">' + muteHtml(media.mutedUntil) + tool('search', 'search', t('chatinfo.search')) + '</div>';
  }

  function groupMedia() { return mediaHtml(); }

  function groupMount(root) {
    if (!media || !media.ctx.groupId) return;
    media.root = root.querySelector('.tk-cinfo__media');
    if (media.items) { paintTab(); fill(); } else loadTab();
  }

  var gpane = $('groupPane');
  if (gpane) {
    gpane.addEventListener('click', function (e) {
      if (onMediaClick(e)) return;
      var btn = e.target.closest('[data-ci]');
      if (!btn || !media || !media.ctx.groupId) return;
      var act = btn.getAttribute('data-ci');
      var ctx = { groupId: media.ctx.groupId };
      if (act === 'search') { window.TKGroups.close(); return find.open(ctx); }
      if (act === 'mute') {
        toggleMute(ctx, media.mutedUntil).then(function (until) {
          if (until === undefined || !media) return;
          media.mutedUntil = until;
          paintMute(gpane, until);
        });
      }
    });
  }

  // ── Поиск по переписке ────────────────────────────────────────────────
  var find = (function () {
    var bar = $('findBar');
    var field = $('findInput');
    var listBox = $('findList');
    var pos = $('findPos');
    var head = document.querySelector('.tk-chat__head');
    var st = null;          // { ctx, q, hits, before, at, loading, people, error }
    var timer = null;

    function open(ctx) {
      st = { ctx: ctx, q: '', hits: [], before: null, at: -1, people: {} };
      head.hidden = true;
      bar.hidden = false;
      field.value = '';
      paint();
      field.focus();
    }

    function stop() {
      if (!st) return;
      st = null;
      clearTimeout(timer);
      bar.hidden = true;
      listBox.hidden = true;
      listBox.innerHTML = '';
      head.hidden = false;
    }

    function rx(q) {
      return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[её]/gi, '[её]'), 'gi');
    }

    function hitHtml(h, i) {
      var name = st.people[h.sender] ? st.people[h.sender].displayName : C.nameOf(h.sender);
      var text = escapeHtml(h.text).replace(rx(escapeHtml(st.q)), function (m) { return '<mark>' + m + '</mark>'; });
      return '<button type="button" class="tk-chat__hit' + (i === st.at ? ' is-on' : '') + '" role="option" aria-selected="' + (i === st.at) + '" data-hit="' + i + '">' +
        '<span class="tk-chat__hit-top"><span class="tk-chat__hit-name">' + escapeHtml(name) + '</span><time>' + escapeHtml(tkDate(h.sentAt)) + '</time></span>' +
        '<span class="tk-chat__hit-text">' + (h.kind ? '<span>' + escapeHtml(t('chats.att.' + h.kind)) + '</span> · ' : '') + text + '</span></button>';
    }

    function paint() {
      var n = st.hits.length;
      pos.textContent = st.at >= 0 ? t('chatinfo.findPos', { i: st.at + 1, n: n + (st.before ? '+' : '') }) : '';
      $('findPrev').disabled = !(st.at >= 0 && (st.at < n - 1 || st.before));
      $('findNext').disabled = !(st.at > 0);
    }

    function paintList() {
      if (!st || !st.q) { listBox.hidden = true; return; }
      var note = st.error ? t('chatinfo.findFailed', { why: st.error })
        : st.loading && !st.hits.length ? t('chatinfo.loading')
        : !st.hits.length ? t('chatinfo.findNone') : '';
      listBox.style.top = (bar.offsetTop + bar.offsetHeight) + 'px';
      listBox.innerHTML = st.hits.map(hitHtml).join('') +
        (note ? '<p class="tk-note tk-note--center">' + escapeHtml(note) + '</p>' : '') +
        (st.before && st.loading ? '<p class="tk-note tk-note--center">' + escapeHtml(t('chatinfo.loading')) + '</p>' : '');
      listBox.hidden = false;
    }

    function search(more) {
      var s = st;
      if (!s || !s.q || s.loading || (more && !s.before)) return Promise.resolve();
      s.loading = true;
      s.error = '';
      if (!more) { s.hits = []; s.before = null; s.at = -1; }
      paintList();
      paint();
      var q = s.q;
      return get('/api/chat/search?' + query(s.ctx) + '&q=' + encodeURIComponent(q) + (more ? '&before=' + encodeURIComponent(s.before) : ''))
        .then(function (d) {
          if (st !== s || s.q !== q) return;
          s.hits = s.hits.concat(d.hits);
          s.before = d.before;
          Object.assign(s.people, d.people || {});
        })
        .catch(function (e) { if (st === s) s.error = e.message; })
        .finally(function () {
          if (st !== s) return;
          s.loading = false;
          if (!listBox.hidden) paintList();
          paint();
        });
    }

    function pick(i) {
      if (!st || !st.hits[i]) return;
      st.at = i;
      listBox.hidden = true;
      paint();
      C.reveal(st.hits[i].id);
    }

    field.addEventListener('input', function () {
      clearTimeout(timer);
      var q = field.value.trim();
      timer = setTimeout(function () {
        if (!st || q === st.q) return;
        st.q = q;
        if (!q) { st.hits = []; st.at = -1; paintList(); paint(); return; }
        search(false);
      }, 350);
    });
    field.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (st && st.hits.length) pick(st.at >= 0 ? st.at : 0);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (!listBox.hidden && st && st.at >= 0) listBox.hidden = true;
        else stop();
      }
    });
    // Снова в поле — снова список.
    field.addEventListener('focus', function () { if (st && st.q) paintList(); });

    listBox.addEventListener('click', function (e) {
      var h = e.target.closest('[data-hit]');
      if (h) pick(Number(h.getAttribute('data-hit')));
    });
    listBox.addEventListener('scroll', function () {
      if (st && st.before && !st.loading && listBox.scrollHeight - listBox.scrollTop - listBox.clientHeight < 120) search(true);
    }, { passive: true });

    // Стрелки: вверх — раньше (дальше по списку), вниз — позже.
    $('findPrev').addEventListener('click', function () {
      if (!st) return;
      var i = st.at + 1;
      if (st.hits[i]) return pick(i);
      search(true).then(function () { if (st && st.hits[i]) pick(i); });
    });
    $('findNext').addEventListener('click', function () { if (st && st.at > 0) pick(st.at - 1); });
    $('findClose').addEventListener('click', stop);

    document.addEventListener('tk:chat:switch', stop);
    document.addEventListener('tk:lang', function () { if (st) { paint(); if (!listBox.hidden) paintList(); } });

    return { open: open, stop: stop };
  })();

  document.addEventListener('tk:chat:switch', function () { if (!pane.hidden) close(); media = null; });
  document.addEventListener('tk:lang', function () { if (info && !pane.hidden) paint(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !pane.hidden && !document.querySelector('.tb-dialog, .tk-lightbox:not(.hidden)')) close();
  });
  // Собеседник ограничил или вернул доступ — звонки и строки панели.
  document.addEventListener('tk:access:changed', function (e) {
    if (!info || !e.detail || e.detail.peerId !== info.peer.id) return;
    info.restricted = e.detail.restricted ? e.detail.by : null;
    paint();
  });

  window.TKChatInfo = { open: open, close: close, groupBlock: groupBlock, groupMedia: groupMedia, groupMount: groupMount };
})();
