// Встречи на странице заведения (07.10, docs/MEETUPS.md): «Хочу сюда»,
// «Я тоже», убрать свою отметку, написать автору. Разметка —
// views/partials/venueMeetups.ejs; после каждого действия блок приходит
// заново фрагментом /venue/:id/meetups (routes/meetups.js), поэтому
// здесь нет своей отрисовки списка. Жалобу открывает report.js по data-report.
(function () {
  'use strict';
  const t = (key, vars) => (window.t ? window.t(key, vars) : '');
  const locale = () => (window.tkLang && window.tkLang() === 'en' ? 'en-US' : 'ru-RU');

  let box = document.getElementById('meetups');
  if (!box) return;
  const venueId = box.dataset.meetups;

  // Градиент аватара без фото — как tk-app.js при загрузке страницы; списки
  // формы — своими (tk-listbox.js): он оформляет только то, что было при загрузке.
  function paint(root) {
    root.querySelectorAll('[data-bg]').forEach((el) => { el.style.background = el.dataset.bg; });
    if (window.TKListbox) window.TKListbox.init(root);
  }

  function refresh() {
    return tkFetch('/venue/' + encodeURIComponent(venueId) + '/meetups', { headers: { 'X-TK-Fragment': '1' } })
      .then((r) => { if (!r.ok) throw r; return r.text(); })
      .then((html) => {
        const tpl = document.createElement('template');
        tpl.innerHTML = html.trim();
        const next = tpl.content.firstElementChild;
        if (!next) { box.remove(); return; }
        box.replaceWith(next);
        box = next;
        paint(box);
      })
      .catch((e) => TKNet.say(e));
  }

  // Дата рождения — один раз, как в настройках: три списка
  // (partials/birthSelect.ejs), сначала спрашиваем, верно ли.
  function birth(form) {
    const box = form.querySelector('[data-birth]');
    if (!box) return Promise.resolve(true);
    const part = (k) => box.querySelector('[data-birth-part="' + k + '"]').value;
    if (!part('y') || !part('m') || !part('d')) { toast(t('birth.incomplete'), 'error'); return Promise.resolve(false); }
    const value = part('y') + '-' + part('m') + '-' + part('d');
    const label = new Date(value + 'T00:00:00Z').toLocaleDateString(locale(), { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
    return confirmDialog(t('settings.birthConfirm', { date: label }), { okText: t('common.save') }).then((yes) => {
      if (!yes) return false;
      return TKNet.json('/settings/birthdate', { method: 'POST', body: { birthDate: value } }).then((r) => {
        // Младше 18: дальше нечего — блок пропадёт при обновлении.
        if (!r.adult) { toast(t('meet.adultOnly'), 'error'); refresh(); return false; }
        return true;
      });
    });
  }

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('#meetForm');
    if (!form) return;
    e.preventDefault();
    const day = form.elements.day;
    birth(form)
      .then((ok) => {
        if (!ok) return;
        return TKNet.json('/venue/' + encodeURIComponent(venueId) + '/meetups', {
          method: 'POST',
          body: { day: day.value, time: form.elements.time.value, note: form.elements.note.value.trim() },
        }).then(() => { toast(t('meet.done'), 'ok'); return refresh(); });
      })
      .catch((err) => TKNet.say(err));
  });

  document.addEventListener('click', (e) => {
    if (!box.contains(e.target)) return;

    const add = e.target.closest('[data-meet-new]');
    if (add) {
      const form = document.getElementById('meetForm');
      form.hidden = !form.hidden;
      add.setAttribute('aria-expanded', String(!form.hidden));
      // Без фокуса: на телефоне фокус на списке сам открывал бы системный выбор.
      if (!form.hidden) form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }

    const join = e.target.closest('[data-meet-join]');
    if (join) {
      TKNet.json('/meetups/' + join.dataset.meetJoin + '/join', { method: join.hasAttribute('data-joined') ? 'DELETE' : 'POST' })
        .then(refresh, (err) => TKNet.say(err));
      return;
    }

    const del = e.target.closest('[data-meet-del]');
    if (del) {
      confirmDialog(t('meet.delConfirm'), { okText: t('common.delete') }).then((yes) => {
        if (!yes) return;
        TKNet.json('/meetups/' + del.dataset.meetDel, { method: 'DELETE' }).then(refresh, (err) => TKNet.say(err));
      });
      return;
    }

    // Написать автору — как кнопка в профиле (public/profile.js): правила
    // переписки и заявки от незнакомых решает сервер.
    const write = e.target.closest('[data-meet-write]');
    if (write) {
      const peer = write.dataset.meetWrite;
      TKNet.json('/start-conversation', { method: 'POST', body: { recipientId: peer } })
        .then((d) => { if (d.success) location.href = '/chatsPage?peer=' + encodeURIComponent(peer); })
        .catch((err) => TKNet.say(err));
    }
  });
})();
