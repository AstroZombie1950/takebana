// Оценка на странице заведения /venue/:id (29.09; до того — в карточке
// поверх карты). Разметка — views/venue.ejs, оценку считает сервер
// (/rateEstablishment → utils/venueRating.js) и возвращает новую среднюю.
// Гость — на вход и обратно сюда.
(function () {
  const rate = document.getElementById('venueRate');
  if (!rate) return;
  const $ = (id) => document.getElementById(id);
  const t = (key, arg) => (window.t ? window.t(key, arg) : '');
  const tkText = (el, key, vars) => (window.tkText ? window.tkText(el, key, vars) : undefined);
  const venueId = document.querySelector('.tk-vp').dataset.venue;

  // Форма слова по числу: как plural() шаблонов (utils/i18n.js).
  function plural(n, base) {
    const d10 = n % 10, d100 = n % 100;
    return base + (d10 === 1 && d100 !== 11 ? 'One' : d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14) ? 'Few' : 'Many');
  }

  rate.addEventListener('click', (e) => {
    const b = e.target.closest('[data-value]');
    if (!b) return;
    if (!(window.TK && window.TK.userId)) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname);
      return;
    }
    tkFetch('/rateEstablishment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ establishmentId: venueId, rating: Number(b.dataset.value) }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.message || t('common.failedCode', { code: r.status }));
        return body;
      })
      .then((r) => {
        rate.querySelectorAll('[data-value]').forEach((x) => x.classList.toggle('is-on', Number(x.dataset.value) === r.rating));
        $('venueScore').textContent = r.average.toFixed(1);
        $('venueStars').style.setProperty('--v', r.average);
        $('venueVotesN').textContent = r.count.toLocaleString(window.tkLang && window.tkLang() === 'en' ? 'en-US' : 'ru-RU');
        tkText($('venueVotesWord'), plural(r.count, 'venues.votes'));
        toast(t('venues.rateThanks'), 'ok');
      })
      .catch((err) => toast(err.message, 'error'));
  });
})();
