// Свои подписчики (/userPage/:id/followers): убрать из подписчиков
// и ограничить доступ к каналу. Маршруты — routes/streaming/subscriptions.js.
(function () {
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

  // Число на вкладке «Подписчики» — свежее от сервера.
  function setCount(n) {
    var num = document.querySelector('.tk-tabs__item--on .tk-tabs__num');
    if (num && typeof n === 'number') num.textContent = n;
  }

  document.addEventListener('click', function (e) {
    var remove = e.target.closest('[data-follower-remove]');
    var restrict = e.target.closest('[data-follower-restrict]');
    if (!remove && !restrict) return;
    var row = e.target.closest('[data-follower]');
    var id = row.getAttribute('data-follower');
    var name = (row.querySelector('.tk-person__name') || {}).textContent || '';
    var q = remove ? t('user.followerRemoveQ', { name: name }) : t('user.restrictQ', { name: name });
    var ok = remove ? t('user.followerRemove') : t('user.restrict');
    confirmDialog(q, { okText: ok }).then(function (yes) {
      if (!yes) return;
      var job = remove ? post('/followers/remove', { userId: id }) : post('/restrict', { userId: id, on: true });
      return job.then(function (r) {
        row.remove();
        setCount(r.followers);
        toast(t(remove ? 'user.followerRemoved' : 'user.restricted', { name: name }), 'ok');
      });
    }).catch(function (err) { toast(err.message, 'error'); });
  });
})();
