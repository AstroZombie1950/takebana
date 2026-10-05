// Действия под постами «Ленты» (05.10.2026, views/partials/postCard.ejs):
// «нравится» и комментарий прямо в ленте, без перехода на страницу
// публикации. Те же маршруты, что у страницы (routes/watch.js): адрес поста —
// data-post (/photo/<id>, /video/<id>). Обработчики — на документе: посты
// следующих страниц приходят без перезагрузки (catalog.js).
(function () {
  'use strict';

  function postOf(el) { return el.closest('[data-post]'); }

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
        var li = document.createElement('li');
        var who = document.createElement('a');
        who.className = 'tk-post__said-who';
        who.href = c.author.url;
        who.textContent = c.author.name;
        var said = document.createElement('span');
        said.textContent = c.text;
        li.append(who, ' ', said);
        post.querySelector('[data-said]').appendChild(li);
        var n = post.querySelector('[data-comments]');
        n.textContent = num((Number(n.textContent.replace(/\D/g, '')) || 0) + 1);
        input.value = '';
      })
      .catch(function (err) { toast(err.message, 'error'); })
      .then(function () { delete form.dataset.busy; });
  });

  function num(n) { return Number(n).toLocaleString(document.documentElement.lang || 'ru'); }
})();
