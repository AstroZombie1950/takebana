/* Каталог эфиров и главная: фильтры, плашка гостю, «Показать ещё» ленты.
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
    var topReset = form.querySelector('.tk-cat__reset');
    var liveCount = document.getElementById('liveCount');
    var pending = null;
    var loadedAt = Date.now();

    // quiet — обновление само по себе, без действия человека: сетка не
    // мигает «занято», одинаковая разметка не перерисовывается (карточки
    // не проигрывают появление заново), а сбой — не повод уводить страницу,
    // следующая попытка будет и так.
    var load = function (quiet) {
      var params = new URLSearchParams();
      new FormData(form).forEach(function (value, key) {
        if (value) params.append(key, value);
      });
      var qs = params.toString() ? '?' + params : '';
      var pageUrl = form.getAttribute('action') + qs;

      // Щёлкнули три тега подряд — нужен ответ на последний, а не на тот,
      // что пришёл позже остальных. Тихое обновление выбор человека
      // не перебивает.
      if (pending) {
        if (quiet) return;
        pending.abort();
      }
      var ctrl = pending = new AbortController();
      if (!quiet) results.setAttribute('aria-busy', 'true');

      tkFetch(form.dataset.grid + qs, { signal: ctrl.signal, headers: { 'X-TK-Fragment': '1' } })
        .then(function (res) {
          if (!res.ok) throw new Error(TKNet.explain(res));
          var n = Number(res.headers.get('X-Live-Count')) || 0;
          return res.text().then(function (html) { return { html: html, n: n }; });
        })
        .then(function (grid) {
          pending = null;
          loadedAt = Date.now();
          results.removeAttribute('aria-busy');
          if (liveCount) {
            liveCount.querySelector('[data-live-num]').textContent = grid.n;
            liveCount.hidden = !grid.n;
          }
          var box = document.createElement('template');
          box.innerHTML = grid.html;
          // Ничего не изменилось — сетку не трогаем: картинки не грузятся
          // заново, и место прокрутки ленты эфиров на телефоне не сбивается.
          if (quiet && print(box.content) === print(results)) return;
          // Новая сетка, пришедшая сама, — без появления карточек по одной.
          results.classList.toggle('is-still', !!quiet);
          results.replaceChildren(box.content);
          if (!quiet) history.replaceState(null, '', pageUrl);
          if (topReset) topReset.hidden = !(params.has('sub') || params.has('city'));

          // Градиент аватара ставится на загрузке страницы, подгруженной
          // сетке его никто больше не поставит. Подписи сервер отдаёт уже
          // на языке из cookie.
          results.querySelectorAll('[data-bg]').forEach(function (el) {
            el.style.background = el.getAttribute('data-bg');
          });
        })
        .catch(function (err) {
          if (ctrl !== pending) return; // перебит новым выбором (AbortError)
          pending = null;
          results.removeAttribute('aria-busy');
          // Сессия истекла или сервер ответил ошибкой на выбор человека —
          // обычный переход, дальше сервер сам решит, что показать. Сбой
          // связи (у ошибки tkFetch есть reason) — переход не откроется
          // тоже: говорим причину, выбор остаётся, можно нажать снова.
          // Тихому обновлению — следующая попытка (TKNet показал полосу связи).
          if (quiet) return;
          if (err.reason) TKNet.say(err);
          else location.href = pageUrl;
        });
    };

    // Отпечаток сетки: какие эфиры, у кого сколько зрителей, пусто ли.
    var print = function (root) {
      var cards = root.querySelectorAll('.tk-card');
      if (!cards.length) return root.querySelector('.tk-empty') ? 'filtered' : 'quiet';
      return Array.prototype.map.call(cards, function (card) {
        var eyes = card.querySelector('.tk-card__eyes');
        return card.getAttribute('href') + ':' + (eyes ? eyes.textContent.trim() : '');
      }).join();
    };

    // ── Живая сетка ──────────────────────────────────────────────────────
    //
    // Состав идущих эфиров изменился — перечитываем сетку (utils/liveSignal.js).
    // До 20.09.2026 витрина не менялась вовсе: событие о начале эфира уходило
    // только в комнату самого эфира.
    //
    // Одного сигнала мало (02.10: у заказчика с VPN на главной были эфиры,
    // а у нас на только что открытой — пусто).
    // Сигнал теряется, когда его некому принять: у гостя сокета нет вовсе;
    // через VPN сокет рвётся каждые несколько секунд, и всё, что ушло
    // в обрыв, не дойдёт; сигнал, пришедший в свёрнутую вкладку, прежде
    // выбрасывался; страница с иконки «Домой» и из «назад» показывается
    // такой, какой была. Поэтому сетка перечитывается ещё и после
    // переподключения, при возвращении к странице, если она простояла
    // дольше минуты, и раз в минуту — пока сокета нет.
    //
    // Не чаще раза в пять секунд: когда эфир начинается, сигналов приходит
    // несколько подряд (RTMP, затем /set-active), а сокет через VPN
    // переподключается раз за разом.
    var STALE = 60000;
    var timer = null;
    var due = false; // пришло, пока страница была не на экране
    var refresh = function () {
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        if (document.visibilityState === 'visible') load(true); else due = true;
      }, Math.max(0, 5000 - (Date.now() - loadedAt)));
    };
    var socketUp = function () { return !!(window.callSocket && window.callSocket.connected); };

    document.addEventListener('tk:live:changed', refresh);
    document.addEventListener('tk:reconnect', refresh);
    var back = function () {
      if (document.visibilityState !== 'visible') return;
      if (due || Date.now() - loadedAt > STALE) { due = false; refresh(); }
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('pageshow', function (e) { if (e.persisted) back(); });
    setInterval(function () {
      if (!socketUp() && document.visibilityState === 'visible' && Date.now() - loadedAt > STALE) refresh();
    }, 15000);
    // «Назад» может отдать страницу из дискового кэша — со скриптами заново,
    // но с сеткой на момент первого показа. Вошедшему это сверит
    // tk:reconnect, гостю — некому.
    var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (nav && nav.type === 'back_forward' && !(window.TK && TK.userId)) refresh();

    // Сокет мог подключиться позже этого места — просимся в комнату и здесь,
    // и на каждом подключении.
    var watch = function () {
      if (socketUp()) window.callSocket.emit('live:watch');
    };
    watch();
    if (window.callSocket) window.callSocket.on('connect', watch);

    form.addEventListener('change', function () { load(); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      load();
    });

    // Сброс снимает город и подкатегории, сортировку оставляет. Ссылок две —
    // над сеткой и в пустом состоянии, вторая приходит вместе с сеткой.
    form.addEventListener('click', function (e) {
      if (!e.target.closest('[data-reset]')) return;
      e.preventDefault();
      // На главной подкатегории — скрытые поля из старых ссылок /?sub=…
      form.querySelectorAll('input[name="sub"]').forEach(function (box) {
        if (box.type === 'hidden') box.remove(); else box.checked = false;
      });
      form.elements.city.value = '';
      load();
    });
  }

  // Лента главной и раздел «Лента» (/feed): «Показать ещё» дописывает
  // следующую страницу. Откуда брать — у кнопки: data-src — фрагмент
  // (/home/next, /feed/next), href — та же выдача страницей, ею кнопка
  // работает без скрипта. Курсор дальше сервер отдаёт заголовком X-Feed-Next.
  // data-auto — подгружать самой, когда кнопка подходит к экрану (/feed).
  var feed = document.getElementById('feed');
  var more = document.getElementById('feedMore');
  if (feed && more) {
    var withCursor = function (url, next) {
      var u = new URL(url, location.href);
      u.searchParams.set('before', next);
      return u.pathname + u.search + u.hash;
    };
    if (more.hasAttribute('data-auto') && 'IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting && more.isConnected && !more.dataset.failed) more.click();
      }, { rootMargin: '600px 0px' }).observe(more);
    }
    more.addEventListener('click', function (e) {
      e.preventDefault();
      if (more.getAttribute('aria-busy')) return;
      more.setAttribute('aria-busy', 'true');
      tkFetch(withCursor(more.dataset.src, more.dataset.next), { headers: { 'X-TK-Fragment': '1' } })
        .then(function (res) {
          if (!res.ok) throw new Error(TKNet.explain(res));
          var next = res.headers.get('X-Feed-Next');
          return res.text().then(function (html) { return { html: html, next: next }; });
        })
        .then(function (page) {
          var box = document.createElement('div');
          box.innerHTML = page.html;
          box.querySelectorAll('[data-bg]').forEach(function (el) { el.style.background = el.getAttribute('data-bg'); });
          while (box.firstElementChild) feed.appendChild(box.firstElementChild);
          if (page.next) {
            tkText(more, 'feed.more');
            more.dataset.next = page.next;
            more.href = withCursor(more.href, page.next);
            delete more.dataset.failed;
            more.removeAttribute('aria-busy');
          } else {
            more.remove();
          }
        })
        // Не загрузилось — кнопка остаётся и говорит об этом (NOTICES.md,
        // «Остальное»): раньше уводила на /?before=…, и без связи вместо
        // ленты открывалась ошибка браузера. Причина — тостом.
        .catch(function (err) {
          more.removeAttribute('aria-busy');
          more.dataset.failed = '1'; // сама больше не тянет — по нажатию
          tkText(more, 'feed.moreFailed');
          TKNet.say(err);
        });
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

