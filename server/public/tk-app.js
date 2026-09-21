/* Каркас сайта: шапка, левая панель, модальные окна, поиск и звонки.
 * У гостя (TK.userId пуст) окон и звонков на странице нет, присутствие
 * на сокете не слушается — точки рисует сервер.
 *
 * Раньше жил инлайном в header.ejs — 1537 строк в шаблоне, которые заново
 * прилетали с каждой страницей и не кэшировались. Из EJS сюда приходит
 * одно значение — id пользователя, оно в window.TK.
 *
 * Разметка модалок — views/partials/appModals.ejs, стили — css/app.css.
 */
var TK = window.TK || { userId: '' };

// Подписи — из общего словаря (public/tk-i18n.js), он подключён выше в шапке.
// Этот файл без обёртки, его `var` попадает в window: поэтому именно ссылка
// на готовую функцию, а не обёртка вокруг window.t — обёртка присвоилась бы
// в window.t и вызывала бы саму себя. Заглушка — если словарь не загрузился:
// кабинет должен остаться рабочим.
var t = window.t || function () { return ''; };
// Текст, который переживает переключение языка: ключ остаётся на элементе.
var tkText = window.tkText || function () {};

// Левая панель — единственное меню кабинета. На десктопе стоит всегда,
// ниже 1024 выезжает по бургеру из шапки поверх страницы. Раньше рядом жили
// ещё мобильное меню и выпадашка у аватара с теми же ссылками.
document.addEventListener('DOMContentLoaded', () => {
  const burger = document.getElementById('sidebarToggle');
  const aside = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (!burger || !aside || !overlay) return;

  function setOpen(on) {
    aside.classList.toggle('is-open', on);
    overlay.hidden = !on;
    burger.setAttribute('aria-expanded', String(on));
    document.body.style.overflow = on ? 'hidden' : '';
  }
  window.closeSidebar = () => setOpen(false);

  burger.addEventListener('click', () => setOpen(!aside.classList.contains('is-open')));
  overlay.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && aside.classList.contains('is-open')) setOpen(false);
  });
  // Растянули окно с открытой панелью — на десктопе она не выезжает, а
  // запрет прокрутки остался бы.
  matchMedia('(min-width: 1024px)').addEventListener('change', (e) => { if (e.matches) setOpen(false); });
});

// Ссылки без адреса: соцсети и телеграм в подвале — адресов пока нет.
// Гасим только прыжок наверх страницы.
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('a[href="#"]')) e.preventDefault();
});

// Apply gradients from data-bg (used across multiple pages)
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-bg]').forEach((el) => {
    const bg = el.getAttribute('data-bg');
    if (bg) el.style.background = bg;
  });
});

// Apply animation delays from data-anim-delay (EJS-friendly, linter-safe)
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-anim-delay]').forEach((el) => {
    const d = el.getAttribute('data-anim-delay');
    if (d) el.style.animationDelay = d;
  });
});

// Точка непрочитанного на колокольчике. Зажигает её сокет (notification:new),
// гасит открытие списка уведомлений.
// Счётчик у иконки переписки в шапке: непрочитанные сообщения + пропущенные
// звонки. part — точные числа { messages, calls } или приращения
// { addMessages, addCalls }; обе части хранятся в data-атрибутах значка.
window.tkChatBadge = function (part) {
  const badge = document.querySelector('[data-chat-badge]');
  if (!badge) return;
  const d = badge.dataset;
  let m = Number(d.messages) || 0;
  let c = Number(d.calls) || 0;
  if (typeof part.messages === 'number') m = part.messages;
  if (typeof part.calls === 'number') c = part.calls;
  m = Math.max(0, m + (part.addMessages || 0));
  c = Math.max(0, c + (part.addCalls || 0));
  d.messages = m;
  d.calls = c;
  badge.textContent = m + c > 99 ? '99+' : String(m + c);
  badge.classList.toggle('hidden', !(m + c));
};

window.setNotificationDot = function (on) {
  const dot = document.getElementById('notificationDot');
  if (dot) dot.classList.toggle('hidden', !on);
};

// Подписки в левой панели. Кнопка «Подписаться» на странице человека
// и в эфире сообщает сюда — строка появляется и пропадает сразу, а не
// после перезагрузки страницы.
window.tkSubscriptions = {
  add(user) {
    const list = document.getElementById('subsList');
    if (!list || !user || list.querySelector(`[data-sub-id="${CSS.escape(user.id)}"]`)) return;
    const live = user.status === 'online';
    const ava = user.avatarStyle || {};
    const row = document.createElement('a');
    row.className = 'tk-aside__sub';
    row.href = '/userPage/' + encodeURIComponent(user.id);
    row.dataset.subId = user.id;
    row.dataset.presenceUser = user.id;
    row.dataset.live = live ? '1' : '0';
    row.innerHTML = `
      <div class="tk-aside__ava">
        ${ava.url ? `<img src="${escapeHtml(ava.url)}" alt="">` : escapeHtml(ava.initial || '?')}
        <span class="presence-dot ${live ? 'presence-online' : 'presence-offline'}"></span>
      </div>
      <div style="min-width: 0;">
        <p class="tk-aside__sub-name">${escapeHtml(user.displayName || '')}</p>
        <p class="tk-aside__sub-state" data-presence-text data-i18n="${live ? 'common.online' : 'common.offline'}">${escapeHtml(t(live ? 'common.online' : 'common.offline'))}</p>
      </div>`;
    if (!ava.url && ava.gradient) row.firstElementChild.style.background = ava.gradient;
    list.prepend(row);
    this.sync();
  },
  remove(id) {
    const row = document.querySelector(`#subsList [data-sub-id="${CSS.escape(String(id))}"]`);
    if (row) row.remove();
    this.sync();
  },
  // «Пока нет подписок» и счётчик «N в эфире».
  sync() {
    const rows = document.querySelectorAll('#subsList [data-sub-id]');
    const live = document.querySelectorAll('#subsList [data-live="1"]').length;
    const empty = document.getElementById('subsEmpty');
    const count = document.getElementById('subsOnline');
    if (empty) empty.classList.toggle('hidden', rows.length > 0);
    if (count) {
      count.classList.toggle('hidden', !live);
      count.querySelector('b').textContent = live;
    }
  }
};

