// «Поделиться» (05.10.2026, решение Ивана): публикация уходит сообщением —
// карточкой с картинкой, как пересылка поста в мессенджере, — своим
// недавним собеседникам, группам, контактам или найденному поиском человеку.
// Ссылка в буфер — запасной путь: гостю, которому писать некому, и кнопкой
// в самом окне. Сервер — /api/share и /api/share/targets
// (routes/streaming/messages.js), снимок публикации — utils/share.js.
//
// Кнопка — любой элемент с data-share (вид: photo, video, recording)
// и data-share-id; для карточки в окне — data-share-url, -title, -image,
// -author. Стили окна и списка — общие с пересылкой (app.css, .tk-fwd__*).

(function () {
  'use strict';

  var ME = (window.TK && window.TK.userId) || '';
  var KIND = { photo: 'chats.att.image', video: 'chats.att.video', recording: 'feed.recording' };

  var modal = null;
  var item = null;          // что отправляем: { kind, id, url, title, image, author }
  var targets = null;       // недавние и контакты — с сервера, раз на страницу
  var picked = {};          // id → true; у группы приставка «g:»
  var timer = null;

  function $(sel) { return modal.querySelector(sel); }

  function linkOf(it) { return location.origin + it.url; }

  // Гостю и как запасной путь: системное «поделиться» на телефоне, иначе
  // ссылка в буфер.
  function copyLink(it) {
    var url = linkOf(it);
    if (!ME && navigator.share && matchMedia('(pointer: coarse)').matches) {
      navigator.share({ title: document.title, url: url }).catch(function () {});
      return;
    }
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
      .then(function () { toast(t('rec.linkCopied'), 'ok'); }, function () { prompt('', url); });
  }

  function avatar(p) {
    var a = p.avatarStyle || {};
    return a.url
      ? '<span class="tk-fwd__ava"><img src="' + escapeHtml(a.url) + '" alt=""></span>'
      : '<span class="tk-fwd__ava" style="background: ' + escapeHtml(a.gradient || '') + '">' + escapeHtml(a.initial || '?') + '</span>';
  }

  function row(p) {
    var id = p.group ? 'g:' + p.id : p.id;
    return '<label class="tk-fwd__row">' +
      '<input type="checkbox" value="' + escapeHtml(id) + '"' + (picked[id] ? ' checked' : '') + '>' +
      avatar(p) + '<span class="tk-fwd__name">' + escapeHtml(p.group ? p.title : p.displayName) + '</span></label>';
  }

  function render(list) {
    $('[data-list]').innerHTML = list.length ? list.map(row).join('')
      : '<p class="tk-note tk-note--center">' + escapeHtml(t(targets ? 'share.empty' : 'share.loading')) + '</p>';
  }

  function count() {
    var n = Object.keys(picked).length;
    $('[data-send]').disabled = !n;
    $('[data-count]').textContent = n ? ' (' + n + ')' : '';
  }

  function nameOf(p) { return (p.group ? p.title : p.displayName || '').toLowerCase(); }

  function build() {
    modal = document.createElement('div');
    modal.className = 'tk-modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);

    modal.addEventListener('click', function (e) {
      if (e.target === modal || e.target.closest('[data-close]')) close();
      else if (e.target.closest('[data-copy]')) copyLink(item);
      else if (e.target.closest('[data-send]')) send();
    });
    modal.addEventListener('change', function (e) {
      var box = e.target;
      if (box.type !== 'checkbox') return;
      if (box.checked) picked[box.value] = true;
      else delete picked[box.value];
      count();
    });
    modal.addEventListener('input', function (e) {
      if (e.target.matches('[data-search]')) search(e.target.value.trim());
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
    });
  }

  function open(it) {
    if (!modal) build();
    item = it;
    picked = {};
    var kind = t(KIND[it.kind] || 'chats.att.share');
    modal.setAttribute('aria-label', t('share.title'));
    modal.innerHTML =
      '<div class="tk-modal__card">' +
        '<div class="tk-modal__head">' +
          '<h3 class="tk-modal__title">' + escapeHtml(t('share.title')) + '</h3>' +
          '<button type="button" class="tk-modal__close" data-close aria-label="' + escapeHtml(t('common.close')) + '">' +
            '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"></path></svg></button>' +
        '</div>' +
        '<div class="tk-modal__body">' +
          '<div class="tk-sharebox__item">' +
            (it.image ? '<img class="tk-sharebox__pic" src="' + escapeHtml(it.image) + '" alt="">' : '') +
            '<span class="tk-sharebox__text"><span class="tk-sharebox__kind">' + escapeHtml(kind) + '</span>' +
              (it.title ? '<span class="tk-sharebox__title">' + escapeHtml(it.title) + '</span>' : '') +
              (it.author ? '<span class="tk-sharebox__author">' + escapeHtml(it.author) + '</span>' : '') + '</span>' +
          '</div>' +
          '<textarea class="tk-field tk-fwd__comment" data-comment rows="2" maxlength="5000" placeholder="' + escapeHtml(t('chats.forwardComment')) + '"></textarea>' +
          '<input type="search" class="tk-field" data-search placeholder="' + escapeHtml(t('share.search')) + '" autocomplete="off" enterkeyhint="search">' +
          '<div class="tk-fwd__list" data-list></div>' +
        '</div>' +
        '<div class="tk-modal__foot tk-sharebox__foot">' +
          '<button type="button" class="tk-btn tk-btn--outline tk-btn--sm" data-copy>' + escapeHtml(t('share.copy')) + '</button>' +
          '<button type="button" class="tk-btn tk-btn--primary tk-btn--sm" data-send disabled>' +
            escapeHtml(t('share.send')) + '<span data-count></span></button>' +
        '</div>' +
      '</div>';
    render(targets || []);
    count();
    modal.classList.remove('hidden');
    if (matchMedia('(pointer: fine)').matches) $('[data-search]').focus();
    if (!targets) {
      TKNet.json('/api/share/targets')
        .then(function (r) {
          targets = r.targets || [];
          if (!modal.classList.contains('hidden') && !$('[data-search]').value.trim()) render(targets);
        })
        .catch(function (e) { targets = []; render([]); toast(e.message, 'error'); });
    }
  }

  function close() {
    modal.classList.add('hidden');
    clearTimeout(timer);
    item = null;
  }

  // Сначала свои — недавние и контакты по имени; от двух букв поиск
  // добавляет остальных людей (тот же, что в шапке, utils/search.js).
  function search(q) {
    clearTimeout(timer);
    var lq = q.toLowerCase();
    var mine = (targets || []).filter(function (p) { return nameOf(p).indexOf(lq) !== -1; });
    render(mine);
    if (q.length < 2) return;
    timer = setTimeout(function () {
      tkFetch('/api/search?type=people&limit=7&q=' + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (found) {
          if (!item || $('[data-search]').value.trim() !== q) return;
          var seen = {};
          mine.forEach(function (p) { if (!p.group) seen[p.id] = true; });
          var more = (found.people || []).filter(function (u) { return String(u._id) !== ME && !seen[u._id]; })
            .map(function (u) { return { id: String(u._id), displayName: u.displayName, avatarStyle: u.avatarStyle }; });
          render(mine.concat(more));
        })
        .catch(function () {});
    }, 300);
  }

  function send() {
    var keys = Object.keys(picked);
    if (!item || !keys.length) return;
    var btn = $('[data-send]');
    btn.disabled = true;
    TKNet.json('/api/share', { method: 'POST', body: {
      kind: item.kind,
      id: item.id,
      recipientIds: keys.filter(function (k) { return k.indexOf('g:') !== 0; }),
      groupIds: keys.filter(function (k) { return k.indexOf('g:') === 0; }).map(function (k) { return k.slice(2); }),
      comment: $('[data-comment]').value.trim()
    } })
      .then(function (r) {
        toast(r && r.skipped ? t('share.partial', { n: r.skipped }) : t('share.sent'), r && r.skipped ? 'error' : 'ok');
        close();
      })
      .catch(function (e) {
        toast(t('share.failed') + ': ' + e.message, 'error');
        count();
      });
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-share]');
    if (!b) return;
    e.preventDefault();
    var it = {
      kind: b.dataset.share,
      id: b.dataset.shareId,
      url: b.dataset.shareUrl || '/' + b.dataset.share + '/' + b.dataset.shareId,
      title: b.dataset.shareTitle || '',
      image: b.dataset.shareImage || '',
      author: b.dataset.shareAuthor || '',
    };
    if (ME) open(it);
    else copyLink(it);
  });
})();
