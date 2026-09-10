/* Каталог эфиров: фильтры, «Показать ещё» в рекомендациях, «Стать первым».
 *
 * Фильтры — обычная GET-форма, и без скрипта она работает перезагрузкой
 * страницы. Скрипт перехватывает смену значения и подменяет только сетку:
 * её отдаёт /streaming/:category/grid, без шапки, подписок и уведомлений.
 *
 * Что уехало из прежней версии:
 *   — IntersectionObserver на появление карточек. Появление делает
 *     CSS-анимация в catalog.css, наблюдать за прокруткой не за чем.
 *   — Обработчик .button__subscribe. Кнопок с таким классом на странице нет
 *     ни одной — код висел мёртвым.
 */

document.addEventListener('DOMContentLoaded', function () {
  var form = document.getElementById('catFilters');
  var results = document.getElementById('catResults');

  if (form && results) {
    var submit = form.querySelector('[type="submit"]');
    if (submit) submit.remove();

    var topReset = form.querySelector('.tk-cat__reset');
    var pending = null;

    var load = function () {
      var params = new URLSearchParams();
      new FormData(form).forEach(function (value, key) {
        if (value) params.append(key, value);
      });
      var qs = params.toString() ? '?' + params : '';
      var pageUrl = form.getAttribute('action') + qs;

      // Щёлкнули три тега подряд — нужен ответ на последний, а не на тот,
      // что пришёл позже остальных.
      if (pending) pending.abort();
      var ctrl = pending = new AbortController();
      results.setAttribute('aria-busy', 'true');

      fetch(form.dataset.grid + qs, { signal: ctrl.signal })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.text();
        })
        .then(function (html) {
          results.innerHTML = html;
          results.removeAttribute('aria-busy');
          history.replaceState(null, '', pageUrl);
          if (topReset) topReset.hidden = !(params.has('sub') || params.has('city'));

          // Градиент аватара и перевод подписей ставятся на загрузке страницы,
          // подгруженной сетке их никто больше не поставит.
          results.querySelectorAll('[data-bg]').forEach(function (el) {
            el.style.background = el.getAttribute('data-bg');
          });
          if (window.applyLang) window.applyLang(localStorage.getItem('lang'));
        })
        .catch(function (err) {
          // Сессия истекла или сервер ответил ошибкой — обычный переход,
          // дальше сервер сам решит, что показать.
          if (err.name !== 'AbortError') location.href = pageUrl;
        });
    };

    form.addEventListener('change', load);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      load();
    });

    // Сброс снимает город и подкатегории, сортировку оставляет. Ссылок две —
    // над сеткой и в пустом состоянии, вторая приходит вместе с сеткой.
    form.addEventListener('click', function (e) {
      if (!e.target.closest('[data-reset]')) return;
      e.preventDefault();
      form.querySelectorAll('input[name="sub"]').forEach(function (box) { box.checked = false; });
      form.elements.city.value = '';
      load();
    });
  }

  // «Показать ещё» в рекомендациях: раскрывает тех, кого роут уже прислал.
  var more = document.getElementById('showMoreUsers');
  if (more) {
    more.addEventListener('click', function () {
      document.querySelectorAll('.tk-rec__item.hidden').forEach(function (item) {
        item.classList.remove('hidden');
      });
      more.remove();
    });
  }

  // «Стать первым» в пустом состоянии открывает те же настройки эфира,
  // что кнопка в шапке. Кнопка приходит и с подгруженной сеткой, поэтому
  // обработчик висит на документе.
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#start-stream-btn')) return;
    var modal = document.getElementById('streamSettingsModal');
    if (modal) modal.classList.remove('hidden');
  });
});