// Модальные окна
document.addEventListener('DOMContentLoaded', () => {
  const modals = {
    notification: document.getElementById('notificationModal')
  };

  const closeButtons = {
    notification: document.getElementById('closeNotificationModal')
  };

  // Закрытие модальных окон
  Object.keys(closeButtons).forEach(key => {
    if (closeButtons[key]) {
      closeButtons[key].addEventListener('click', () => {
        modals[key].classList.add('hidden');
      });
    }
  });

  // Закрытие по клику вне модального окна
  Object.keys(modals).forEach(key => {
    if (modals[key]) {
      modals[key].addEventListener('click', (e) => {
        if (e.target === modals[key]) {
          modals[key].classList.add('hidden');
        }
      });
    }
  });

  const open = (modal) => {
    if (window.closeSidebar) window.closeSidebar();
    modal.classList.remove('hidden');
  };

  // Уведомления. Открыли список — значит, прочитали: точка в шапке гаснет,
  // а новые строки остаются подсвеченными до следующего открытия. Строка —
  // ссылка туда, о чём уведомление: переписка с отправителем или звонки.
  // Раньше уведомление читалось только входом в тот самый диалог, и точка
  // горела, сколько список ни открывай.
  const notificationButton = document.getElementById('notificationButton');
  const notificationsContent = document.getElementById('notificationsContent');
  const clearNotifications = document.getElementById('clearNotifications');
  const note = (key, bad) => `<p class="tk-note tk-note--center${bad ? ' tk-note--bad' : ''}" data-i18n="${key}">${escapeHtml(t(key))}</p>`;

  if (notificationButton && notificationsContent) {
    notificationButton.addEventListener('click', async () => {
      open(modals.notification);
      notificationsContent.innerHTML = note('modal.notifications.loading');

      try {
        const response = await fetch('/api/notifications');
        if (!response.ok) throw new Error(response.status);
        const notifications = await response.json();

        if (clearNotifications) clearNotifications.classList.toggle('hidden', !notifications.length);
        if (!notifications.length) {
          notificationsContent.innerHTML = note('modal.notifications.empty');
        } else {
          notificationsContent.innerHTML = notifications.map((n) => {
            const sender = n.sender || {};
            const name = sender.name || t('modal.notifications.unknown');
            const isCall = n.type === 'call';
            const isComment = n.type === 'comment';
            // Эфир: ведёт на сам эфир, а текстом — его название (utils/liveNotify.js).
            const isLive = n.type === 'live';
            const isFollow = n.type === 'follow';
            const href = isCall ? '/chatsPage?tab=calls'
              : isComment || isLive || isFollow ? (n.link || '/')
              : '/chatsPage?peer=' + encodeURIComponent(sender._id || '');
            const title = isCall ? t('modal.notifications.missedCall', { name })
              : isComment ? t('modal.notifications.comment', { name })
              : isLive ? t('modal.notifications.live', { name })
              : isFollow ? t('modal.notifications.follow', { name })
              : t('modal.notifications.from') + ' ' + name;
            const text = isCall || isFollow ? '' : isLive ? (n.content || '') : (n.content || t('modal.notifications.fallback'));
            return `
            <a class="tk-notice${n.isRead ? '' : ' tk-notice--new'}" href="${escapeHtml(href)}">
              <span class="tk-notice__top">
                <span class="tk-notice__from">${escapeHtml(title)}</span>
                <time class="tk-notice__when">${escapeHtml(tkDate(n.createdAt))}</time>
              </span>
              ${text ? `<span class="tk-notice__text">${escapeHtml(text)}</span>` : ''}
            </a>`;
          }).join('');
        }

        if (notifications.some((n) => !n.isRead)) {
          fetch('/api/notifications/read', { method: 'PUT' }).catch(() => {});
        }
        window.setNotificationDot(false);
      } catch (error) {
        console.error('Уведомления:', error);
        notificationsContent.innerHTML = note('modal.notifications.error', true);
      }
    });
  }

  if (clearNotifications && notificationsContent) {
    clearNotifications.addEventListener('click', async () => {
      try {
        const r = await fetch('/api/notifications', { method: 'DELETE' });
        if (!r.ok) throw new Error(r.status);
        notificationsContent.innerHTML = note('modal.notifications.empty');
        clearNotifications.classList.add('hidden');
        window.setNotificationDot(false);
      } catch (e) {
        toast(t('modal.notifications.clearFailed'), 'error');
      }
    });
  }

});

