// Действия под постами «Ленты» (05.10.2026, views/partials/postCard.ejs):
// «нравится» и комментарий прямо в ленте, без перехода на страницу
// публикации; с 09.10 — и длинный текст разворачивается на месте
// (крошки страницы поста — в tk-watch.js, общие со страницами фото и видео). Те же маршруты, что у страницы (routes/watch.js): адрес поста —
// data-post (/photo/<id>, /video/<id>, с 09.10 и /post/<id>). Обработчики — на документе: посты
// следующих страниц приходят без перезагрузки (catalog.js).
// С 06.10 — ответ на комментарий (ник в поле) и удаление своего, чужого
// под своим постом и любого модератором — как на странице публикации.
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

  function count(post, d) {
    var n = post.querySelector('[data-comments]');
    n.textContent = num(Math.max(0, (Number(n.textContent.replace(/\D/g, '')) || 0) + d));
  }

  function num(n) { return Number(n).toLocaleString(document.documentElement.lang || 'ru'); }
})();
