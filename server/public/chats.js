/* Переписка: вкладки «Сообщения» и «Звонки», лента со звонками между
 * сообщениями, отправка, пересылка, удаление, статусы «доставлено»
 * и «прочитано».
 *
 * Новое приходит сокетом: tk-app.js пересылает события сервера в document
 * как tk:message:new, tk:message:read и т. д. Раньше открытый диалог
 * опрашивал сервер раз в три секунды, а о прочтении никто не узнавал.
 */
(function () {
  var t = window.t || function () { return ''; };
  var ME = (window.TK && window.TK.userId) || '';
  var PAGE = 15;

  var $ = function (id) { return document.getElementById(id); };
  var feed = $('feed');
  var list = $('conversationsList');
  var input = $('messageInput');

  var peer = null;          // { id, name, url, bg, initial }
  var messages = [];        // лента открытого диалога, от старых к новым
  var calls = [];           // звонки с собеседником за загруженный отрезок
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
    var key = 'm:' + m._id;
    return '<div class="tk-msg ' + (out ? 'tk-msg--out' : 'tk-msg--in') + (isPicked(key) ? ' is-picked' : '') +
      '" data-mid="' + escapeHtml(m._id) + '" data-key="' + escapeHtml(key) + '">' +
      (out ? bubble : '<div class="tk-msg__row">' + avatar('tk-msg__ava', peer, ' data-peer') + bubble + '</div>') +
      '<p class="tk-msg__when">' + when + '</p></div>';
  }

  // ── Звонки ────────────────────────────────────────────────────────────
  // Одна запись приходит обоим (utils/callLog.js): входящий он или исходящий,
  // пропущенный или отменённый — решаем здесь. Те же подписи у вкладки
  // «Звонки» и у строки звонка в ленте.
  var PHONE = '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2Z"></path>';
  var CAMERA = '<rect x="3" y="6" width="12" height="12"></rect><path d="M15 10l6-3v10l-6-3"></path>';
  var CALL_TIME = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };

  function callInfo(c) {
    var out = c.caller === ME;
    var missed = !out && (c.status === 'missed' || c.status === 'canceled');
    var outcome = missed ? 'calls.missed'
      : c.status === 'declined' ? 'calls.declined'
      : c.status === 'failed' ? 'calls.failed'
      : out && c.status === 'canceled' ? 'calls.canceled'
      : out && c.status === 'missed' ? 'calls.noAnswer'
      : '';
    var parts = [t((out ? 'calls.out.' : 'calls.in.') + c.type)];
    if (outcome) parts.push(t(outcome));
    if (c.duration) parts.push(Math.floor(c.duration / 60) + ':' + String(c.duration % 60).padStart(2, '0'));
    return { out: out, missed: missed, text: parts.join(' · ') };
  }

  // Строка звонка выделяется и удаляется так же, как сообщение: у неё тот же
  // data-key и та же доступность с клавиатуры.
  function callNoteHtml(c) {
    var info = callInfo(c);
    var key = 'c:' + c.id;
    return '<div class="tk-callnote' + (info.missed ? ' is-missed' : '') + (isPicked(key) ? ' is-picked' : '') +
      '" data-key="' + escapeHtml(key) + '" tabindex="0" role="button" aria-haspopup="menu" aria-label="' + escapeHtml(t('chats.callActions')) + '">' +
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" aria-hidden="true">' +
      (c.type === 'video' ? CAMERA : PHONE) + '</svg>' +
      '<span>' + escapeHtml(info.text) + '</span>' +
      '<time>' + escapeHtml(tkDate(c.startedAt, CALL_TIME)) + '</time></div>';
  }

  function render() {
    if (!messages.length && !calls.length) {
      feed.innerHTML = '<p class="tk-note tk-note--center">' + escapeHtml(t('chats.dialogEmpty')) + '</p>';
      return;
    }
    var items = messages.map(function (m) { return { at: m.sentAt, html: messageHtml(m) }; })
      .concat(calls.map(function (c) { return { at: c.startedAt, html: callNoteHtml(c) }; }));
    items.sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
    feed.innerHTML = items.map(function (x) { return x.html; }).join('');
  }

  function atBottom() {
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  }

  function scrollToBottom() {
    feed.scrollTop = feed.scrollHeight;
  }

  function merge(fresh, freshCalls) {
    var seen = {};
    messages.forEach(function (m) { seen[m._id] = true; });
    fresh.forEach(function (m) { if (!seen[m._id]) messages.push(m); });
    messages.sort(function (a, b) { return new Date(a.sentAt) - new Date(b.sentAt); });
    (freshCalls || []).forEach(function (c) {
      if (!calls.some(function (x) { return x.id === c.id; })) calls.push(c);
    });
  }

  // Страница истории: сообщения старше before (без него — последние)
  // и звонки за тот же отрезок.
  function load(recipientId, before) {
    return fetch('/getMessages?recipientId=' + encodeURIComponent(recipientId) + (before ? '&before=' + encodeURIComponent(before) : ''))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  function openHistory() {
    var id = peer.id;
    load(id).then(function (page) {
      if (!peer || peer.id !== id) return;
      messages = page.messages;
      calls = page.calls;
      allLoaded = page.messages.length < PAGE;
      render();
      scrollToBottom();
      markRead();
    }).catch(function (e) { console.error('getMessages:', e); });
  }

  // Прокрутили к началу — дозагрузка старых. Высоту запоминаем до отрисовки,
  // иначе лента прыгает.
  // Пока первая страница не пришла, сообщений нет и дозагружать не от чего:
  // открытие диалога очищает ленту, и прокрутка срабатывала раньше истории
  // (TypeError 'sentAt' из журнала ошибок, 17.09).
  feed.addEventListener('scroll', function () {
    if (!peer || loadingOld || allLoaded || !messages.length || feed.scrollTop > 40) return;
    loadingOld = true;
    var id = peer.id;
    load(id, messages[0].sentAt).then(function (page) {
      if (!peer || peer.id !== id) return;
      allLoaded = page.messages.length < PAGE;
      var before = feed.scrollHeight;
      merge(page.messages, page.calls);
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
    stopPicking();
    closeMenu();
    peer = peerOf(el);
    messages = [];
    calls = [];
    allLoaded = false;
    feed.innerHTML = '';
    setTab('messages');

    list.querySelectorAll('.tk-dialog').forEach(function (d) {
      d.classList.toggle('tk-dialog--on', d === el);
    });

    $('peerName').textContent = peer.name;
    $('chatAvatar').outerHTML = avatar('tk-chat__ava-big', peer, ' id="chatAvatar"');

    var presence = $('chatHeaderPresence');
    presence.setAttribute('data-presence-user', peer.id);
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
    // has-peer — показать правую часть, is-open — на узком экране она
    // вместо списка.
    $('chat').classList.add('has-peer', 'is-open');
    openHistory();
  }

  function closeDialog() {
    stopPicking();
    closeMenu();
    peer = null;
    messages = [];
    calls = [];
    feed.innerHTML = '';
    list.querySelectorAll('.tk-dialog--on').forEach(function (d) { d.classList.remove('tk-dialog--on'); });
    input.setAttribute('data-i18n-placeholder', 'chats.messagePh');
    input.placeholder = t('chats.messagePh');
    history.replaceState(null, '', '/chatsPage');
    $('chat').classList.remove('has-peer', 'is-open');
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
    if (!peer || !content) return;
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
    dropMessages(e.detail.ids || []);
    if (picking) updatePickBar();
  });

  // Звонки, убранные в другой вкладке этого же человека.
  document.addEventListener('tk:call:deleted', function (e) {
    dropCalls(e.detail.ids || []);
    if (picking) updatePickBar();
  });

  document.addEventListener('tk:conversation:deleted', function (e) {
    var el = dialogEl(e.detail.peerId);
    if (el) el.remove();
    if (peer && peer.id === e.detail.peerId) closeDialog();
    if (!list.querySelector('.tk-dialog')) $('conversationsEmpty').classList.remove('hidden');
  });

  // Звонок кончился: строка в ленте открытого диалога с этим человеком
  // и свежий журнал на вкладке «Звонки».
  document.addEventListener('tk:call:logged', function (e) {
    var c = e.detail.call;
    if (peer && (c.caller === peer.id || c.callee === peer.id)) {
      var stick = atBottom();
      merge([], [c]);
      render();
      if (stick) scrollToBottom();
    }
    journalStale = true;
    if (!callsList.hidden) loadJournal();
  });

  // Пока сокета не было, что-то могло прийти или прочитаться — перечитываем
  // открытый диалог целиком.
  document.addEventListener('tk:reconnect', function () {
    if (peer) openHistory();
    journalStale = true;
    if (!callsList.hidden) loadJournal();
  });

  // ── Вкладки ───────────────────────────────────────────────────────────
  var callsList = $('callsList');
  var journal = null;       // звонки вкладки, пока не загружены — null
  var journalStale = true;

  function setTab(name) {
    var onCalls = name === 'calls';
    $('tabMessages').setAttribute('aria-selected', String(!onCalls));
    $('tabCalls').setAttribute('aria-selected', String(onCalls));
    list.hidden = onCalls;
    callsList.hidden = !onCalls;
    var q = new URLSearchParams(location.search);
    if (onCalls) q.set('tab', 'calls'); else q.delete('tab');
    var qs = q.toString();
    history.replaceState(null, '', '/chatsPage' + (qs ? '?' + qs : ''));
    if (onCalls && journalStale) loadJournal();
  }

  document.querySelector('.tk-chat__tabs').addEventListener('click', function (e) {
    var tab = e.target.closest('[data-tab]');
    if (!tab) return;
    e.preventDefault();
    setTab(tab.getAttribute('data-tab'));
  });

  // ── Журнал звонков ────────────────────────────────────────────────────
  // Открыли — пропущенные увидены: сервер гасит их у себя, здесь гаснут
  // счётчики и, если больше нечего читать, колокольчик.
  function loadJournal() {
    journalStale = false;
    fetch('/api/calls')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        journal = data.calls;
        renderJournal();
        document.querySelectorAll('[data-missed-calls]').forEach(function (b) {
          b.textContent = '0';
          b.classList.add('hidden');
        });
        if (window.setNotificationDot) window.setNotificationDot(data.unread > 0);
      })
      .catch(function (e) { journalStale = true; console.error('calls:', e); });
  }

  function journalPeer(c) {
    var a = c.peer.avatarStyle || {};
    return { id: c.peer.id, name: c.peer.displayName, url: a.url, bg: a.gradient, initial: a.initial };
  }

  function renderJournal() {
    if (!journal) return;
    if (!journal.length) {
      callsList.innerHTML = '<p class="tk-note tk-chat__empty-list">' + escapeHtml(t('calls.empty')) + '</p>';
      return;
    }
    callsList.innerHTML = journal.map(function (c, i) {
      var info = callInfo(c);
      var p = journalPeer(c);
      var arrow = info.out ? '<path d="M7 17L17 7M9 7h8v8"></path>' : '<path d="M17 7L7 17M15 17H7V9"></path>';
      var button = function (type, icon, key) {
        return '<button type="button" class="tk-callrow__btn" data-call="' + type + '" data-row="' + i + '" aria-label="' + escapeHtml(t(key)) + '" title="' + escapeHtml(t(key)) + '">' +
          '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true">' + icon + '</svg></button>';
      };
      return '<div class="tk-callrow' + (info.missed ? ' is-missed' : '') + '">' +
        '<button type="button" class="tk-callrow__main" data-open="' + i + '">' +
          avatar('tk-callrow__ava', p) +
          '<span class="tk-callrow__body">' +
            '<span class="tk-callrow__name">' + escapeHtml(p.name) + '</span>' +
            '<span class="tk-callrow__meta"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true">' + arrow + '</svg>' + escapeHtml(info.text) + '</span>' +
            '<time class="tk-callrow__when">' + escapeHtml(tkDate(c.startedAt, CALL_TIME)) + '</time>' +
          '</span>' +
        '</button>' +
        button('audio', PHONE, 'calls.audio') + button('video', CAMERA, 'calls.video') +
        '<button type="button" class="tk-callrow__btn tk-callrow__del" data-del="' + i + '" aria-label="' + escapeHtml(t('calls.delete')) + '" title="' + escapeHtml(t('calls.delete')) + '">' +
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button>' +
      '</div>';
    }).join('');
  }

  callsList.addEventListener('click', function (e) {
    var call = e.target.closest('[data-call]');
    var open = e.target.closest('[data-open]');
    var del = e.target.closest('[data-del]');
    if (del) {
      var gone = journal[Number(del.getAttribute('data-del'))];
      confirmDialog(t('calls.deleteQ'), { okText: t('chats.delete') }).then(function (yes) {
        if (!yes) return;
        return post('/api/calls/delete', { ids: [gone.id] }).then(afterCallsDeleted.bind(null, [gone.id]));
      }).catch(function (err) { toast(t('calls.deleteFailed') + ': ' + err.message, 'error'); });
    } else if (call && window.showOutgoingCall) {
      var c = journal[Number(call.getAttribute('data-row'))];
      var type = call.getAttribute('data-call');
      window.showOutgoingCall({
        userId: c.peer.id,
        displayName: c.peer.displayName,
        avatarUrl: (c.peer.avatarStyle || {}).url || '',
        callType: type
      });
      if (type === 'audio') window.startAudioCall(c.peer.id);
      else window.startVideoCall(c.peer.id);
    } else if (open) {
      openPeer(journal[Number(open.getAttribute('data-open'))].peer);
    }
  });

  // Строка звонка открывает переписку с этим человеком. Её ещё нет —
  // заводим, как кнопка «Сообщение» на его странице; не вышло (например,
  // аккаунт ограничен) — ведём на страницу человека.
  function openPeer(p) {
    var el = dialogEl(p.id);
    if (el) return select(el);
    post('/start-conversation', { recipientId: p.id })
      .then(function () { select(dialogEl(p.id) || addDialog(p)); })
      .catch(function () { location.href = '/userPage/' + encodeURIComponent(p.id); });
  }

  // ── Действия с сообщением и звонком ───────────────────────────────────
  // Меню — правым кликом, на телефоне — удержанием, с клавиатуры — Enter.
  // Обычный клик по сообщению меню не открывает: им выделяют текст мышью.
  // Раньше меню было на левом клике, а удержание на телефоне не ловилось
  // вовсе — удалить сообщение с телефона было нельзя.
  //
  // «Выделить» в меню включает режим выбора: клик отмечает или снимает
  // отметку, Shift+клик — всё подряд от предыдущей отметки. Вместо шапки
  // диалога — полоса «Выбрано: N» с теми же действиями на всю пачку.
  var menu = $('msgMenu');
  var menuKey = null;       // над чем открыто меню
  var picked = {};          // 'm:<id>' — сообщение, 'c:<id>' — звонок
  var picking = false;
  var anchor = null;        // от какой отметки считать Shift+клик
  var pressTimer = null;
  // Сработало удержание: клик и contextmenu, которыми кончается этот же жест,
  // не должны ничего делать. Сбрасывается следующим касанием — не по времени:
  // иначе быстрое касание сразу после удержания терялось бы.
  var longPressed = false;

  function isPicked(key) { return !!picked[key]; }
  function pickedKeys() { return Object.keys(picked); }

  function itemEl(key) { return feed.querySelector('[data-key="' + CSS.escape(key) + '"]'); }
  function itemOf(el) { return el && el.closest('[data-key]'); }

  // Что стоит за ключом — сообщение или звонок из загруженной ленты.
  function resolve(key) {
    var id = key.slice(2);
    return key[0] === 'm'
      ? { kind: 'message', m: messages.find(function (x) { return x._id === id; }) }
      : { kind: 'call', c: calls.find(function (x) { return x.id === id; }) };
  }

  function mark(key, on) {
    if (on) picked[key] = true; else delete picked[key];
    var el = itemEl(key);
    if (el) el.classList.toggle('is-picked', !!on);
  }

  function openMenu(el) {
    var key = el.getAttribute('data-key');
    var what = resolve(key);
    if (!what.m && !what.c) return;
    closeMenu();
    menuKey = key;
    el.classList.add('is-picked');   // правый клик выделяет то, над чем меню
    menu.querySelectorAll('[data-for="message"]').forEach(function (b) { b.hidden = what.kind !== 'message'; });
    menu.hidden = false;
    var target = el.querySelector('.tk-msg__bubble') || el;
    var r = target.getBoundingClientRect();
    var w = menu.offsetWidth;
    var h = menu.offsetHeight;
    var left = el.classList.contains('tk-msg--out') ? r.right - w : el.classList.contains('tk-callnote') ? r.left + (r.width - w) / 2 : r.left;
    var top = r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6;
    menu.style.left = Math.max(8, Math.min(left, innerWidth - w - 8)) + 'px';
    menu.style.top = Math.max(8, top) + 'px';
    menu.querySelector('button:not([hidden])').focus();
  }

  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    // Подсветка, поставленная меню, уходит вместе с ним — если это не отметка.
    if (menuKey && !picked[menuKey]) { var el = itemEl(menuKey); if (el) el.classList.remove('is-picked'); }
    menuKey = null;
  }

  // ── Режим выбора ──
  function startPicking(key) {
    picking = true;
    // В режиме выбора клик — это отметка, не выделение текста: старое
    // выделение снимаем, чтобы оно не путалось с отметками.
    window.getSelection().removeAllRanges();
    $('chat').classList.add('is-picking');
    $('pickBar').hidden = false;
    document.querySelector('.tk-chat__head').hidden = true;
    mark(key, true);
    anchor = key;
    updatePickBar();
  }

  function stopPicking() {
    if (!picking) return;
    picking = false;
    pickedKeys().forEach(function (k) { mark(k, false); });
    anchor = null;
    $('chat').classList.remove('is-picking');
    $('pickBar').hidden = true;
    document.querySelector('.tk-chat__head').hidden = false;
  }

  // Копировать и переслать можно только сообщения: у звонка нет текста.
  function updatePickBar() {
    var keys = pickedKeys();
    if (!keys.length) return stopPicking();
    $('pickCount').textContent = t('chats.picked', { n: keys.length });
    var hasText = keys.some(function (k) { return k[0] === 'm'; });
    document.querySelectorAll('#pickBar [data-pick="forward"], #pickBar [data-pick="copy"]').forEach(function (b) { b.disabled = !hasText; });
  }

  function toggle(key, range) {
    if (range && anchor && itemEl(anchor)) {
      // Всё между предыдущей отметкой и этой — в порядке ленты.
      var all = Array.prototype.map.call(feed.querySelectorAll('[data-key]'), function (el) { return el.getAttribute('data-key'); });
      var a = all.indexOf(anchor), b = all.indexOf(key);
      all.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(function (k) { mark(k, true); });
    } else {
      mark(key, !picked[key]);
    }
    anchor = key;
    updatePickBar();
  }

  $('pickCancel').addEventListener('click', stopPicking);
  $('pickBar').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-pick]');
    if (!btn || btn.disabled) return;
    var keys = pickedKeys();
    var act = btn.getAttribute('data-pick');
    if (act === 'copy') copy(keys);
    else if (act === 'forward') openForward(keys);
    else if (act === 'delete') removeItems(keys);
  });

  // ── Мышь, палец, клавиатура ──
  feed.addEventListener('contextmenu', function (e) {
    var el = itemOf(e.target);
    if (!el) return;
    e.preventDefault();
    // Android после удержания шлёт ещё и contextmenu — меню уже открыто им.
    if (longPressed) return;
    if (picking) toggle(el.getAttribute('data-key'), e.shiftKey);
    else openMenu(el);
  });

  feed.addEventListener('click', function (e) {
    if (e.target.closest('[data-peer]') && !picking) return goToPeer();
    var el = itemOf(e.target);
    if (!el || !picking) return;
    if (longPressed) return;   // клик, которым кончилось удержание
    e.preventDefault();
    toggle(el.getAttribute('data-key'), e.shiftKey);
  });

  // Shift+клик браузер понимает ещё и как «растянуть выделение текста».
  // В режиме выбора текст не выделяем вовсе: иначе следующий клик попадал
  // внутрь выделенного, браузер его не сбрасывал, и отметка не снималась.
  feed.addEventListener('mousedown', function (e) {
    if (picking && itemOf(e.target)) e.preventDefault();
  });

  // Новое касание где угодно — новый жест: флаг удержания снимаем. Не только
  // в ленте — иначе касание шапки, чтобы закрыть меню, его бы не закрыло.
  document.addEventListener('touchstart', function () { longPressed = false; }, { capture: true, passive: true });

  // Удержание пальцем: iOS не шлёт contextmenu, поэтому считаем время сами.
  // Сдвинул палец — это прокрутка, не удержание.
  var pressFrom = null;
  feed.addEventListener('touchstart', function (e) {
    var el = itemOf(e.target);
    if (!el || e.touches.length > 1) return;
    pressFrom = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(function () {
      longPressed = true;
      if (navigator.vibrate) navigator.vibrate(12);
      if (picking) toggle(el.getAttribute('data-key'), false);
      else openMenu(el);
    }, 450);
  }, { passive: true });
  feed.addEventListener('touchmove', function (e) {
    if (!pressFrom) return;
    var dx = e.touches[0].clientX - pressFrom.x, dy = e.touches[0].clientY - pressFrom.y;
    if (dx * dx + dy * dy > 100) { clearTimeout(pressTimer); pressFrom = null; }
  }, { passive: true });
  ['touchend', 'touchcancel'].forEach(function (name) {
    feed.addEventListener(name, function () { clearTimeout(pressTimer); pressFrom = null; });
  });

  feed.addEventListener('keydown', function (e) {
    var el = itemOf(e.target);
    if (!el || e.target !== (el.querySelector('.tk-msg__bubble') || el)) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (picking) toggle(el.getAttribute('data-key'), e.shiftKey);
      else openMenu(el);
    }
  });

  document.addEventListener('click', function (e) {
    // Клик, которым кончилось удержание (так делают некоторые Android),
    // не «мимо меню»: оно только что открылось этим же жестом.
    if (longPressed) return;
    if (!menu.hidden && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!menu.hidden) closeMenu();
    else if (picking && fwd.classList.contains('hidden')) stopPicking();
  });
  feed.addEventListener('scroll', closeMenu);

  menu.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn || !menuKey) return;
    var key = menuKey;
    var act = btn.getAttribute('data-act');
    closeMenu();
    if (act === 'select') startPicking(key);
    else if (act === 'copy') copy([key]);
    else if (act === 'forward') openForward([key]);
    else if (act === 'delete') removeItems([key]);
  });

  // Сообщения выбранного — в порядке ленты, без звонков.
  function pickedMessages(keys) {
    return keys.filter(function (k) { return k[0] === 'm'; })
      .map(function (k) { return resolve(k).m; })
      .filter(Boolean)
      .sort(function (a, b) { return new Date(a.sentAt) - new Date(b.sentAt); });
  }

  function copy(keys) {
    var text = pickedMessages(keys).map(function (m) { return m.content; }).join('\n\n');
    if (!text) return;
    navigator.clipboard.writeText(text)
      .then(function () { toast(t('chats.copied'), 'ok'); stopPicking(); })
      .catch(function () {});
  }

  // Удаление выбранного одним окном. Своё сообщение можно убрать у всех,
  // чужое и звонок — только у себя (сервер следит за этим сам). Если в
  // выбранном есть и то и другое, в вопросе сказано, что уйдёт только у вас.
  function removeItems(keys) {
    var msgs = pickedMessages(keys);
    var callIds = keys.filter(function (k) { return k[0] === 'c'; }).map(function (k) { return k.slice(2); });
    var mine = msgs.filter(function (m) { return m.sender === ME; }).length;
    var n = msgs.length + callIds.length;
    if (!n) return;

    var q = n > 1 ? t('chats.deleteManyQ', { n: n }) : msgs.length ? t('chats.deleteMsgQ') : t('chats.deleteCallQ');
    if (mine && mine < n) q += ' ' + t('chats.deleteMixedNote');
    var choices = mine
      ? [{ value: 'me', text: t('chats.deleteForMe'), danger: false }, { value: 'all', text: t('chats.deleteForAll') }]
      : [{ value: 'me', text: t('chats.delete') }];

    chooseDialog(q, choices).then(function (v) {
      if (!v) return;
      var jobs = [];
      if (msgs.length) jobs.push(post('/messages/delete', { ids: msgs.map(function (m) { return m._id; }), forAll: v === 'all' }));
      if (callIds.length) jobs.push(post('/api/calls/delete', { ids: callIds }).then(afterCallsDeleted.bind(null, callIds)));
      return Promise.all(jobs).then(function () {
        // Сокет пришлёт то же самое, но лента не должна ждать его.
        dropMessages(msgs.map(function (m) { return m._id; }));
        stopPicking();
      });
    }).catch(function (e) { toast(t('chats.deleteFailed') + ': ' + e.message, 'error'); });
  }

  function dropMessages(ids) {
    if (!ids.length) return;
    var before = messages.length;
    messages = messages.filter(function (m) { return ids.indexOf(m._id) === -1; });
    ids.forEach(function (id) { delete picked['m:' + id]; });
    if (messages.length === before) return;
    var top = feed.scrollTop;
    render();
    feed.scrollTop = top;
    var last = messages[messages.length - 1];
    var el = peer && dialogEl(peer.id);
    if (el && last) el.querySelector('.tk-dialog__last').innerHTML =
      (last.sender === ME ? '<span data-i18n="chats.you">' + escapeHtml(t('chats.you')) + '</span> ' : '') + escapeHtml(last.content);
  }

  // Звонки ушли — из ленты открытого диалога и из вкладки «Звонки».
  // Ответ сервера несёт, сколько пропущенных осталось, — это счётчик у иконки.
  function dropCalls(ids) {
    var feedBefore = calls.length;
    calls = calls.filter(function (c) { return ids.indexOf(c.id) === -1; });
    ids.forEach(function (id) { delete picked['c:' + id]; });
    if (calls.length !== feedBefore) { var top = feed.scrollTop; render(); feed.scrollTop = top; }
    if (journal) {
      var jBefore = journal.length;
      journal = journal.filter(function (c) { return ids.indexOf(c.id) === -1; });
      if (journal.length !== jBefore) renderJournal();
    }
  }

  function afterCallsDeleted(ids, r) {
    dropCalls(ids);
    document.querySelectorAll('[data-missed-calls]').forEach(function (b) {
      b.textContent = String(r.missed || 0);
      b.classList.toggle('hidden', !r.missed);
    });
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
  var fwdMessages = [];     // что пересылаем, в порядке ленты
  var fwdComment = $('forwardComment');
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

  function openForward(keys) {
    fwdMessages = pickedMessages(keys);
    if (!fwdMessages.length) return;
    fwdPicked = {};
    fwdSearch.value = '';
    fwdComment.value = '';
    // Одно — его текст; несколько — сколько и начало первого.
    $('forwardQuote').textContent = fwdMessages.length === 1
      ? fwdMessages[0].content
      : t('chats.forwardMany', { n: fwdMessages.length }) + ' · ' + fwdMessages[0].content;
    fwdRender(known());
    fwdCount();
    fwd.classList.remove('hidden');
    fwdSearch.focus();
  }

  function closeForward() {
    fwd.classList.add('hidden');
    fwdMessages = [];
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
      // Тот же поиск, что в шапке (utils/search.js); пересылке нужны только люди.
      fetch('/api/search?type=people&limit=7&q=' + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (found) {
          var users = found.people || [];
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
    if (!fwdMessages.length) return;
    fwdSend.disabled = true;
    post('/messages/forward', {
      messageIds: fwdMessages.map(function (m) { return m._id; }),
      recipientIds: Object.keys(fwdPicked),
      comment: fwdComment.value.trim()
    })
      .then(function () {
        toast(t('chats.forwardDone'), 'ok');
        closeForward();
        stopPicking();
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
    renderJournal();
    if (!peer) return;
    var fromBottom = feed.scrollHeight - feed.scrollTop;
    render();
    feed.scrollTop = feed.scrollHeight - fromBottom;
    input.placeholder = t('chats.messageTo') + ' ' + peer.name + '…';
  });

  refreshTimes();
  // Подписи «N минут назад» стареют, пока страница открыта.
  setInterval(refreshTimes, 60000);

  // Переход с профиля («Сообщение») или из уведомления: открыть нужный диалог
  // или вкладку звонков.
  var params = new URLSearchParams(location.search);
  var target = params.get('peer') && dialogEl(params.get('peer'));
  if (target) select(target);
  else if (params.get('tab') === 'calls') loadJournal();
})();