// Поиск в шапке: быстрые результаты выпадашкой, полные — на /search.
// На телефоне выпадашки нет: Enter сразу открывает страницу результатов.
//
// Поле лежит в обычной форме, поэтому Enter и кнопка лупы работают и без
// скрипта. Скрипт добавляет к этому выпадашку: одна строка запроса — один
// запрос к /api/search, ответ группами (люди, эфиры, записи, заведения).
//
// Прежняя версия искала только людей, на каждое нажатие клавиши, и после
// отрисовки пересобирала строки клонированием узлов, чтобы навесить
// обработчик, — ссылки перехватывались и открывались через setTimeout.
// Теперь строка — просто ссылка.
document.addEventListener('DOMContentLoaded', function () {
  // Меньше двух символов не ищем: столько же требует сервер.
  const MIN = 2;
  const GROUPS = [
    { key: 'people',     i18n: 'search.people',     href: (x) => '/userPage/' + encodeURIComponent(x._id) },
    { key: 'streams',    i18n: 'search.streams',    href: (x) => '/stream/' + encodeURIComponent(x._id) },
    { key: 'recordings', i18n: 'search.recordings', href: (x) => '/recording/' + encodeURIComponent(x._id) },
    { key: 'venues',     i18n: 'search.venues',     href: (x) => '/main?venue=' + encodeURIComponent(x._id) }
  ];

  // Аватар человека: фото или буква на своём градиенте.
  function avatar(style, fallback) {
    const s = style || {};
    return s.url
      ? `<img class="tk-found__ava" src="${escapeHtml(s.url)}" alt="" loading="lazy">`
      : `<span class="tk-found__ava" style="background: ${escapeHtml(s.gradient || 'var(--tk-accent)')};">${escapeHtml(s.initial || fallback || '?')}</span>`;
  }

  // Обложка эфира или записи: без картинки — пустая рамка, чтобы строки
  // не прыгали по высоте.
  const shot = (url) => `<span class="tk-found__shot">${url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy">` : ''}</span>`;

  function row(key, item) {
    const href = GROUPS.find((g) => g.key === key).href(item);
    let media = '';
    let name = '';
    let meta = '';

    if (key === 'people') {
      media = avatar(item.avatarStyle, item.displayName);
      name = item.displayName;
      meta = `${t('authors.followers')}: ${item.followersCount}`;
    } else if (key === 'streams') {
      media = shot(item.thumbnail);
      name = item.title;
      meta = `${item.author.displayName} · ${item.viewers} ${t('search.viewers')}`;
    } else if (key === 'recordings') {
      media = shot(item.thumb);
      name = item.title;
      meta = item.author.displayName;
    } else {
      media = shot(item.photo);
      name = item.name;
      meta = [item.address, item.online ? t('venues.liveNow') : ''].filter(Boolean).join(' · ');
    }

    return `
      <a href="${href}" class="search-result-item"${key === 'people' ? ` data-presence-user="${escapeHtml(item._id)}"` : ''}>
        ${media}
        <span class="tk-found__body">
          <span class="tk-found__name">${escapeHtml(name)}</span>
          <span class="tk-found__meta">${escapeHtml(meta)}</span>
        </span>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true"><path d="M9 5l7 7-7 7"></path></svg>
      </a>`;
  }

  function render(box, data) {
    const parts = GROUPS
      .filter((g) => (data[g.key] || []).length)
      .map((g) => `<p class="tk-found__group" data-i18n="${g.i18n}">${escapeHtml(t(g.i18n))}</p>` +
                  data[g.key].map((item) => row(g.key, item)).join(''));

    box.innerHTML = parts.length
      ? parts.join('') +
        `<a href="/search?q=${encodeURIComponent(data.query)}" class="tk-found__all" data-i18n="search.allResults">${escapeHtml(t('search.allResults'))}</a>`
      : `<div class="tk-found__empty">
           <p class="tk-found__name" data-i18n="app.searchEmpty">${escapeHtml(t('app.searchEmpty'))}</p>
           <p class="tk-note" data-i18n="app.searchEmptyHint">${escapeHtml(t('app.searchEmptyHint'))}</p>
         </div>`;
    box.classList.remove('hidden');

    // Люди из выдачи появились на экране только что — точки присутствия
    // ведёт тот же механизм, что и в панели подписок.
    const ids = Array.from(box.querySelectorAll('[data-presence-user]'))
      .map((el) => el.getAttribute('data-presence-user'));
    if (ids.length && window.subscribePresence) {
      window.subscribePresence(ids);
      fetch('/api/presence?ids=' + encodeURIComponent(ids.join(',')))
        .then((r) => (r.ok ? r.json() : { users: [] }))
        .then((d) => (d.users || []).forEach((u) => window.dispatchEvent(new CustomEvent('presence:init', { detail: u }))))
        .catch(() => {});
    }
  }

  function attach(input, box) {
    if (!input || !box) return;
    let timer = null;
    let ctrl = null;

    const hide = () => { box.classList.add('hidden'); box.replaceChildren(); };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      // Выпадашка работает и на телефоне. Раньше там её не было вовсе —
      // поле поиска в шапке молчало, пока не нажмёшь Enter, и выглядело это
      // как «не находит, если не до конца набрать имя». Место ей есть:
      // она растянута по ширине поля, а поле на телефоне занимает всю шапку.
      if (q.length < MIN) return hide();
      // Задержка: иначе каждая буква — запрос с перебором по базе.
      timer = setTimeout(() => {
        if (ctrl) ctrl.abort();
        const own = ctrl = new AbortController();
        fetch('/api/search?q=' + encodeURIComponent(q), { signal: own.signal })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => { if (data) render(box, data); })
          .catch((e) => { if (e.name !== 'AbortError') console.error('[search]', e); });
      }, 200);
    });

    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    // Выпадашка — внутри формы: щелчок по ссылке не должен её отправлять.
    box.addEventListener('mousedown', (e) => e.stopPropagation());
    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !box.contains(e.target)) hide();
    });
  }

  attach(document.getElementById('searchInput'), document.getElementById('searchResults'));
});

// ===== Сайт как приложение на телефоне =====
// Регистрируем service worker (public/sw.js): без него Android не предлагает
// установку, а вкладка без сети показывает ошибку браузера вместо страницы.
// Страницы он не кэширует — почему именно так, написано в самом файле.
//
// Адрес — свой, без версии в имени: worker обязан лежать в корне, иначе его
// область не покроет весь сайт. Обновление браузер ищет сам, по этому же
// адресу; nginx отдаёт его с перепроверкой (ops/nginx/takebana.conf).
// isSecureContext, а не «протокол https»: localhost и 127.0.0.1 браузер
// тоже считает надёжными, и без этого service worker — а с ним и пуши —
// не работали при разработке вовсе, только после выкладки.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('[sw]', e));
  });
}

// Фоновая загрузка видео (tk-upload.js) — только там, где есть что
// докачивать: метку ставит сама загрузка. Страница загрузки подключает
// скрипт сама.
(function () {
  var has = false;
  try { has = !!localStorage.getItem('tk.uploads'); } catch (e) {}
  if (!has || !window.TK || !TK.upload || window.TKUpload || document.querySelector('script[src="' + TK.upload + '"]')) return;
  var s = document.createElement('script');
  s.src = TK.upload;
  s.defer = true;
  document.head.appendChild(s);
})();

// ===== Presence Client (глобально) =====
(function(){
  function initPresenceAndCalls(){
  try {
    if (typeof io !== 'function' || !TK.userId) return; // socket.io — только вошедшему
    // Вебсокет — первым, длинный опрос — запасным путём (см. app.js).
    // Сеть, которая не пропускает Upgrade, иначе оставляла бы страницу
    // совсем без живых обновлений и молча: connect_error повторялся бы
    // бесконечно, а tk:reconnect не срабатывал бы ни разу — он приходит
    // только после первого удачного подключения.
    const socket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
    });
    window.callSocket = socket;
    console.log('[client] socket init');
    socket.on('connect', () => console.log('[client] socket connected id=', socket.id));
    socket.on('connect_error', (err) => console.warn('[client] socket connect_error', err.message)); // сеть пропала — штатно, переподключится сам
    socket.on('disconnect', (reason) => console.log('[client] socket disconnected', reason));

    // Переписка: события сокета уходят в document как tk:<событие>, их слушает
    // страница переписки (chats.js). Колокольчик зажигается на любой странице.
    ['message:new', 'message:failed', 'message:expired', 'message:limit', 'message:read', 'message:delivered', 'message:deleted', 'conversation:deleted', 'call:logged', 'call:deleted', 'live:changed', 'author:live', 'recording:status'].forEach((name) => {
      socket.on(name, (detail) => document.dispatchEvent(new CustomEvent('tk:' + name, { detail })));
    });
    socket.on('notification:new', () => window.setNotificationDot(true));
    // Удалили непрочитанное — сервер присылает точное число (messages.js, unreadAfter).
    ['message:deleted', 'conversation:deleted'].forEach((name) => {
      socket.on(name, (d) => { if (d && typeof d.unreadMessages === 'number') window.tkChatBadge({ messages: d.unreadMessages }); });
    });
    // Входящее сообщение — +1 у иконки переписки. Открытый диалог тут же
    // его читает, и chats.js ставит точное число из ответа сервера.
    socket.on('message:new', (d) => {
      if (d && d.message && d.peer && d.message.sender === d.peer.id) window.tkChatBadge({ addMessages: 1 });
      // Звук и системное уведомление — если включены в настройках (tk-notify.js).
      if (window.TKNotify) window.TKNotify.message(d);
    });
    // Пропущенный звонок — счётчик у иконки переписки в шапке и у вкладки
    // «Звонки». Открытая вкладка гасит его сама (chats.js).
    socket.on('call:missed', () => {
      window.tkChatBadge({ addCalls: 1 });
      document.querySelectorAll('[data-missed-calls]').forEach((badge) => {
        badge.textContent = String((parseInt(badge.textContent, 10) || 0) + 1);
        badge.classList.remove('hidden');
      });
    });
    // ── Сверка с сервером ────────────────────────────────────────────────
    //
    // Всё живое на странице держится на событиях сокета, а значки в шапке —
    // ещё и на приращениях к числу, отрисованному сервером. Пропустили одно
    // событие — страница показывает не то, и до перезагрузки так и будет.
    //
    // Сверка идёт в двух видах. Лёгкая — счётчики точными числами
    // (/api/badge) и присутствие тех, чьи точки сейчас на экране: дёшево
    // и ничего на странице не двигает. Полная — она же плюс tk:reconnect,
    // по которому страницы перечитывают своё содержимое (chats.js — открытый
    // диалог и журнал звонков). Полная только после настоящего обрыва: она
    // перерисовывает ленту и уводит её вниз, и делать это на каждом
    // возвращении к вкладке значило бы терять место, где человек читал.
    function refreshCounters() {
      fetch('/api/badge', { headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) return;
          window.tkChatBadge({ messages: d.unreadMessages, calls: d.missedCalls });
          window.setNotificationDot(d.notifications > 0);
        })
        .catch(() => {});

      const ids = Array.from(document.querySelectorAll('[data-presence-user]'))
        .map((el) => el.getAttribute('data-presence-user')).filter(Boolean);
      if (!ids.length) return;
      fetch('/api/presence?ids=' + encodeURIComponent(ids.slice(0, 200).join(',')))
        .then((r) => (r.ok ? r.json() : { users: [] }))
        .then((d) => {
          (d.users || []).forEach((u) => {
            setPresence(String(u._id), !!u.isOnline, u.lastSeen);
            // «В эфире» сверяется тем же ответом: событие author:live могло
            // уйти, пока вкладка спала.
            document.querySelectorAll(`[data-presence-user="${u._id}"][data-sub-id]`).forEach((row) => {
              row.dataset.live = u.isLive ? '1' : '0';
            });
          });
          if (window.tkSubscriptions) window.tkSubscriptions.sync();
        })
        .catch(() => {});
    }

    function resync() {
      refreshCounters();
      document.dispatchEvent(new CustomEvent('tk:reconnect'));
    }

    // Связь вернулась после обрыва: за это время могло прийти что-то, чего
    // сокет уже не доставит.
    let connectedOnce = false;
    socket.on('connect', () => {
      if (connectedOnce) resync();
      connectedOnce = true;
    });

    // Вкладка вернулась к человеку. На телефоне это главный случай: страницу,
    // открытую с иконки на домашнем экране, айфон не перезагружает, а
    // замораживает и потом размораживает — сокет к этому моменту давно мёртв,
    // а страница показывает то, что было час назад. Здесь она оживает сама.
    //
    // bfcache («назад» в браузере) возвращает страницу так же — pageshow
    // с persisted. Событие online — сеть вернулась, но сокет ещё не заметил.
    let wokeAt = 0;
    function wake() {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - wokeAt < 3000) return; // частое переключение — не повод ходить на сервер
      wokeAt = Date.now();
      if (!socket.connected) return socket.connect(); // connect сам позовёт resync

      // Сокет считает себя живым — но замороженная вкладка возвращается
      // с мёртвым соединением, и само оно заметит это только по таймауту
      // пинга, до двадцати секунд. Спрашиваем сервер напрямую: не ответил —
      // переподключаемся, и connect приведёт полную сверку.
      socket.timeout(4000).emit('tk:alive', (err) => {
        if (err) { socket.disconnect().connect(); return; }
        refreshCounters();
        // Сокет жив, но пока вкладка спала, событие могло не дойти и до
        // живого: страницы сверяют своё лёгким способом (chats.js).
        document.dispatchEvent(new CustomEvent('tk:wake'));
      });
    }
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', (e) => { if (e.persisted) wake(); });
    window.addEventListener('online', wake);

    function setPresence(userId, online, lastSeen) {
      const nodes = document.querySelectorAll(`[data-presence-user="${userId}"]`);
      nodes.forEach(el => {
        el.classList.remove('presence-online', 'presence-offline');
        el.classList.add(online ? 'presence-online' : 'presence-offline');
        // Синхронизируем внутренние контейнеры, если есть
        el.querySelectorAll('.presence-online, .presence-offline').forEach(n => {
          n.classList.remove('presence-online', 'presence-offline');
          n.classList.add(online ? 'presence-online' : 'presence-offline');
        });
        const textEl = el.querySelector('[data-presence-text]');
        if (textEl) {
          // Ключ переезжает на сам элемент: внутренний <span data-i18n> здесь
          // затирается, и без этого строка перестала бы переводиться
          // при следующем переключении языка.
          tkText(textEl, online ? 'common.online' : 'common.offline');
          textEl.title = lastSeen ? tkDate(lastSeen) : '';
        }
        // Цвет точки — из дизайн-системы, классами. Раньше здесь инлайном
        // проставлялись зелёный и серый Tailwind, мимо токенов темы.
        const dot = el.querySelector('.presence-dot');
        if (dot) {
          dot.classList.remove('presence-online', 'presence-offline');
          dot.classList.add(online ? 'presence-online' : 'presence-offline');
        }
      });

      // Обновим строку "Последний раз в сети"
      const lastSeenNodes = document.querySelectorAll(`[data-presence-lastseen-user="${userId}"]`);
      lastSeenNodes.forEach(lsEl => {
        // «Сейчас» и прочерк — словарные, дата — нет: ключ снимаем, иначе
        // переключение языка затёрло бы дату.
        const key = online ? 'common.now' : (lastSeen ? '' : 'common.dash');
        tkText(lsEl, key);
        if (!key) lsEl.textContent = tkDate(lastSeen);
      });
    }

    socket.on('presence:update', ({ userId, isOnline, lastSeen }) => {
      if (!userId) return;
      setPresence(String(userId), !!isOnline, lastSeen);
    });

    // Подписка вышла в эфир или ушла из него (utils/liveSignal.js). Приходит
    // в ту же комнату presence:<id>, на которую страница уже подписана ради
    // точек «в сети», — отдельной подписки не нужно. До 20.09.2026 «в эфире»
    // не менялось вовсе и при отрисовке всегда было ложью: сервер читал поле
    // isStreaming, которого в базе нет.
    socket.on('author:live', ({ userId, live }) => {
      if (!userId) return;
      document.querySelectorAll(`[data-presence-user="${userId}"][data-sub-id]`).forEach((row) => {
        row.dataset.live = live ? '1' : '0';
      });
      if (window.tkSubscriptions) window.tkSubscriptions.sync();
    });

    // Число подписчиков и подписок поменялось (utils/profileSignal.js):
    // кто-то подписался, отписался или его убрали из подписчиков.
    socket.on('profile:counts', ({ userId, followers, following }) => {
      if (!userId) return;
      document.querySelectorAll(`[data-count-followers="${userId}"]`).forEach((el) => { el.textContent = String(followers); });
      document.querySelectorAll(`[data-count-following="${userId}"]`).forEach((el) => { el.textContent = String(following); });
    });

    // Подписка появилась или пропала — в том числе автор убрал меня из
    // подписчиков. Левая панель — здесь, кнопка на профиле — profile.js.
    socket.on('follow:changed', (d) => {
      if (!d || !d.peerId) return;
      if (!d.subscribed && window.tkSubscriptions) window.tkSubscriptions.remove(d.peerId);
      document.dispatchEvent(new CustomEvent('tk:follow:changed', { detail: d }));
    });

    // Ограничение доступа поставили или сняли (utils/profileSignal.js).
    // Страница чужого канала с устаревшим доступом перезагружается: что
    // показать — эфир, запись или отказ — решает сервер. by: 'me' — это я
    // ограничил peerId, 'them' — он меня. Эфиру и записи важно только второе.
    socket.on('access:changed', (d) => {
      if (!d || !d.peerId) return;
      document.dispatchEvent(new CustomEvent('tk:access:changed', { detail: d }));
      const owner = document.querySelector('meta[name="tk-owner"]');
      if (!owner || owner.content !== d.peerId) return;
      if (owner.dataset.scope === 'content' && d.by !== 'them') return;
      const now = d.restricted ? d.by : '';
      if (owner.dataset.access !== now) location.reload();
    });

    // Сервер шлёт presence:update только тем, кто подписался на конкретного
    // человека, — иначе каждое подключение и отключение рассылалось бы всем
    // открытым вкладкам сразу. Подписки живут на сокете, поэтому после обрыва
    // связи их надо назвать заново.
    const presenceSubscribed = new Set();
    window.subscribePresence = function (ids) {
      const fresh = (ids || []).map(String).filter(id => id && !presenceSubscribed.has(id));
      if (!fresh.length) return;
      fresh.forEach(id => presenceSubscribed.add(id));
      socket.emit('presence:subscribe', fresh);
    };
    socket.on('connect', () => {
      if (presenceSubscribed.size) socket.emit('presence:subscribe', Array.from(presenceSubscribed));
    });

    // Поддержка инициализации presence у динамически добавленных элементов (поиск)
    window.addEventListener('presence:init', (e) => {
      const u = e.detail || {};
      if (!u || !u._id) return;
      setPresence(String(u._id), !!u.isOnline, u.lastSeen);
    });

    // ===== Звонки =====
    // Сервер будит собеседника сокетом, после приёма создаёт закрытую комнату
    // Daily и каждому участнику выдаёт свой токен. Вход, переподключение
    // и качество сети — в tk-daily.js; окна звонка — ниже по файлу.
    //
    // Запасной путь — через свой сервер (tk-peer.js). Туда звонок уходит
    // посреди разговора, если Daily застрял, а браузер, у которого застрял,
    // запоминает это на OWN_DAYS: следующие звонки сразу идут своим путём.
    // Через месяц — снова попытка через Daily: сеть могла смениться.
    const closeCall = (callId) => (window.closeCall ? window.closeCall(callId) : false);
    const OWN_KEY = 'tk.call.own';
    const OWN_DAYS = 30;
    const ownPath = () => {
      try { return Date.now() - Number(localStorage.getItem(OWN_KEY) || 0) < OWN_DAYS * 864e5; } catch (e) { return false; }
    };
    window.rememberOwnCallPath = () => {
      try { localStorage.setItem(OWN_KEY, String(Date.now())); } catch (e) {}
    };

    async function startCall(calleeId, type) {
      try {
        const res = await fetch('/api/calls/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ calleeId, type, own: ownPath() }) });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || data.error || 'call_create_failed');
        window.currentCallId = data.callId;
        window.updateOutgoingCallStatus && window.updateOutgoingCallStatus('call.waitingAnswer');
      } catch (e) {
        window.hideOutgoingCall && window.hideOutgoingCall();
        toast(t('call.startFailed', { message: e.message }), 'error');
      }
    }
    window.startAudioCall = (calleeId) => startCall(calleeId, 'audio');
    window.startVideoCall = (calleeId) => startCall(calleeId, 'video');

    socket.on('incoming_call', ({ callId, type, from }) => {
      if (!from) return;
      // Уже разговариваем: второй звонок получает «отклонено», а не окно
      // поверх идущего разговора.
      if (window.currentCallId) { socket.emit('call:decline', { callId }); return; }
      if (window.TKNotify) window.TKNotify.ring({ callId, name: from.displayName, video: type !== 'audio' });
      window.showIncomingCall && window.showIncomingCall({
        userId: from.userId,
        displayName: from.displayName,
        avatarUrl: from.avatarUrl,
        callType: type,
        onAccept: () => { window.currentCallId = callId; socket.emit('call:accept', { callId, own: ownPath() }); },
        onDecline: () => socket.emit('call:decline', { callId })
      });
    });

    // Разговор идёт в одной вкладке с каждой стороны: у звонящего — там, где
    // нажали «позвонить», у собеседника — там, где приняли. Остальные вкладки
    // в комнату на двоих не ломятся.
    // access — { url, token } комнаты Daily или { engine: 'own', ice, offerer }.
    socket.on('call:accepted', (access) => {
      if (access.callId !== window.currentCallId || window._call) return;
      window.startCallMedia && window.startCallMedia(access.callId, access.type, access);
    });

    // Daily застрял у одного из двоих — сервер переводит обоих на свой путь.
    socket.on('call:switch', (access) => {
      if (access.callId === window.currentCallId && window._call) window.switchCallToOwn(access);
    });
    socket.on('call:signal', ({ callId, data }) => {
      if (callId === window.currentCallId && window._call && window._call.signal) window._call.signal(data);
    });

    // Повторный вход после обрыва: свежий токен у сервера, пока звонок жив.
    window.requestCallToken = (callId) => new Promise((resolve, reject) => {
      socket.timeout(10000).emit('call:token', { callId }, (err, res) => {
        if (err) return reject(new Error('timeout')); // сокет ещё не вернулся — попробуем снова
        if (res && res.token) return resolve(res);
        const e = new Error((res && res.error) || 'call_ended');
        e.final = true;
        reject(e);
      });
    });

    socket.on('call:failed', ({ callId }) => {
      if (closeCall(callId)) toast(t('call.serviceDown'), 'error');
    });
    socket.on('call:declined', ({ callId }) => {
      if (callId !== window.currentCallId) return;
      window.currentCallId = null;
      window.updateOutgoingCallStatus && window.updateOutgoingCallStatus('call.declined');
      setTimeout(() => window.hideOutgoingCall && window.hideOutgoingCall(), 1000);
    });
    socket.on('call:canceled', ({ callId }) => closeCall(callId));
    socket.on('call:ended', ({ callId }) => closeCall(callId));
    socket.on('call:timeout', ({ callId }) => {
      if (callId === window.currentCallId) window.updateOutgoingCallStatus && window.updateOutgoingCallStatus('call.noAnswer');
      setTimeout(() => closeCall(callId), 800);
    });

    // Инициализация: подхватить присутствующие на странице id. Счётчики
    // подписчиков живут в тех же комнатах (utils/profileSignal.js).
    const ids = Array.from(document.querySelectorAll('[data-presence-user]'))
      .map(el => el.getAttribute('data-presence-user'))
      .filter(Boolean);
    const counted = Array.from(document.querySelectorAll('[data-count-followers], [data-count-following]'))
      .map(el => el.getAttribute('data-count-followers') || el.getAttribute('data-count-following'));
    window.subscribePresence(counted);
    if (ids.length) {
      window.subscribePresence(ids);
      fetch('/api/presence?ids=' + encodeURIComponent(ids.join(',')))
        .then(r => r.json())
        .then(data => {
          (data.users || []).forEach(u => setPresence(String(u._id), !!u.isOnline, u.lastSeen));
        })
        .catch(() => {});
    }
  } catch (e) {
    console.error('presence client error', e);
  }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPresenceAndCalls);
  } else {
    initPresenceAndCalls();
  }
})();

// Окна звонка: исходящее — у звонящего, входящее — у того, кому звонят.
// После соединения разговор идёт в том же окне.
document.addEventListener('DOMContentLoaded', function(){
  const outgoing = document.getElementById('outgoingCallModal');
  const incoming = document.getElementById('incomingCallModal');
  if (!outgoing || !incoming) return;

  const $ = (id) => document.getElementById(id);
  const outName = $('outgoingName');
  const outType = $('outgoingType');
  const outAvatar = $('outgoingAvatar');
  const outClose = $('outgoingCloseBtn');
  const outCancel = $('outgoingCancelBtn');
  const inName = $('incomingName');
  const inType = $('incomingType');
  const inAvatar = $('incomingAvatar');
  const inClose = $('incomingCloseBtn');
  const inDecline = $('incomingDeclineBtn');
  const inAccept = $('incomingAcceptBtn');

  function side(prefix, short) {
    const voice = $(prefix + 'VoiceBtn');
    return {
      status: $(prefix + 'Status'),
      beacon: $(prefix + 'Status').previousElementSibling,
      timer: $(prefix + 'Timer'),
      net: $(prefix + 'Net'),
      stage: $(prefix + 'Videos'),
      voice,
      actions: voice.parentElement,
      remoteVideo: $(short + 'RemoteVideo'),
      localVideo: $(short + 'LocalVideo'),
      remoteAudio: $(short + 'RemoteAudio'),
    };
  }
  const OUT = side('outgoing', 'out');
  const IN = side('incoming', 'in');

  function renderAvatar(el, url, name){
    if (!el) return;
    el.innerHTML = '';
    if (url) {
      el.innerHTML = '<img src="' + escapeHtml(url) + '" alt="">';
    } else {
      el.textContent = name ? name.charAt(0).toUpperCase() : '?';
    }
  }

  // Точка у статуса: у входящего до ответа — «звонит», в разговоре — зелёная,
  // при обрыве — снова тревожная. Раньше у принявшего она оставалась красной
  // и после соединения.
  function setBeacon(s, ok) {
    s.beacon.classList.toggle('tk-call__beacon--ok', ok);
    s.beacon.classList.toggle('tk-call__beacon--ring', !ok);
  }

  function resetSide(s) {
    setBeacon(s, s === OUT);
    s.timer.textContent = '00:00';
    s.timer.classList.add('hidden');
    s.net.classList.add('hidden');
    s.stage.classList.add('hidden');
    s.voice.classList.add('hidden');
    s.video = false;
    s.remoteOn = false;
  }

  // Видео в разговоре: своя камера (s.video) и картинка собеседника. Сцена
  // видна, если есть хоть одна из них: в аудиозвонке собеседник включил
  // камеру — его видно и без своей. Кнопка рядом с «Завершить» переключает
  // свою: «Только голос» ↔ «Включить видео».
  function paintVideo(s) {
    s.stage.classList.toggle('hidden', !(s.video || s.remoteOn));
    tkText(s.voice, s.video ? 'call.voiceOnly' : 'call.videoOn');
  }

  // Окно переходит в разговор: «Отменить» и «Принять» становятся «Завершить»,
  // рядом встаёт кнопка видео — и у видео-, и у аудиозвонка.
  function goLive(s, isVideo) {
    s.video = isVideo;
    s.stage.classList.add('tk-call__stage--empty', 'tk-call__stage--nolocal');
    s.voice.classList.remove('hidden');
    s.actions.classList.add('tk-call__actions--pair');
    paintVideo(s);
    if (s === OUT) {
      tkText(outCancel, 'call.end');
      outCancel.classList.remove('tk-btn--danger');
      outCancel.classList.add('tk-btn--mute');
    } else {
      inAccept.disabled = false;
      tkText(inAccept, 'call.end');
      inAccept.classList.remove('tk-btn--ok');
      inAccept.classList.add('tk-btn--mute');
      inAccept.onclick = endCallLocal;
      inDecline.classList.add('hidden');
      inClose.classList.add('hidden');
    }
  }

  function startTimer(s) {
    let sec = 0;
    s.timer.classList.remove('hidden');
    clearInterval(window._callTick);
    window._callTick = setInterval(() => {
      sec++;
      s.timer.textContent = String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
    }, 1000);
  }

  window.startCallMedia = function (callId, type, first) {
    const s = incoming.classList.contains('hidden') ? OUT : IN;
    const isVideo = type === 'video';
    let firstAccess = first;
    let state = 'connecting';
    let peers = 0;
    let hadPeer = false;
    let started = false;

    function paint() {
      setBeacon(s, state !== 'reconnecting');
      if (state === 'reconnecting') tkText(s.status, 'call.reconnecting');
      else if (state === 'connecting') tkText(s.status, 'call.connectingShort');
      else if (peers) tkText(s.status, 'call.connected');
      else tkText(s.status, hadPeer ? 'call.peerReconnecting' : 'call.waitingPeer');
    }

    goLive(s, isVideo);
    paint();
    // Окну всё равно, каким путём идёт разговор: и Daily, и свой путь
    // сообщают о дорожках, собеседнике, состоянии и сети одинаково.
    const view = {
      onTrack: (track, p, on) => {
        if (track.kind === 'video') {
          TKDaily.attach(p.local ? s.localVideo : s.remoteVideo, on && track);
          s.stage.classList.toggle(p.local ? 'tk-call__stage--nolocal' : 'tk-call__stage--empty', !on);
          if (!p.local) { s.remoteOn = on; paintVideo(s); }
        }
        else if (!p.local) TKDaily.attach(s.remoteAudio, on && track);
      },
      onPeers: (n) => {
        peers = n;
        if (n) hadPeer = true;
        paint();
      },
      onState: (st) => {
        if (st === 'ended') {
          endCallLocal();
          toast(t('call.lost'), 'error');
          return;
        }
        state = st;
        // Свой объект звонка пересоздаётся, и о пропаже дорожек старый уже не
        // сообщает: без этого сцена оставалась чёрной, а в углу — пустая рамка.
        if (st === 'reconnecting') s.stage.classList.add('tk-call__stage--empty', 'tk-call__stage--nolocal');
        if (st === 'live' && !started) { started = true; startTimer(s); }
        paint();
      },
      onMediaError: () => toast(t('call.mediaDenied'), 'error'),
      onNetwork: (n) => {
        s.net.dataset.net = n;
        const level = t('call.net.' + n) || n;
        s.net.setAttribute('aria-label', t('call.networkIs', { level }));
        s.net.title = s.net.getAttribute('aria-label');
        s.net.classList.remove('hidden');
      }
    };
    const diag = isVideo ? 'видеозвонок' : 'аудиозвонок';

    const viaDaily = () => TKDaily.connect(Object.assign({
      send: true,
      video: s.video,
      diag,
      access: () => {
        if (!firstAccess) return window.requestCallToken(callId);
        const a = firstAccess;
        firstAccess = null;
        return Promise.resolve(a);
      },
      // Пороги ухода на свой путь: вход в комнату у Daily обычно 2–4 с,
      // дорожки собеседника — 1–2 с после его входа.
      joinMs: 10000,
      mediaMs: 5000,
      onStuck: (reason) => window.callSocket.emit('call:fallback', { callId, reason }),
    }, view));

    const viaOwn = (access) => TKPeer.connect(Object.assign({
      video: s.video,
      diag,
      ice: access.ice,
      offerer: access.offerer,
      signal: (data) => window.callSocket.emit('call:signal', { callId, data }),
    }, view));

    window._call = first.engine === 'own' ? viaOwn(first) : viaDaily();

    // Переход посреди звонка: Daily — прочь, сцена — пустая до первых
    // дорожек своего пути. Запоминает путь только тот, у кого Daily застрял:
    // у собеседника он, возможно, работает.
    window.switchCallToOwn = (access) => {
      const stuck = window._call.stuck;
      window._call.leave();
      [s.remoteVideo, s.localVideo, s.remoteAudio].forEach((el) => TKDaily.attach(el, null));
      s.stage.classList.add('tk-call__stage--empty', 'tk-call__stage--nolocal');
      s.remoteOn = false;
      paintVideo(s);
      if (stuck) window.rememberOwnCallPath();
      window._call = viaOwn(access);
    };
  };

  [OUT, IN].forEach((s) => s.voice.addEventListener('click', () => {
    if (!window._call) return;
    s.video = !s.video;
    window._call.setVideo(s.video);
    // Только голос — чужое видео тоже не принимается (tk-daily.js).
    if (!s.video) s.remoteOn = false;
    paintVideo(s);
  }));

  // Своя картинка в углу: пальцем или мышью двигается, двумя пальцами или
  // колесом мыши меняет размер (пропорции те же). Не выходит за сцену и не
  // заезжает на кнопки, которые на телефоне лежат поверх картинки.
  [OUT, IN].forEach((s) => {
    const el = s.localVideo;
    const box = el.parentElement;
    const MIN = 72;
    const points = new Map();
    let from = null;

    function begin() {
      const r = el.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      const p = [...points.values()];
      from = {
        left: r.left - b.left, top: r.top - b.top, w: r.width, h: r.height,
        p, dist: p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0,
      };
    }

    function place(left, top, w) {
      const b = box.getBoundingClientRect();
      const floor = Math.min(b.bottom, s.actions.getBoundingClientRect().top - 8) - b.top;
      const width = Math.max(MIN, Math.min(w, b.width * 0.7, (floor * from.w) / from.h));
      const height = (width * from.h) / from.w;
      const cx = left + w / 2;
      const cy = top + (w * from.h) / from.w / 2;
      Object.assign(el.style, {
        width: width + 'px',
        height: height + 'px',
        left: Math.max(0, Math.min(cx - width / 2, b.width - width)) + 'px',
        top: Math.max(0, Math.min(cy - height / 2, floor - height)) + 'px',
        right: 'auto',
        bottom: 'auto',
      });
    }

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      begin();
    });
    el.addEventListener('pointermove', (e) => {
      if (!points.has(e.pointerId)) return;
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const p = [...points.values()];
      if (p.length > 1 && from.dist) {
        const k = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) / from.dist;
        const dx = (p[0].x + p[1].x - from.p[0].x - from.p[1].x) / 2;
        const dy = (p[0].y + p[1].y - from.p[0].y - from.p[1].y) / 2;
        const w = from.w * k;
        place(from.left + dx + (from.w - w) / 2, from.top + dy + (from.h - (w * from.h) / from.w) / 2, w);
      } else {
        place(from.left + p[0].x - from.p[0].x, from.top + p[0].y - from.p[0].y, from.w);
      }
    });
    const end = (e) => { points.delete(e.pointerId); if (points.size) begin(); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      begin();
      const w = from.w * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
      place(from.left + (from.w - w) / 2, from.top + (from.h - (w * from.h) / from.w) / 2, w);
    }, { passive: false });
  });
  // Поворот телефона или новый размер окна: картинка возвращается в угол,
  // иначе могла бы оказаться за краем сцены.
  window.addEventListener('resize', () => [OUT, IN].forEach((s) => s.localVideo.removeAttribute('style')));

  function stopMedia() {
    if (window._call) { window._call.leave(); window._call = null; }
    clearInterval(window._callTick);
    [OUT, IN].forEach((s) => {
      [s.remoteVideo, s.localVideo, s.remoteAudio].forEach((el) => TKDaily.attach(el, null));
      // Своя картинка — снова в углу к следующему звонку.
      s.localVideo.removeAttribute('style');
    });
  }

  window.showOutgoingCall = function(opts){
    const displayName = opts && opts.displayName || t('call.user');
    const callType = opts && opts.callType || 'video';
    outName.textContent = displayName;
    tkText(outType, callType === 'audio' ? 'call.outgoingAudio' : 'call.outgoingVideo');
    tkText(OUT.status, 'call.connecting');
    renderAvatar(outAvatar, opts && opts.avatarUrl || '', displayName);
    resetSide(OUT);
    OUT.actions.classList.remove('tk-call__actions--pair');
    tkText(outCancel, 'call.cancel');
    outCancel.classList.remove('tk-btn--mute');
    outCancel.classList.add('tk-btn--danger');
    outgoing.classList.remove('hidden');
  };
  window.updateOutgoingCallStatus = function(key){ tkText(OUT.status, key); };
  window.hideOutgoingCall = function(){ outgoing.classList.add('hidden'); };

  function hideIncoming(){
    if (window.TKNotify) window.TKNotify.stopRing();
    incoming.classList.add('hidden');
    inAccept.onclick = null; inDecline.onclick = null; inClose.onclick = null;
  }
  window.hideIncomingCall = hideIncoming;

  window.showIncomingCall = function(opts){
    const displayName = opts && opts.displayName || t('call.user');
    const callType = opts && opts.callType || 'video';
    const onAccept = opts && opts.onAccept;
    const onDecline = opts && opts.onDecline;
    inName.textContent = displayName;
    tkText(inType, callType === 'audio' ? 'call.incomingAudio' : 'call.incomingVideo');
    renderAvatar(inAvatar, opts && opts.avatarUrl || '', displayName);
    resetSide(IN);
    tkText(IN.status, 'call.ringing');
    IN.actions.classList.add('tk-call__actions--pair');
    inAccept.disabled = false;
    tkText(inAccept, 'call.accept');
    inAccept.classList.remove('tk-btn--mute');
    inAccept.classList.add('tk-btn--ok');
    inDecline.disabled = false;
    inDecline.classList.remove('hidden');
    inClose.disabled = false;
    inClose.classList.remove('hidden');
    incoming.classList.remove('hidden');
    inAccept.onclick = function(){
      if (window.TKNotify) window.TKNotify.stopRing();
      tkText(IN.status, 'call.connectingShort');
      inAccept.disabled = true; inDecline.disabled = true; inClose.disabled = true;
      onAccept && onAccept();
      // окно не закрываем: ждём call:accepted
    };
    inDecline.onclick = function(){ onDecline && onDecline(); hideIncoming(); };
    inClose.onclick = function(){ onDecline && onDecline(); hideIncoming(); };
  };

  function endCallLocal(){
    if (window.callSocket && window.currentCallId) window.callSocket.emit('call:end', { callId: window.currentCallId });
    window.currentCallId = null;
    stopMedia();
    hideIncoming();
    window.hideOutgoingCall();
  }
  window.endCallLocal = endCallLocal;

  // Звонок завершён, отменён или не состоялся. Чужой callId не трогает
  // идущий разговор; у звонка, который ещё только звонит, callId пуст.
  window.closeCall = function (callId) {
    if (window.currentCallId && callId !== window.currentCallId) return false;
    window.currentCallId = null;
    stopMedia();
    hideIncoming();
    window.hideOutgoingCall();
    return true;
  };

  // Крестик и нижняя кнопка исходящего окна: до ответа — отмена, в разговоре —
  // завершение. Раньше крестик во время разговора прятал окно, а звонок
  // продолжался невидимым.
  function outgoingButton() {
    if (window._call) return endCallLocal();
    if (window.callSocket && window.currentCallId) window.callSocket.emit('call:cancel', { callId: window.currentCallId });
    window.currentCallId = null;
    window.hideOutgoingCall();
  }
  outClose.addEventListener('click', outgoingButton);
  outCancel.addEventListener('click', outgoingButton);
});
