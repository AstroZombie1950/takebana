/* Переписка: список диалогов, лента, отправка, пересылка, удаление,
 * статусы «доставлено» и «прочитано».
 *
 * Новое приходит сокетом: tk-app.js пересылает события сервера в document
 * как tk:message:new, tk:message:read и т. д. Раньше открытый диалог
 * опрашивал сервер раз в три секунды, а о прочтении никто не узнавал.
 */
(function () {
  var t = window.t || function () { return ''; };
  var tkText = window.tkText || function () {};
  var ME = (window.TK && window.TK.userId) || '';
  var PAGE = 15;

  var $ = function (id) { return document.getElementById(id); };
  var feed = $('feed');
  var list = $('conversationsList');
  var input = $('messageInput');

  var peer = null;          // { id, name, url, bg, initial }
  var messages = [];        // лента открытого диалога, от старых к новым
  var loadingOld = false;
  var allLoaded = false;

  function uiLang() { return window.tkLang ? window.tkLang() : 'ru'; }

  // «5 минут назад» на языке интерфейса — так же, как сервер
  // (routes/streaming/messages.js).
  var AGO_STEPS = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  function timeAgo(value) {
    var sec = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    var step = AGO_STEPS.find(function (x) { return sec >= x[1]; }) || AGO_STEPS[AGO_STEPS.length - 1];
    return new Intl.RelativeTimeFormat(uiLang(), { numeric: 'auto' }).format(-Math.floor(sec / step[1]), step[0]);
  }

  function refreshTimes() {
    document.querySelectorAll('[data-time]').forEach(function (el) {
      el.textContent = timeAgo(el.getAttribute('data-time'));
    });
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.message || 'HTTP ' + r.status);
        return data;
      });
    });
  }

  // ── Аватар ────────────────────────────────────────────────────────────
  // Фото — картинкой, без фото — градиент с буквой. Раньше фото узнавали по
  // началу адреса «http», а загруженные аватары лежат по /uploads/… — и вместо
  // фото рисовался фон с адресом внутри.
  function avatar(cls, p, attrs) {
    if (p.url) return '<span class="' + cls + '"' + (attrs || '') + '><img src="' + escapeHtml(p.url) + '" alt=""></span>';
    return '<span class="' + cls + '"' + (attrs || '') + ' style="background: ' + escapeHtml(p.bg || '') + '">' + escapeHtml(p.initial || '?') + '</span>';
  }

  function peerOf(el) {
    return {
      id: el.getAttribute('data-id'),
      name: el.getAttribute('data-name'),
      url: el.getAttribute('data-ava-url'),
      bg: el.getAttribute('data-ava-bg'),
      initial: el.getAttribute('data-ava-initial')
    };
  }

  function dialogEl(id) {
    return list.querySelector('.tk-dialog[data-id="' + CSS.escape(String(id)) + '"]');
  }

  // ── Лента ─────────────────────────────────────────────────────────────
  var TICK = '<path d="M3 12.5l4.5 4.5L17 7.5"></path>';
  var TICKS = '<path d="M1.5 12.5 6 17l9.5-9.5"></path><path d="M11 16.5l.5.5L21 7.5"></path>';

  function status(m) {
    if (m.readAt) return { key: 'chats.status.read', cls: 'is-read', icon: TICKS };
    if (m.deliveredAt) return { key: 'chats.status.delivered', cls: '', icon: TICKS };
    return { key: 'chats.status.sent', cls: '', icon: TICK };
  }

  function messageHtml(m) {
    var out = m.sender === ME;
    var fwd = m.forwardedFrom
      ? '<span class="tk-msg__fwd">' + escapeHtml(t('chats.forwardedFrom', { name: m.forwardedFrom.name })) + '</span>'
      : '';
    var bubble = '<div class="tk-msg__bubble" tabindex="0" role="button" aria-haspopup="menu" aria-label="' + escapeHtml(t('chats.actions')) + '">' +
      fwd + '<p class="tk-msg__text">' + escapeHtml(m.content) + '</p></div>';
    var when = '<time>' + escapeHtml(tkDate(m.sentAt)) + '</time>';
    if (out) {
      var s = status(m);
      when += ' <svg class="tk-msg__tick ' + s.cls + '" viewBox="0 0 22 24" width="17" height="16" fill="none" stroke="currentColor" stroke-width="2" role="img" aria-label="' +
        escapeHtml(t(s.key)) + '"><title>' + escapeHtml(t(s.key)) + '</title>' + s.icon + '</svg>';
    }
    return '<div class="tk-msg ' + (out ? 'tk-msg--out' : 'tk-msg--in') + '" data-mid="' + escapeHtml(m._id) + '">' +
      (out ? bubble : '<div class="tk-msg__row">' + avatar('tk-msg__ava', peer, ' data-peer') + bubble + '</div>') +
      '<p class="tk-msg__when">' + when + '</p></div>';
  }

  function render() {
    if (!messages.length) {
      feed.innerHTML = '<p class="tk-note tk-note--center">' + escapeHtml(t('chats.dialogEmpty')) + '</p>';
      return;
    }
    feed.innerHTML = messages.map(messageHtml).join('');
  }

  function atBottom() {
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  }

  function scrollToBottom() {
    feed.scrollTop = feed.scrollHeight;
  }

  function merge(fresh) {
    var seen = {};
    messages.forEach(function (m) { seen[m._id] = true; });
    fresh.forEach(function (m) { if (!seen[m._id]) messages.push(m); });
    messages.sort(function (a, b) { return new Date(a.sentAt) - new Date(b.sentAt); });
  }

  function load(recipientId, offset) {
    return fetch('/getMessages?recipientId=' + encodeURIComponent(recipientId) + '&offset=' + offset)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  function openHistory() {
    var id = peer.id;
    load(id, 0).then(function (page) {
      if (!peer || peer.id !== id) return;
      messages = page;
      allLoaded = page.length < PAGE;
      render();
      scrollToBottom();
      markRead();
    }).catch(function (e) { console.error('getMessages:', e); });
  }

  // Прокрутили к началу — дозагрузка старых. Высоту запоминаем до отрисовки,
  // иначе лента прыгает.
  feed.addEventListener('scroll', function () {
    if (!peer || loadingOld || allLoaded || feed.scrollTop > 40) return;
    loadingOld = true;
    var id = peer.id;
    load(id, messages.length).then(function (page) {
      if (!peer || peer.id !== id) return;
      allLoaded = page.length < PAGE;
      var before = feed.scrollHeight;
      merge(page);
      render();
      feed.scrollTop = feed.scrollHeight - before;
    }).catch(function (e) { console.error('getMessages (старые):', e); })
      .finally(function () { loadingOld = false; });
  });

  // ── Прочтение ─────────────────────────────────────────────────────────
  // Входящие открытого диалога читаются, только пока вкладку видно: иначе
  // собеседник видел бы «прочитано» у сообщения, которого никто не видел.
  function markRead() {
    if (!peer || document.visibilityState !== 'visible') return;
    var unread = messages.some(function (m) { return m.sender === peer.id && !m.readAt; });
    var el = dialogEl(peer.id);
    var badge = el && el.querySelector('.tk-dialog__unread');
    if (!unread && !(badge && !badge.classList.contains('hidden'))) return;
    var now = new Date().toISOString();
    messages.forEach(function (m) { if (m.sender === peer.id && !m.readAt) m.readAt = now; });
    if (badge) { badge.textContent = '0'; badge.classList.add('hidden'); }
    post('/messages/read', { peerId: peer.id })
      .then(function (r) { if (window.setNotificationDot) window.setNotificationDot(r.unread > 0); })
      .catch(function (e) { console.error('read:', e); });
  }

  document.addEventListener('visibilitychange', markRead);

  // ── Список диалогов ───────────────────────────────────────────────────
  function setLast(el, m) {
    var last = el.querySelector('.tk-dialog__last');
    last.innerHTML = (m.sender === ME ? '<span data-i18n="chats.you">' + escapeHtml(t('chats.you')) + '</span> ' : '') + escapeHtml(m.content);
    var when = el.querySelector('.tk-dialog__when');
    when.setAttribute('data-time', m.sentAt);
    when.textContent = timeAgo(m.sentAt);
    list.prepend(el);
  }

  function addDialog(p) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'tk-dialog';
    el.setAttribute('data-id', p.id);
    el.setAttribute('data-name', p.displayName);
    el.setAttribute('data-ava-url', p.avatarStyle.url || '');
    el.setAttribute('data-ava-bg', p.avatarStyle.gradient || '');
    el.setAttribute('data-ava-initial', p.avatarStyle.initial || '');
    el.setAttribute('data-presence-user', p.id);
    el.innerHTML =
      avatar('tk-dialog__ava', peerOf(el)) +
      '<span class="tk-dialog__body">' +
        '<span class="tk-dialog__top"><span class="tk-dialog__who"><span class="tk-dialog__name">' + escapeHtml(p.displayName) + '</span>' +
        '<span class="presence-dot presence-offline"></span></span><span class="tk-dialog__when"></span></span>' +
        '<span class="tk-dialog__bottom"><span class="tk-dialog__last"></span><span class="tk-dialog__unread hidden">0</span></span>' +
      '</span>';
    list.prepend(el);
    $('conversationsEmpty').classList.add('hidden');
    if (window.subscribePresence) window.subscribePresence([p.id]);
    return el;
  }

  list.addEventListener('click', function (e) {
    var el = e.target.closest('.tk-dialog');
    if (el) select(el);
  });

  // ── Выбор диалога ─────────────────────────────────────────────────────
  function select(el) {
    peer = peerOf(el);
    messages = [];
    allLoaded = false;
    feed.innerHTML = '';

    list.querySelectorAll('.tk-dialog').forEach(function (d) {
      d.classList.toggle('tk-dialog--on', d === el);
    });

    var name = $('peerName');
    name.textContent = peer.name;
    name.removeAttribute('data-i18n'); // иначе переключение языка вернёт «Выберите диалог»
    tkText($('peerNote'), '');
    $('chatAvatar').outerHTML = avatar('tk-chat__ava-big', peer, ' id="chatAvatar"');
    $('deleteChat').classList.remove('hidden');

    var presence = $('chatHeaderPresence');
    presence.setAttribute('data-presence-user', peer.id);
    presence.querySelector('.presence-dot').classList.remove('hidden');
    if (window.subscribePresence) window.subscribePresence([peer.id]);
    fetch('/api/presence?ids=' + encodeURIComponent(peer.id))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var u = (data.users || [])[0];
        if (u) window.dispatchEvent(new CustomEvent('presence:init', { detail: u }));
      })
      .catch(function () {});

    input.removeAttribute('data-i18n-placeholder');
    input.placeholder = t('chats.messageTo') + ' ' + peer.name + '…';

    history.replaceState(null, '', '/chatsPage?peer=' + encodeURIComponent(peer.id));
    $('chat').classList.add('is-open');
    openHistory();
  }

  function closeDialog() {
    peer = null;
    messages = [];
    feed.innerHTML = '';
    tkText($('peerName'), 'chats.pick');
    tkText($('peerNote'), 'chats.startHint');
    $('deleteChat').classList.add('hidden');
    $('chatHeaderPresence').querySelector('.presence-dot').classList.add('hidden');
    list.querySelectorAll('.tk-dialog--on').forEach(function (d) { d.classList.remove('tk-dialog--on'); });
    input.setAttribute('data-i18n-placeholder', 'chats.messagePh');
    input.placeholder = t('chats.messagePh');
    history.replaceState(null, '', '/chatsPage');
    $('chat').classList.remove('is-open');
  }

  $('backToList').addEventListener('click', function () {
    $('chat').classList.remove('is-open');
  });

  function goToPeer() {
    if (peer) location.href = '/userPage/' + encodeURIComponent(peer.id);
  }
  $('peerLink').addEventListener('click', goToPeer);

  // ── Отправка ──────────────────────────────────────────────────────────
  $('composeForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var content = input.value.trim();
    if (!peer || !content) {
      toast(t('chats.pickAndType'), 'error');
      return;
    }
    input.value = '';
    post('/sendMessage', { recipientId: peer.id, content: content })
      .then(function (m) {
        merge([m]);
        render();
        scrollToBottom();
        var el = dialogEl(m.recipient);
        if (el) setLast(el, m);
      })
      .catch(function (err) {
        console.error('sendMessage:', err);
        if (!input.value) input.value = content; // текст не теряем
        toast(t('chats.sendFailed'), 'error');
      });
  });

  // ── События сокета ────────────────────────────────────────────────────
  document.addEventListener('tk:message:new', function (e) {
    var m = e.detail.message;
    var p = e.detail.peer;
    var el = dialogEl(p.id) || addDialog(p);
    setLast(el, m);

    if (peer && peer.id === p.id) {
      var stick = atBottom() || m.sender === ME;
      merge([m]);
      render();
      if (stick) scrollToBottom();
      markRead();
    } else if (m.sender !== ME) {
      var badge = el.querySelector('.tk-dialog__unread');
      badge.textContent = String((parseInt(badge.textContent, 10) || 0) + 1);
      badge.classList.remove('hidden');
    }
  });

  document.addEventListener('tk:message:delivered', function (e) {
    var ids = e.detail.ids || [];
    var changed = false;
    messages.forEach(function (m) {
      if (ids.indexOf(m._id) !== -1 && !m.deliveredAt) { m.deliveredAt = e.detail.at; changed = true; }
    });
    if (changed) render();
  });

  document.addEventListener('tk:message:read', function (e) {
    if (!peer || peer.id !== e.detail.readerId) return;
    var changed = false;
    messages.forEach(function (m) {
      if (m.sender === ME && !m.readAt && new Date(m.sentAt) <= new Date(e.detail.at)) {
        m.readAt = e.detail.at;
        m.deliveredAt = m.deliveredAt || e.detail.at;
        changed = true;
      }
    });
    if (changed) render();
  });

  document.addEventListener('tk:message:deleted', function (e) {
    var ids = e.detail.ids || [];
    var before = messages.length;
    messages = messages.filter(function (m) { return ids.indexOf(m._id) === -1; });
    if (messages.length === before) return;
    var top = feed.scrollTop;
    render();
    feed.scrollTop = top;
    var last = messages[messages.length - 1];
    var el = peer && dialogEl(peer.id);
    if (el && last) el.querySelector('.tk-dialog__last').innerHTML =
      (last.sender === ME ? '<span data-i18n="chats.you">' + escapeHtml(t('chats.you')) + '</span> ' : '') + escapeHtml(last.content);
  });

  document.addEventListener('tk:conversation:deleted', function (e) {
    var el = dialogEl(e.detail.peerId);
    if (el) el.remove();
    if (peer && peer.id === e.detail.peerId) closeDialog();
    if (!list.querySelector('.tk-dialog')) $('conversationsEmpty').classList.remove('hidden');
  });

  // Пока сокета не было, что-то могло прийти или прочитаться — перечитываем
  // открытый диалог целиком.
  document.addEventListener('tk:reconnect', function () {
    if (peer) openHistory();
  });

  // ── Действия с сообщением ─────────────────────────────────────────────
  var menu = $('msgMenu');
  var menuFor = null;

  function openMenu(bubble) {
    var row = bubble.closest('.tk-msg');
    menuFor = messages.find(function (m) { return m._id === row.getAttribute('data-mid'); });
    if (!menuFor) return;
    menu.hidden = false;
    var r = bubble.getBoundingClientRect();
    var w = menu.offsetWidth;
    var h = menu.offsetHeight;
    var left = row.classList.contains('tk-msg--out') ? r.right - w : r.left;
    var top = r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6;
    menu.style.left = Math.max(8, Math.min(left, innerWidth - w - 8)) + 'px';
    menu.style.top = Math.max(8, top) + 'px';
    menu.querySelector('button').focus();
  }

  function closeMenu() {
    menu.hidden = true;
  }

  feed.addEventListener('click', function (e) {
    if (e.target.closest('[data-peer]')) return goToPeer();
    var bubble = e.target.closest('.tk-msg__bubble');
    // Выделяли текст мышью — это не нажатие.
    if (!bubble || !window.getSelection().isCollapsed) return;
    e.stopPropagation();
    openMenu(bubble);
  });

  feed.addEventListener('keydown', function (e) {
    var bubble = e.target.closest('.tk-msg__bubble');
    if (bubble && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openMenu(bubble); }
  });

  document.addEventListener('click', function (e) {
    if (!menu.hidden && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !menu.hidden) closeMenu();
  });
  feed.addEventListener('scroll', closeMenu);

  menu.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn || !menuFor) return;
    var m = menuFor;
    closeMenu();
    var act = btn.getAttribute('data-act');
    if (act === 'copy') copy(m);
    else if (act === 'delete') removeMessage(m);
    else if (act === 'forward') openForward(m);
  });

  function copy(m) {
    navigator.clipboard.writeText(m.content)
      .then(function () { toast(t('chats.copied'), 'ok'); })
      .catch(function () {});
  }

  function removeMessage(m) {
    var mine = m.sender === ME;
    var choices = mine
      ? [{ value: 'me', text: t('chats.deleteForMe'), danger: false }, { value: 'all', text: t('chats.deleteForAll') }]
      : [{ value: 'me', text: t('chats.delete') }];
    chooseDialog(t('chats.deleteMsgQ'), choices).then(function (v) {
      if (!v) return;
      return post('/messages/delete', { ids: [m._id], forAll: v === 'all' });
    }).catch(function (e) { toast(t('chats.deleteFailed') + ': ' + e.message, 'error'); });
  }

  $('deleteChat').addEventListener('click', function () {
    if (!peer) return;
    var p = peer;
    chooseDialog(t('chats.deleteChatQ', { name: p.name }), [
      { value: 'me', text: t('chats.deleteForMe'), danger: false },
      { value: 'all', text: t('chats.deleteChatForAll') }
    ]).then(function (v) {
      if (!v) return;
      return post('/conversations/delete', { peerId: p.id, forAll: v === 'all' });
    }).catch(function (e) { toast(t('chats.deleteFailed') + ': ' + e.message, 'error'); });
  });

  // ── Пересылка ─────────────────────────────────────────────────────────
  var fwd = $('forwardModal');
  var fwdList = $('forwardList');
  var fwdSearch = $('forwardSearch');
  var fwdSend = $('forwardSend');
  var fwdMessage = null;
  var fwdPicked = {};      // id → true
  var fwdTimer = null;

  // Кандидаты — собеседники из списка слева; поиск добавляет остальных.
  function known() {
    return Array.prototype.map.call(list.querySelectorAll('.tk-dialog'), peerOf);
  }

  function fwdRender(people) {
    if (!people.length) {
      fwdList.innerHTML = '<p class="tk-note tk-note--center">' + escapeHtml(t('chats.forwardEmpty')) + '</p>';
      return;
    }
    fwdList.innerHTML = people.map(function (p) {
      return '<label class="tk-fwd__row">' +
        '<input type="checkbox" value="' + escapeHtml(p.id) + '"' + (fwdPicked[p.id] ? ' checked' : '') + '>' +
        avatar('tk-fwd__ava', p) +
        '<span class="tk-fwd__name">' + escapeHtml(p.name) + '</span></label>';
    }).join('');
  }

  function fwdCount() {
    var n = Object.keys(fwdPicked).length;
    fwdSend.disabled = !n;
    $('forwardCount').textContent = n ? '\u00a0(' + n + ')' : '';
  }

  function openForward(m) {
    fwdMessage = m;
    fwdPicked = {};
    fwdSearch.value = '';
    $('forwardQuote').textContent = m.content;
    fwdRender(known());
    fwdCount();
    fwd.classList.remove('hidden');
    fwdSearch.focus();
  }

  function closeForward() {
    fwd.classList.add('hidden');
    fwdMessage = null;
  }

  $('forwardClose').addEventListener('click', closeForward);
  fwd.addEventListener('click', function (e) { if (e.target === fwd) closeForward(); });

  fwdList.addEventListener('change', function (e) {
    var box = e.target;
    if (box.checked) fwdPicked[box.value] = true;
    else delete fwdPicked[box.value];
    fwdCount();
  });

  fwdSearch.addEventListener('input', function () {
    clearTimeout(fwdTimer);
    var q = fwdSearch.value.trim();
    var mine = known().filter(function (p) { return p.name.toLowerCase().indexOf(q.toLowerCase()) !== -1; });
    fwdRender(mine);
    if (q.length < 2) return;
    fwdTimer = setTimeout(function () {
      fetch('/search-users?q=' + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (users) {
          if (fwdSearch.value.trim() !== q) return;
          var seen = {};
          mine.forEach(function (p) { seen[p.id] = true; });
          var more = users.filter(function (u) { return String(u._id) !== ME && !seen[u._id]; }).map(function (u) {
            var a = u.avatarStyle || {};
            return { id: String(u._id), name: u.displayName, url: a.url, bg: a.gradient, initial: a.initial };
          });
          fwdRender(mine.concat(more));
        })
        .catch(function () {});
    }, 300);
  });

  fwdSend.addEventListener('click', function () {
    if (!fwdMessage) return;
    fwdSend.disabled = true;
    post('/messages/forward', { messageId: fwdMessage._id, recipientIds: Object.keys(fwdPicked) })
      .then(function () {
        toast(t('chats.forwardDone'), 'ok');
        closeForward();
      })
      .catch(function (e) {
        toast(t('chats.forwardFailed') + ': ' + e.message, 'error');
        fwdCount();
      });
  });

  // ── Язык и время ──────────────────────────────────────────────────────
  // Лента, даты и подсказка поля собираются скриптом, а переключатель языка
  // переводит только разметку с ключами — поэтому пересобираем сами.
  document.addEventListener('tk:lang', function () {
    refreshTimes();
    if (!peer) return;
    var fromBottom = feed.scrollHeight - feed.scrollTop;
    render();
    feed.scrollTop = feed.scrollHeight - fromBottom;
    input.placeholder = t('chats.messageTo') + ' ' + peer.name + '…';
  });

  refreshTimes();
  // Подписи «N минут назад» стареют, пока страница открыта.
  setInterval(refreshTimes, 60000);

  // Переход с профиля («Сообщение») или из уведомления: открыть нужный диалог.
  var peerId = new URLSearchParams(location.search).get('peer');
  var target = peerId && dialogEl(peerId);
  if (target) select(target);
})();
