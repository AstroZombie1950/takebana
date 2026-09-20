/* Каталог эфиров: фильтры и плашка гостю.
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

          // Градиент аватара ставится на загрузке страницы, подгруженной
          // сетке его никто больше не поставит. Подписи сервер отдаёт уже
          // на языке из cookie.
          results.querySelectorAll('[data-bg]').forEach(function (el) {
            el.style.background = el.getAttribute('data-bg');
          });
        })
        .catch(function (err) {
          // Сессия истекла или сервер ответил ошибкой — обычный переход,
          // дальше сервер сам решит, что показать.
          if (err.name !== 'AbortError') location.href = pageUrl;
        });
    };

    // Состав идущих эфиров изменился — перечитываем сетку (utils/liveSignal.js).
    // До 20.09.2026 витрина не менялась вовсе: событие о начале эфира уходило
    // только в комнату самого эфира, и человек, стоящий на главной, узнавал
    // о новом эфире лишь перезагрузкой.
    //
    // С задержкой и не чаще раза в пять секунд: когда эфир начинается,
    // сигналов приходит несколько подряд (RTMP, затем /set-active), а сетку
    // незачем перечитывать на каждый.
    var liveTimer = null;
    document.addEventListener('tk:live:changed', function () {
      if (liveTimer) return;
      liveTimer = setTimeout(function () {
        liveTimer = null;
        if (document.visibilityState === 'visible') load();
      }, 5000);
    });
    // Сокет мог подключиться позже этого места — просимся в комнату и здесь,
    // и на каждом переподключении.
    var watch = function () {
      if (window.callSocket && window.callSocket.connected) window.callSocket.emit('live:watch');
    };
    watch();
    document.addEventListener('tk:reconnect', watch);
    if (window.callSocket) window.callSocket.on('connect', watch);

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

  // Плашка «Что такое Takebana?» у гостя: закрыл — больше не показываем.
  // Cookie, а не localStorage: её читает сервер и плашку просто не рисует.
  var introClose = document.getElementById('tkIntroClose');
  if (introClose) {
    introClose.addEventListener('click', function () {
      document.cookie = 'tk_intro=0; path=/; max-age=31536000; samesite=lax';
      document.getElementById('tkIntro').remove();
    });
  }

});

