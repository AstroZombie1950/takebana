/* Экран группы на странице переписки: создание, настройки, добавление
 * участников, вступление по ссылке. Открывается на месте диалога, на
 * телефоне — во весь экран (.tk-gpane, chats.css). Сервер — routes/groups.js.
 *
 * С лентой говорит через window.TKChats (chats.js): открыть группу,
 * обновить её шапку и строку. Кнопки на экране — по правам роли, те же
 * проверки делает сервер.
 */
(function () {
  var t = window.t || function () { return ''; };
  var ME = (window.TK && window.TK.userId) || '';
  var $ = function (id) { return document.getElementById(id); };
  var pane = $('groupPane');
  var chat = $('chat');
  if (!pane) return;

  var MAX = 100;
  var state = null;         // что открыто: { mode, group, picked, found, … }
  var searchTimer = null;

  function post(url, body) {
    var form = body instanceof FormData;
    return fetch(url, {
      method: 'POST',
      headers: form ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: form ? body : JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.message || 'HTTP ' + r.status);
        return d;
      });
    });
  }

  function getJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.message || 'HTTP ' + r.status);
        return d;
      });
    });
  }

  function fail(e) { toast(e.message || t('common.noNetwork'), 'error'); }

  // Человек или группа с сервера ({ displayName|title, avatarStyle }) — в вид
  // для аватара из chats.js.
  function face(x) {
    var a = x.avatarStyle || {};
    return { url: a.url || '', bg: a.gradient || '', initial: a.initial || '?' };
  }
  function ava(cls, x) { return window.TKChats.avatar(cls, face(x)); }

  // ── Каркас ─────────────────────────────────────────────────────────────
  function show(title, body, foot) {
    pane.innerHTML =
      '<header class="tk-gpane__head">' +
        '<button type="button" class="tk-chat__tool" data-gp="close" aria-label="' + escapeHtml(t('groups.back')) + '" title="' + escapeHtml(t('groups.back')) + '">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg></button>' +
        '<h2 class="tk-gpane__title">' + escapeHtml(title) + '</h2>' +
      '</header>' +
      '<div class="tk-gpane__body">' + body + '</div>' +
      (foot ? '<footer class="tk-gpane__foot">' + foot + '</footer>' : '');
    pane.hidden = false;
    chat.classList.add('has-peer', 'is-open', 'is-pane');
  }

  // Закрыть: под экраном остаётся открытая группа, а если ничего открыто
  // не было (создание, вступление) — снова список.
  function close() {
    state = null;
    pane.hidden = true;
    pane.innerHTML = '';
    chat.classList.remove('is-pane');
    if (!window.TKChats.current() && !chat.querySelector('.tk-dialog--on')) chat.classList.remove('has-peer', 'is-open');
  }

  // ── Выбор людей: создание и «Добавить участников» ─────────────────────
  // Кандидаты — контакты и собеседники из списка слева, поиском — все.
  function candidates() {
    var seen = {};
    var out = [];
    var add = function (id, name, a, found) {
      if (!id || id === ME || seen[id] || (state.exclude && state.exclude[id])) return;
      seen[id] = true;
      out.push({ id: id, displayName: name, avatarStyle: a, found: !!found });
    };
    (state.contacts || []).forEach(function (c) { add(String(c.id), c.displayName, c.avatarStyle); });
    document.querySelectorAll('#conversationsList .tk-dialog[data-id]').forEach(function (el) {
      add(el.getAttribute('data-id'), el.getAttribute('data-name'),
        { url: el.getAttribute('data-ava-url'), gradient: el.getAttribute('data-ava-bg'), initial: el.getAttribute('data-ava-initial') });
    });
    (state.found || []).forEach(function (u) { add(String(u._id || u.id), u.displayName, u.avatarStyle, true); });
    return out;
  }

  function pickerHtml() {
    var q = (state.query || '').toLowerCase();
    // Свои — по совпадению в имени, найденные поиском — все: сервер уже отобрал.
    var rows = candidates().filter(function (p) { return !q || p.found || p.displayName.toLowerCase().indexOf(q) !== -1; });
    var chips = Object.keys(state.picked).map(function (id) {
      var p = state.picked[id];
      return '<button type="button" class="tk-gchip" data-unpick="' + escapeHtml(id) + '">' + ava('tk-gchip__ava', p) +
        '<span>' + escapeHtml(p.displayName) + '</span><span aria-hidden="true">×</span></button>';
    }).join('');
    return '<div class="tk-gpick">' +
      (chips ? '<div class="tk-gpick__chips">' + chips + '</div>' : '') +
      '<input type="search" class="tk-field" data-gp-search placeholder="' + escapeHtml(t('groups.searchPeople')) + '" value="' + escapeHtml(state.query || '') + '" autocomplete="off">' +
      '<div class="tk-gpick__list">' + (rows.length ? rows.map(function (p) {
        return '<label class="tk-fwd__row"><input type="checkbox" data-pick="' + escapeHtml(p.id) + '"' + (state.picked[p.id] ? ' checked' : '') + '>' +
          ava('tk-fwd__ava', p) + '<span class="tk-fwd__name">' + escapeHtml(p.displayName) + '</span></label>';
      }).join('') : '<p class="tk-note tk-note--center">' + escapeHtml(t('contacts.nothing')) + '</p>') + '</div>' +
    '</div>';
  }

  function repaintPicker() {
    var box = pane.querySelector('.tk-gpick');
    if (!box) return;
    var focused = document.activeElement && document.activeElement.hasAttribute('data-gp-search');
    box.outerHTML = pickerHtml();
    var n = Object.keys(state.picked).length;
    var go = pane.querySelector('[data-gp="create"], [data-gp="add-go"]');
    if (go) go.disabled = state.mode === 'add' ? !n : !state.title;
    var count = pane.querySelector('[data-gp-count]');
    if (count) count.textContent = t('groups.pickedN', { n: n });
    if (focused) {
      var f = pane.querySelector('[data-gp-search]');
      f.focus();
      f.setSelectionRange(f.value.length, f.value.length);
    }
  }

  function loadContactsOnce() {
    if (state.contacts) return;
    getJson('/api/contacts').then(function (d) {
      if (!state) return;
      state.contacts = d.contacts || [];
      repaintPicker();
    }).catch(function () {});
  }

  function create() {
    state = { mode: 'create', picked: {}, title: '' };
    show(t('groups.new'),
      '<label class="tk-form__label" for="gpTitle">' + escapeHtml(t('groups.title')) + '</label>' +
      '<input id="gpTitle" class="tk-field" data-gp-title maxlength="64" autocomplete="off" placeholder="' + escapeHtml(t('groups.titlePh')) + '">' +
      '<p class="tk-form__label"><span>' + escapeHtml(t('groups.members')) + '</span> · <span data-gp-count>' + escapeHtml(t('groups.pickedN', { n: 0 })) + '</span></p>' +
      pickerHtml(),
      '<button type="button" class="tk-btn tk-btn--primary tk-btn--block" data-gp="create" disabled>' + escapeHtml(t('groups.create')) + '</button>');
    loadContactsOnce();
    $('gpTitle').focus();
  }

  function addMembers(g) {
    var exclude = {};
    g.members.forEach(function (m) { exclude[m.id] = true; });
    state = { mode: 'add', group: g, picked: {}, exclude: exclude };
    show(t('groups.addMembers'),
      '<p class="tk-form__label"><span data-gp-count>' + escapeHtml(t('groups.pickedN', { n: 0 })) + '</span></p>' + pickerHtml(),
      '<button type="button" class="tk-btn tk-btn--primary tk-btn--block" data-gp="add-go" disabled>' + escapeHtml(t('groups.add')) + '</button>');
    loadContactsOnce();
  }

  // ── Экран группы ──────────────────────────────────────────────────────
  var ROLE = { owner: 'groups.role.owner', admin: 'groups.role.admin' };

  function settings(id) {
    getJson('/api/groups/' + encodeURIComponent(id)).then(function (d) {
      state = { mode: 'settings', group: d.group };
      paintSettings();
    }).catch(fail);
  }

  function paintSettings() {
    var g = state.group;
    var manage = g.myRole === 'owner' || g.myRole === 'admin';
    var link = g.invite ? location.origin + '/g/' + g.invite : '';
    var members = g.members.map(function (m) {
      var acts = actionsFor(m).length;
      return '<div class="tk-gmember">' + ava('tk-gmember__ava', m) +
        '<a class="tk-gmember__name" href="/userPage/' + encodeURIComponent(m.id) + '">' + escapeHtml(m.displayName) + '</a>' +
        (ROLE[m.role] ? '<span class="tk-gmember__role">' + escapeHtml(t(ROLE[m.role])) + '</span>' : '') +
        (acts ? '<button type="button" class="tk-chat__tool" data-gp-member="' + escapeHtml(m.id) + '" aria-label="' + escapeHtml(t('groups.memberActs')) + '" title="' + escapeHtml(t('groups.memberActs')) + '">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg></button>' : '') +
        '</div>';
    }).join('');

    show(t('groups.info'),
      '<div class="tk-ginfo">' +
        ava('tk-ginfo__ava', g) +
        (manage
          ? '<div class="tk-ginfo__photo"><input type="file" accept="image/png,image/jpeg,image/webp" hidden data-gp-file>' +
            '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-gp="photo">' + escapeHtml(t(g.avatarStyle.url ? 'groups.photoReplace' : 'groups.photoUpload')) + '</button>' +
            (g.avatarStyle.url ? '<button type="button" class="tk-btn tk-btn--ghost tk-btn--xs" data-gp="photo-off">' + escapeHtml(t('groups.photoDelete')) + '</button>' : '') + '</div>'
          : '') +
      '</div>' +
      (manage
        ? '<form class="tk-ginfo__title" data-gp-form="title"><input class="tk-field" name="title" maxlength="64" value="' + escapeHtml(g.title) + '" aria-label="' + escapeHtml(t('groups.title')) + '">' +
          '<button type="submit" class="tk-btn tk-btn--outline tk-btn--sm">' + escapeHtml(t('common.save')) + '</button></form>'
        : '<p class="tk-ginfo__name">' + escapeHtml(g.title) + '</p>') +
      '<p class="tk-note">' + escapeHtml(t('groups.count', { n: g.count })) + '</p>' +

      '<label class="tk-gswitch"><input type="checkbox" data-gp="mute"' + (g.muted ? ' checked' : '') + '><span>' + escapeHtml(t('groups.mute')) + '</span></label>' +

      (manage
        ? '<section class="tk-gsec"><h3 class="tk-kicker">' + escapeHtml(t('groups.invite')) + '</h3>' +
          (link
            ? '<p class="tk-ginvite"><code>' + escapeHtml(link) + '</code></p><div class="tk-panel__actions">' +
              '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-gp="invite-copy">' + escapeHtml(t('groups.inviteCopy')) + '</button>' +
              '<button type="button" class="tk-btn tk-btn--ghost tk-btn--xs" data-gp="invite-new">' + escapeHtml(t('groups.inviteNew')) + '</button>' +
              '<button type="button" class="tk-btn tk-btn--ghost tk-btn--xs" data-gp="invite-off">' + escapeHtml(t('groups.inviteOff')) + '</button></div>'
            : '<p class="tk-note">' + escapeHtml(t('groups.inviteHint')) + '</p><button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-gp="invite-new">' + escapeHtml(t('groups.inviteOn')) + '</button>') +
          '</section>'
        : '') +

      '<section class="tk-gsec"><h3 class="tk-kicker">' + escapeHtml(t('groups.members')) + '</h3>' +
        (manage && g.count < MAX ? '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs" data-gp="add">' + escapeHtml(t('groups.addMembers')) + '</button>' : '') +
        '<div class="tk-gmembers">' + members + '</div></section>' +

      '<section class="tk-gsec tk-gsec--danger">' +
        '<button type="button" class="tk-btn tk-btn--ghost tk-btn--sm" data-gp="leave">' + escapeHtml(t('groups.leave')) + '</button>' +
        (g.myRole === 'owner' ? '<button type="button" class="tk-btn tk-btn--ghost tk-btn--sm tk-gdanger" data-gp="delete">' + escapeHtml(t('groups.delete')) + '</button>' : '') +
      '</section>');
  }

  // Что можно сделать с участником — те же правила, что на сервере.
  function actionsFor(m) {
    var me = state.group.myRole;
    if (m.id === ME || m.role === 'owner') return [];
    if (me === 'owner') {
      return [m.role === 'admin' ? { value: 'member', text: t('groups.unadmin') } : { value: 'admin', text: t('groups.makeAdmin') },
        { value: 'owner', text: t('groups.makeOwner') }, { value: 'remove', text: t('groups.remove') }];
    }
    if (me === 'admin' && m.role === 'member') return [{ value: 'remove', text: t('groups.remove') }];
    return [];
  }

  function refresh(d) {
    if (!state || state.mode !== 'settings') return;
    state.group = d.group;
    window.TKChats.setGroup(d.group);
    paintSettings();
  }

  function memberAction(id) {
    var g = state.group;
    var m = g.members.find(function (x) { return x.id === id; });
    if (!m) return;
    chooseDialog(m.displayName, actionsFor(m)).then(function (v) {
      if (!v) return;
      var base = '/api/groups/' + encodeURIComponent(g.id) + '/members/';
      if (v === 'remove') {
        return confirmDialog(t('groups.removeQ', { name: m.displayName }), { okText: t('groups.remove') }).then(function (yes) {
          if (yes) return post(base + 'remove', { userId: id }).then(refresh);
        });
      }
      if (v === 'owner') {
        return confirmDialog(t('groups.makeOwnerQ', { name: m.displayName }), { okText: t('groups.makeOwner') }).then(function (yes) {
          if (yes) return post(base + 'role', { userId: id, role: 'owner' }).then(refresh);
        });
      }
      return post(base + 'role', { userId: id, role: v }).then(refresh);
    }).catch(fail);
  }

  // ── Вступление по ссылке (/g/<код> → /chatsPage?join=<код>) ───────────
  function join(code) {
    getJson('/api/groups/invite/' + encodeURIComponent(code)).then(function (d) {
      if (d.member) return window.TKChats.openGroup(d.group);
      state = { mode: 'join', code: code };
      show(t('groups.joinTitle'),
        '<div class="tk-ginfo tk-ginfo--center">' + ava('tk-ginfo__ava', d.group) +
        '<p class="tk-ginfo__name">' + escapeHtml(d.group.title) + '</p>' +
        '<p class="tk-note">' + escapeHtml(t('groups.count', { n: d.group.count })) + '</p></div>',
        '<button type="button" class="tk-btn tk-btn--primary tk-btn--block" data-gp="join">' + escapeHtml(t('groups.join')) + '</button>');
    }).catch(function (e) { toast(e.message, 'error'); });
  }

  // ── Действия ──────────────────────────────────────────────────────────
  pane.addEventListener('click', function (e) {
    var unpick = e.target.closest('[data-unpick]');
    if (unpick) {
      delete state.picked[unpick.getAttribute('data-unpick')];
      return repaintPicker();
    }
    var who = e.target.closest('[data-gp-member]');
    if (who) return memberAction(who.getAttribute('data-gp-member'));
    var btn = e.target.closest('button[data-gp]');
    if (!btn || btn.disabled) return;
    var act = btn.getAttribute('data-gp');
    var g = state && state.group;
    var base = g ? '/api/groups/' + encodeURIComponent(g.id) : '';

    if (act === 'close') return state && state.mode === 'add' ? settings(g.id) : close();

    if (act === 'create') {
      btn.disabled = true;
      return post('/api/groups', { title: state.title, memberIds: Object.keys(state.picked) })
        .then(function (d) {
          if (d.skipped) toast(t('groups.skipped', { n: d.skipped }), 'error');
          close();
          window.TKChats.openGroup(d.group);
        })
        .catch(function (err) { btn.disabled = false; fail(err); });
    }
    if (act === 'add-go') {
      btn.disabled = true;
      return post(base + '/members/add', { userIds: Object.keys(state.picked) })
        .then(function (d) {
          if (d.skipped) toast(t('groups.skipped', { n: d.skipped }), 'error');
          state = { mode: 'settings', group: d.group };
          window.TKChats.setGroup(d.group);
          paintSettings();
        })
        .catch(function (err) { btn.disabled = false; fail(err); });
    }
    if (act === 'join') {
      btn.disabled = true;
      return post('/api/groups/join', { code: state.code })
        .then(function (d) { return getJson('/api/groups/' + encodeURIComponent(d.groupId)); })
        .then(function (d) { close(); window.TKChats.openGroup(d.group); })
        .catch(function (err) { btn.disabled = false; fail(err); });
    }
    if (act === 'add') return addMembers(g);
    if (act === 'photo') return pane.querySelector('[data-gp-file]').click();
    if (act === 'photo-off') return post(base + '/photo', new FormData()).then(refresh).catch(fail);
    if (act === 'invite-new') return post(base + '/invite', { on: true }).then(function (d) { g.invite = d.invite; paintSettings(); }).catch(fail);
    if (act === 'invite-off') return post(base + '/invite', { on: false }).then(function () { g.invite = null; paintSettings(); }).catch(fail);
    if (act === 'invite-copy') {
      return navigator.clipboard.writeText(location.origin + '/g/' + g.invite)
        .then(function () { toast(t('groups.inviteCopied'), 'ok'); })
        .catch(function () { toast(location.origin + '/g/' + g.invite); });
    }
    if (act === 'leave') {
      return confirmDialog(t(g.myRole === 'owner' ? 'groups.leaveOwnerQ' : 'groups.leaveQ'), { okText: t('groups.leave') }).then(function (yes) {
        if (!yes) return;
        return post(base + '/leave').then(function () { close(); window.TKChats.close(); });
      }).catch(fail);
    }
    if (act === 'delete') {
      return confirmDialog(t('groups.deleteQ'), { okText: t('groups.delete') }).then(function (yes) {
        if (!yes) return;
        return post(base + '/delete').then(function () { close(); window.TKChats.close(); });
      }).catch(fail);
    }
  });

  pane.addEventListener('change', function (e) {
    var box = e.target;
    if (box.hasAttribute('data-pick')) {
      var id = box.getAttribute('data-pick');
      if (box.checked) {
        var p = candidates().find(function (x) { return x.id === id; });
        if (p) state.picked[id] = p;
      } else {
        delete state.picked[id];
      }
      return repaintPicker();
    }
    if (box.getAttribute('data-gp') === 'mute') {
      // Без звука — на год: «пока не включу обратно».
      return post('/api/groups/' + encodeURIComponent(state.group.id) + '/mute', { hours: box.checked ? 24 * 365 : 0 })
        .then(function (d) { state.group.muted = d.muted; })
        .catch(function (err) { box.checked = !box.checked; fail(err); });
    }
    if (box.hasAttribute('data-gp-file') && box.files[0]) {
      var form = new FormData();
      form.append('photo', box.files[0]);
      post('/api/groups/' + encodeURIComponent(state.group.id) + '/photo', form).then(refresh).catch(fail);
    }
  });

  pane.addEventListener('input', function (e) {
    if (e.target.hasAttribute('data-gp-title')) {
      state.title = e.target.value.trim();
      var go = pane.querySelector('[data-gp="create"]');
      if (go) go.disabled = !state.title;
      return;
    }
    if (!e.target.hasAttribute('data-gp-search')) return;
    state.query = e.target.value.trim();
    state.found = null;
    repaintPicker();
    clearTimeout(searchTimer);
    var q = state.query;
    if (q.length < 2) return;
    // Люди со всего сайта — тем же поиском, что в шапке (routes/search.js).
    searchTimer = setTimeout(function () {
      getJson('/api/search?type=people&limit=10&q=' + encodeURIComponent(q)).then(function (d) {
        if (!state || state.query !== q) return;
        state.found = d.people || [];
        repaintPicker();
      }).catch(function () {});
    }, 250);
  });

  pane.addEventListener('submit', function (e) {
    var form = e.target.closest('[data-gp-form="title"]');
    if (!form) return;
    e.preventDefault();
    var title = form.title.value.trim();
    if (!title) return;
    post('/api/groups/' + encodeURIComponent(state.group.id) + '/title', { title: title })
      .then(function (d) { refresh(d); toast(t('settings.saved'), 'ok'); })
      .catch(fail);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !pane.hidden && !document.querySelector('.tb-dialog')) close();
  });

  // Группа изменилась, пока открыт её экран (другой администратор) — перечитать.
  document.addEventListener('tk:group:updated', function (e) {
    if (state && state.mode === 'settings' && state.group.id === e.detail.group.id) settings(state.group.id);
  });
  document.addEventListener('tk:group:removed', function (e) {
    if (state && state.group && state.group.id === e.detail.groupId) close();
  });
  document.addEventListener('tk:lang', function () {
    if (state && state.mode === 'settings') paintSettings();
  });

  $('newGroupBtn').addEventListener('click', create);

  window.TKGroups = { settings: settings, create: create, join: join };

  var code = new URLSearchParams(location.search).get('join');
  if (code) join(code);
})();
