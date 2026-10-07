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

// Галочка официального аккаунта после имени — та же, что рисуют шаблоны
// (partials/official.ejs, стиль .tk-official в tk.css). Для строк, которые
// собирают скрипты: поиск, переписка, комментарии.
var tkOfficial = function () {
  var label = escapeHtml(t('common.official'));
  return '<span class="tk-official" role="img" title="' + label + '" aria-label="' + label + '" data-i18n-title="common.official" data-i18n-aria="common.official"></span>';
};

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

// Фильтры-формы с data-autosubmit («Все авторы», 04.10): со скриптом
// применяются сразу при смене выпадашки. Без скрипта форма уходит кнопкой
// «Показать» — она в noscript, адрес тот же.
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('form[data-autosubmit]').forEach((form) => {
    form.addEventListener('change', (e) => {
      if (e.target.matches('select')) form.requestSubmit();
    });
  });
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
// Сообщение для следующей страницы: действие кончается переходом, и тост
// уходил вместе со старой страницей, не успев показаться (запись эфира
// после «Завершить», NOTICES.md). Ключ словаря — в sessionStorage, новая
// страница показывает его один раз.
window.tkNoticeNext = function (key, kind) {
  try { sessionStorage.setItem('tk:notice', JSON.stringify({ key, kind })); } catch (e) { /* приватный режим */ }
};
document.addEventListener('DOMContentLoaded', () => {
  let n = null;
  try { n = JSON.parse(sessionStorage.getItem('tk:notice') || 'null'); sessionStorage.removeItem('tk:notice'); } catch (e) { /* нет хранилища */ }
  if (n && n.key) toast(t(n.key), n.kind || 'ok');
});

// То же число — на значок приложения на экране «Домой» и в доке (пуши,
// этап 3). Закрытому приложению его ставит пуш (public/sw.js), открытое
// держит здесь. Где значков нет, вызов отказывает — молча.
function appBadge(n) {
  if (!navigator.setAppBadge) return;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}
// Страница пришла с сервера с точными числами — значок по ним; гость
// (вышел из аккаунта) — значок гасим: чужие числа на нём не нужны.
document.addEventListener('DOMContentLoaded', () => {
  if (document.querySelector('[data-chat-badge]')) window.tkChatBadge({});
  else if (!(window.TK && TK.userId)) appBadge(0);
});

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
  appBadge(m + c);
  // Те же числа порознь — у пунктов левой панели и у вкладки «Звонки».
  const put = (sel, n) => document.querySelectorAll(sel).forEach((el) => {
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.toggle('hidden', !n);
  });
  put('[data-chat-messages]', m);
  put('[data-missed-calls]', c);
  // Точное «ничего непрочитанного» — уведомлениям в шторке делать нечего.
  if (part.messages === 0) window.tkClearPush((tag) => /^(msg|group)-/.test(tag) && !/^group-call-/.test(tag));
  if (part.calls === 0) window.tkClearPush((tag) => /^(call|group-call)-/.test(tag));
};

// Системные уведомления о том, что уже прочитано, — из шторки (30.09).
// Заказчик на Android: пришёл пуш, зашёл с иконки на домашнем экране,
// прочитал — а уведомление висит, и на иконке приложения по-прежнему
// точка: Android рисует её, пока уведомление не убрано. Само оно уходит,
// только если нажать на него. Метки — utils/push.js и вызывающие:
// msg-<собеседник>, group-<группа>, call-<кто звонил>, group-call-<группа>.
window.tkClearPush = function (match) {
  if (!navigator.serviceWorker) return;
  navigator.serviceWorker.getRegistration()
    .then((reg) => (reg ? reg.getNotifications() : []))
    .then((list) => list.forEach((n) => { if (match(n.tag || '')) n.close(); }))
    .catch(() => {});
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
        const response = await tkFetch('/api/notifications');
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
            const isReply = n.type === 'reply';
            // К отметке о встрече присоединились (routes/meetups.js): ведёт
            // на её строку на странице заведения, текстом — заведение и день.
            const isMeetup = n.type === 'meetup';
            // Звонок группе (utils/groupPush.js) ведёт в группу, в content —
            // её название.
            const href = isCall ? (n.link || '/chatsPage?tab=calls')
              : isComment || isReply || isLive || isFollow || isMeetup ? (n.link || '/')
              : '/chatsPage?peer=' + encodeURIComponent(sender._id || '');
            const title = isCall && n.link ? t('modal.notifications.missedGroupCall', { name, group: n.content || '' })
              : isCall ? t('modal.notifications.missedCall', { name })
              : isComment ? t('modal.notifications.comment', { name })
              : isReply ? t('modal.notifications.reply', { name })
              : isLive ? t('modal.notifications.live', { name })
              : isFollow ? t('modal.notifications.follow', { name })
              : isMeetup ? t('modal.notifications.meetup', { name })
              : t('modal.notifications.from') + ' ' + name;
            const text = isCall || isFollow ? '' : isLive || isMeetup ? (n.content || '') : (n.content || t('modal.notifications.fallback'));
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
          tkFetch('/api/notifications/read', { method: 'PUT' }).catch(() => {});
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
        const r = await tkFetch('/api/notifications', { method: 'DELETE' });
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
// запрос к /api/search, ответ группами (люди, эфиры, записи, видео,
// заведения).
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
    { key: 'videos',     i18n: 'search.videos',     href: (x) => '/video/' + encodeURIComponent(x._id) },
    { key: 'venues',     i18n: 'search.venues',     href: (x) => '/venue/' + encodeURIComponent(x._id) }
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
      // Нашёлся по описанию — куском описания с выделенным совпадением,
      // иначе непонятно, почему он здесь (utils/search.js, bioMatch).
      meta = item.about
        ? { html: `${escapeHtml(item.about[0])}<mark class="tk-hit">${escapeHtml(item.about[1])}</mark>${escapeHtml(item.about[2])}` }
        : `${t('authors.followers')}: ${item.followersCount}`;
    } else if (key === 'streams') {
      media = shot(item.thumbnail);
      name = item.title;
      meta = `${item.author.displayName} · ${item.viewers} ${t('search.viewers')}`;
    } else if (key === 'recordings' || key === 'videos') {
      media = shot(item.thumb);
      name = item.title || t('video.untitled', { date: tkDate(item.createdAt, { day: 'numeric', month: 'long' }) });
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
          <span class="tk-found__name">${escapeHtml(name)}${key === 'people' && item.official ? tkOfficial() : ''}</span>
          <span class="tk-found__meta${meta.html ? ' tk-found__about' : ''}">${meta.html || escapeHtml(meta)}</span>
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
      tkFetch('/api/presence?ids=' + encodeURIComponent(ids.join(',')))
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
        tkFetch('/api/search?q=' + encodeURIComponent(q), { signal: own.signal })
          .then((r) => { if (!r.ok) throw new Error(TKNet.explain(r)); return r.json(); })
          .then((data) => render(box, data))
          .catch((e) => { if (e.name !== 'AbortError' && own === ctrl) failed(e); });
      }, 200);
    });

    // Не нашлось — одно, не загрузилось — другое (NOTICES.md, «Остальное»):
    // раньше сбой уходил в консоль, а выпадашка оставалась пустой, и это
    // читалось как «ничего не найдено». Причина — словами TKNet.
    const failed = (e) => {
      box.innerHTML = `<div class="tk-found__empty">
           <p class="tk-found__name" data-i18n="app.searchFailed">${escapeHtml(t('app.searchFailed'))}</p>
           <p class="tk-note">${escapeHtml(e.message || '')}</p>
         </div>
         <button type="button" class="tk-found__all" data-search-retry data-i18n="common.retry">${escapeHtml(t('common.retry'))}</button>`;
      box.classList.remove('hidden');
    };
    box.addEventListener('click', (e) => {
      if (e.target.closest('[data-search-retry]')) input.dispatchEvent(new Event('input'));
    });

    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    // Вернулись «назад» к странице из кэша браузера — в поле остался
    // прошлый запрос, и новый приходилось набирать поверх. Каждый поиск
    // начинается с пустого поля.
    window.addEventListener('pageshow', (e) => {
      if (!e.persisted) return;
      input.value = '';
      hide();
    });
    // Выпадашка — внутри формы: щелчок по ссылке не должен её отправлять.
    box.addEventListener('mousedown', (e) => e.stopPropagation());
    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !box.contains(e.target)) hide();
    });
  }

  attach(document.getElementById('searchInput'), document.getElementById('searchResults'));

  // Поле на странице результатов показывает, что искали, — но новый запрос
  // набирают с чистого: фокус выделяет прежний, и первая же буква его заменяет.
  const pageField = document.querySelector('.tk-search__field');
  if (pageField) pageField.addEventListener('focus', () => pageField.select());
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
    // away — вкладка не на экране: свёрнута, спрятана, экран заблокирован.
    // По нему сервер решает, будить ли телефон пушем (utils/push.js,
    // onScreen). Функцией, а не объектом: зовётся на каждом подключении.
    const away = () => document.visibilityState !== 'visible';
    const socket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      auth: (cb) => cb({ away: away() }),
    });
    window.callSocket = socket;
    console.log('[client] socket init');
    // Обрыв дольше пяти секунд — полоса «нет связи с сервером» (tk-net.js):
    // переписка, счётчики и звонки без сокета молча стоят, и человек должен
    // это знать.
    socket.on('connect', () => {
      console.log('[client] socket connected id=', socket.id);
      window.TKNet.socket(true, '', socket.io.engine && socket.io.engine.transport && socket.io.engine.transport.name);
    });
    socket.on('connect_error', (err) => { console.warn('[client] socket connect_error', err.message); window.TKNet.socket(false, 'error: ' + err.message); }); // сеть пропала — переподключится сам
    socket.on('disconnect', (reason) => { console.log('[client] socket disconnected', reason); window.TKNet.socket(false, reason); });

    // Переписка: события сокета уходят в document как tk:<событие>, их слушает
    // страница переписки (chats.js). Колокольчик зажигается на любой странице.
    ['message:new', 'message:failed', 'message:expired', 'message:limit', 'message:read', 'message:delivered', 'message:deleted', 'conversation:deleted',
      'group:message', 'group:read', 'group:updated', 'group:removed',
      'call:logged', 'call:deleted', 'live:changed', 'author:live', 'recording:status'].forEach((name) => {
      socket.on(name, (detail) => document.dispatchEvent(new CustomEvent('tk:' + name, { detail })));
    });
    socket.on('notification:new', () => window.setNotificationDot(true));
    // Удалили непрочитанное — сервер присылает точное число (messages.js, unreadAfter).
    ['message:deleted', 'conversation:deleted'].forEach((name) => {
      socket.on(name, (d) => { if (d && typeof d.unreadMessages === 'number') window.tkChatBadge({ messages: d.unreadMessages }); });
    });
    // Входящее сообщение — +1 у иконки переписки. Открытый диалог тут же
    // его читает, и chats.js ставит точное число из ответа сервера.
    // Сообщение группы (utils/groups.js): чужое — +1 у иконки; звук
    // и системное уведомление — если у группы не выключен звук.
    socket.on('group:message', (d) => {
      if (!d || !d.message || d.message.system || d.message.sender === (window.TK && window.TK.userId)) return;
      window.tkChatBadge({ addMessages: 1 });
      if (!d.muted && window.TKNotify) window.TKNotify.groupMessage(d);
    });
    // Удаление в группе приходит без точных чисел — их у каждого свои.
    socket.on('message:deleted', (d) => { if (d && d.groupId) refreshCounters(); });
    socket.on('message:new', (d) => {
      // Заявка на переписку (utils/privacy.js) — молча: ни счётчика, ни звука.
      if (d && d.request) return;
      if (d && d.message && d.peer && d.message.sender === d.peer.id) window.tkChatBadge({ addMessages: 1 });
      // Звук и системное уведомление — если включены в настройках (tk-notify.js).
      if (window.TKNotify) window.TKNotify.message(d);
    });
    // Пропущенный звонок — счётчик у иконки переписки в шапке, у пункта
    // «Звонки» в панели и у вкладки. Открытая вкладка гасит его сама (chats.js).
    socket.on('call:missed', () => window.tkChatBadge({ addCalls: 1 }));
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
      tkFetch('/api/badge', { headers: { Accept: 'application/json' } })
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
      tkFetch('/api/presence?ids=' + encodeURIComponent(ids.slice(0, 200).join(',')))
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
    //
    // Страница, открытая кнопкой «назад», может прийти не с сервера, а из
    // дискового кэша браузера — со значками и списками на момент первого
    // показа (30.09: прочитанное снова «непрочитано», пока не обновишь).
    // Такой странице полная сверка нужна сразу, на первом же подключении.
    // Из bfcache она возвращается иначе — pageshow с persisted, ниже.
    const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    const fromHistory = !!nav && nav.type === 'back_forward';
    let connectedOnce = fromHistory;
    // Свежая страница — числа от сервера точные: прочитанное где-то ещё
    // (на компьютере, в другой вкладке) — уведомлениям в шторке делать нечего.
    const chatBadge = document.querySelector('[data-chat-badge]');
    if (chatBadge && !fromHistory) {
      window.tkChatBadge({ messages: Number(chatBadge.dataset.messages) || 0, calls: Number(chatBadge.dataset.calls) || 0 });
    }
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
    // Свернули приложение — сказать серверу сразу, пока айфон не заморозил
    // страницу: иначе до тайм-аута пинга он считал человека на экране,
    // и пуш о звонке не уходил вовсе, а о сообщении — через полминуты.
    // Без связи не копим: при подключении состояние едет в рукопожатии.
    function tellAway() {
      if (socket.connected) socket.emit('tk:away', away());
    }
    document.addEventListener('visibilitychange', tellAway);
    window.addEventListener('pagehide', () => { if (socket.connected) socket.emit('tk:away', true); });
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
        const data = await TKNet.json('/api/calls/create', { method: 'POST', body: { calleeId, type, own: ownPath() } });
        if (!data.success) throw new Error(data.message || data.error || 'call_create_failed');
        window.currentCallId = data.callId;
        window.updateOutgoingCallStatus && window.updateOutgoingCallStatus('call.waitingAnswer');
      } catch (e) {
        window.hideOutgoingCall && window.hideOutgoingCall();
        toast(t('call.startFailed', { message: e.message }), 'error');
      }
    }
    // Звонок группе из переписки (routes/groups.js): звонит всем, кто в сети,
    // разговор — сеткой до четверых. Окно — то же, что у звонка человеку.
    window.startGroupCall = async (g, type) => {
      window.showOutgoingCall({ displayName: g.title, avatarUrl: g.url || '', callType: type });
      try {
        const data = await TKNet.json('/api/groups/' + encodeURIComponent(g.id) + '/call', { method: 'POST', body: { type } });
        window.currentCallId = data.callId;
        window.updateOutgoingCallStatus && window.updateOutgoingCallStatus('call.waitingAnswer');
      } catch (e) {
        window.hideOutgoingCall && window.hideOutgoingCall();
        toast(e.message, 'error');
      }
    };
    window.startAudioCall = (calleeId) => startCall(calleeId, 'audio');
    window.startVideoCall = (calleeId) => startCall(calleeId, 'video');

    socket.on('incoming_call', ({ callId, type, from, group, peers, chat }) => {
      if (!from) return;
      // Уже разговариваем: второй звонок получает «отклонено», а не окно
      // поверх идущего разговора.
      if (window.currentCallId) { socket.emit('call:decline', { callId }); return; }
      if (window.TKNotify) window.TKNotify.ring({ callId, name: from.displayName, video: type !== 'audio' });
      window.showIncomingCall && window.showIncomingCall({
        userId: from.userId,
        // Звонок группе — её название рядом с тем, кто звонит.
        displayName: chat ? chat.title + ' · ' + from.displayName : from.displayName,
        avatarUrl: from.avatarUrl,
        callType: type,
        // Приглашение в идущий разговор: показываем, кто там уже есть, —
        // до того, как человек возьмёт трубку.
        group: group === true,
        chat: !!chat,
        peers: peers || [],
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

    // Сокет вернулся, а звонок идёт: события, ушедшие в мёртвый сокет,
    // пропали (sockets/index.js, call:sync). Не дошло «принят» — входим
    // в разговор сейчас; не дошло «на свой путь» — переходим; звонка уже
    // нет — закрываем окно и говорим об этом, а не висим на «Звоним…».
    socket.on('connect', () => {
      const callId = window.currentCallId;
      if (!callId) return;
      socket.timeout(10000).emit('call:sync', { callId }, (err, res) => {
        if (err || !res || callId !== window.currentCallId) return;
        if (res.ended) { if (closeCall(callId)) toast(t('call.lost'), 'error'); return; }
        if (!res.callId) return;
        if (!window._call) window.startCallMedia(callId, res.type, res);
        else if (res.engine === 'own' && !window._call.signal) window.switchCallToOwn(res);
      });
    });
    socket.on('call:signal', ({ callId, from, data }) => {
      if (callId === window.currentCallId && window._call && window._call.signal) window._call.signal(from, data);
    });

    // ── Групповой разговор ──
    // Вошёл третий или четвёртый: сцена переходит на сетку плиток, а сетка
    // соединений (tk-peer.js, room) получает ещё одно соединение.
    socket.on('call:peer:join', (data) => {
      if (data.callId === window.currentCallId && window.callGroupJoin) window.callGroupJoin(data);
    });
    socket.on('call:peer:left', ({ callId, userId }) => {
      if (callId === window.currentCallId && window.callGroupLeft) window.callGroupLeft(userId);
    });
    socket.on('call:invite:declined', ({ userId, timeout }) => {
      const name = (window.tkCallNames && window.tkCallNames[userId]) || t('call.user');
      toast(t(timeout ? 'call.inviteNoAnswer' : 'call.inviteDeclined', { name }), 'error');
    });
    socket.on('call:invite:failed', ({ reason }) => {
      toast(t('call.inviteFailed.' + reason) || t('call.inviteFailed.unavailable'), 'error');
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

    // Ответил на звонок группе, а в разговоре уже четверо.
    socket.on('call:full', ({ callId }) => {
      if (closeCall(callId)) toast(t('call.full'), 'error');
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
      tkFetch('/api/presence?ids=' + encodeURIComponent(ids.join(',')))
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
    const stage = $(prefix + 'Videos');
    return {
      status: $(prefix + 'Status'),
      beacon: $(prefix + 'Status').previousElementSibling,
      timer: $(prefix + 'Timer'),
      net: $(prefix + 'Net'),
      level: $(prefix + 'Level'),
      stage,
      voice,
      add: $(prefix + 'AddBtn'),
      actions: voice.parentElement,
      // Разговор на двоих — картинка в картинке, на троих и четверых —
      // сетка плиток. Обе живут в одной сцене, видна всегда одна.
      pip: stage.querySelector('.pip-call-container'),
      grid: $(prefix + 'Grid'),
      remoteVideo: $(short + 'RemoteVideo'),
      localVideo: $(short + 'LocalVideo'),
      remoteAudio: $(short + 'RemoteAudio'),
      // Кнопки разговора и переписка в окне (23.09).
      card: stage.closest('.tk-modal__card'),
      tools: $(prefix + 'Tools'),
      micBtn: $(prefix + 'MicBtn'),
      camBtn: $(prefix + 'CamBtn'),
      spkBtn: $(prefix + 'SpeakerBtn'),
      chatBtn: $(prefix + 'ChatBtn'),
      chatCount: $(prefix + 'ChatBtn').querySelector('.tk-call__count'),
      chat: $(prefix + 'Chat'),
      chatFeed: $(prefix + 'ChatFeed'),
      chatForm: $(prefix + 'ChatForm'),
      chatInput: $(prefix + 'ChatInput'),
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
    s.level.classList.add('hidden');
    s.stage.classList.add('hidden');
    s.voice.classList.add('hidden');
    s.add.classList.add('hidden');
    // Сетка — только у группового разговора: к новому звонку её нет.
    s.grid.hidden = true;
    s.grid.innerHTML = '';
    s.pip.hidden = false;
    s.group = false;
    s.video = false;
    s.remoteOn = false;
    // Кнопки разговора: до соединения их нет, и каждый звонок начинается
    // с включённого микрофона, включённой камеры и громкой связи.
    s.tools.hidden = true;
    s.chatBtn.hidden = false;
    s.micOn = true;
    s.camOn = true;
    s.loud = true;
    s.chatLoaded = false;
    s.chatBusy = false;
    s.chatUnread = 0;
    s.chatFeed.innerHTML = '';
    showChat(s, false);
  }

  // Видео в разговоре: своя камера (s.video) и картинка собеседника. Сцена
  // видна, если есть хоть одна из них: в аудиозвонке собеседник включил
  // камеру — его видно и без своей. Кнопка рядом с «Завершить» переключает
  // свою: «Только голос» ↔ «Включить видео».
  function paintVideo(s) {
    // В групповом разговоре сцена нужна всегда: плитки показывают, кто в нём,
    // даже когда камеры у всех выключены.
    s.stage.classList.toggle('hidden', !(s.group || s.video || s.remoteOn));
    tkText(s.voice, s.video ? 'call.voiceOnly' : 'call.videoOn');
    // Своя камера выключается кнопкой только тогда, когда она вообще идёт:
    // в голосовом разговоре выключать нечего.
    s.camBtn.hidden = !s.video;
  }

  // Окно переходит в разговор: «Отменить» и «Принять» становятся «Завершить»,
  // рядом встаёт кнопка видео — и у видео-, и у аудиозвонка.
  function goLive(s, isVideo) {
    s.video = isVideo;
    s.stage.classList.add('tk-call__stage--empty', 'tk-call__stage--nolocal');
    s.voice.classList.remove('hidden');
    // Позвать третьего можно из любого идущего разговора — и из видео,
    // и из голосового.
    s.add.classList.remove('hidden');
    s.actions.classList.remove('tk-call__actions--pair');
    s.actions.classList.add('tk-call__actions--live');
    // Ряд кнопок разговора: микрофон всегда, камера — при видео (paintVideo),
    // динамик — только там, где браузер даёт им управлять.
    s.tools.hidden = false;
    s.spkBtn.hidden = !canRoute(s);
    paintTool(s.micBtn, !s.micOn, 'call.micOn', 'call.micOff');
    paintTool(s.camBtn, !s.camOn, 'call.camOn', 'call.camOff');
    paintTool(s.spkBtn, s.loud, 'call.speakerOff', 'call.speakerOn');
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

  // ── Сетка группового разговора ──
  // По плитке на участника, до четырёх (потолок — sockets/index.js,
  // GROUP_MAX). Нет картинки — на плитке буква и имя: в разговоре голосом
  // сетка тоже нужна, чтобы видеть, кто в нём.
  function tileOf(s, userId, card) {
    let box = s.grid.querySelector('[data-user="' + CSS.escape(String(userId)) + '"]');
    if (box) return box;
    box = document.createElement('div');
    // Пока картинки нет — буква и имя; видео появится, класс уйдёт.
    box.className = 'tk-call__tile is-dark';
    box.setAttribute('data-user', userId);
    const name = (card && card.displayName) || '';
    box.innerHTML =
      '<video autoplay playsinline' + (userId === 'me' ? ' muted' : '') + '></video>' +
      '<audio autoplay playsinline></audio>' +
      '<span class="tk-call__tile-ava">' + escapeHtml((name || '?').charAt(0).toUpperCase()) + '</span>' +
      '<span class="tk-wm" aria-hidden="true"></span>' +
      '<span class="tk-call__tile-name">' + escapeHtml(userId === 'me' ? t('call.you') : name) + '</span>';
    s.grid.appendChild(box);
    countTiles(s);
    return box;
  }

  function countTiles(s) {
    s.grid.setAttribute('data-n', String(s.grid.children.length));
  }

  function dropTile(s, userId) {
    const box = s.grid.querySelector('[data-user="' + CSS.escape(String(userId)) + '"]');
    if (!box) return;
    TKDaily.attach(box.querySelector('video'), null);
    TKDaily.attach(box.querySelector('audio'), null);
    box.remove();
    countTiles(s);
  }

  window.startCallMedia = function (callId, type, first) {
    const s = incoming.classList.contains('hidden') ? OUT : IN;
    const isVideo = type === 'video';
    let firstAccess = first;
    let state = 'connecting';
    let peers = 0;
    let hadPeer = false;
    let started = false;
    // Разговор стал групповым: сцена переходит на сетку и обратно уже
    // не возвращается — даже когда останутся двое, плитки понятнее.
    let group = false;
    const cards = new Map();    // userId → { displayName, avatarUrl }
    const tracks = new Map();   // userId → { video, audio } — что уже пришло
    // Daily застрял — разговор уходит на свой путь: пока не соединились,
    // говорим это, а не «подключаемся» (NOTICES.md, «Звонки»).
    let switching = false;
    // Собеседника не слышно SILENT_MS подряд при живом соединении —
    // подсказка: скорее всего, у него выключен микрофон. Тишина в комнате
    // даёт хоть какой-то уровень, ноль — нет.
    const SILENT_MS = 10000;
    let quietSince = 0;
    let silent = false;

    // Телеметрия разговора (docs/TELEMETRY.md, kind call), у каждой стороны
    // своя: путь, собеседник появился, соединились, переподключения, уход
    // на свой путь и почему, сеть, звук, итог. Звонок, который не взяли,
    // сюда не попадает — его видно в журнале звонков сервера.
    const tr = window.TKTrace ? TKTrace.start('call', callId) : null;
    let reconnects = 0;
    let size = 2;
    if (tr) {
      tr.route = first.engine === 'own' ? 'own' : 'daily';
      tr.set('video', isVideo);
      tr.set('role', s === OUT ? 'caller' : 'callee');
    }
    // Итог: обрыв — его причиной; иначе соединились — ok, нет — не дождались.
    // Вошли, а собеседник так и не появился — тоже не разговор: 07.10 такой
    // звонок Ивана с заказчиком стоял в «Попытках» успешным.
    window.tkCallEnd = (outcome, reason) => {
      window.tkCallEnd = null;
      if (!tr) return;
      if (!outcome && started && !hadPeer) tr.end('gave_up', 'no_peer');
      else tr.end(outcome || (started ? 'ok' : 'gave_up'), reason || (started ? '' : 'not_connected'));
    };

    function remember(userId, track, on) {
      const bag = tracks.get(userId) || {};
      bag[track.kind] = on ? track : null;
      tracks.set(userId, bag);
    }

    function show(userId, track, on) {
      const box = tileOf(s, userId, cards.get(userId));
      const el = box.querySelector(track.kind === 'video' ? 'video' : 'audio');
      TKDaily.attach(el, on && track);
      if (track.kind === 'video') box.classList.toggle('is-dark', !on);
    }

    // Переход на сетку: своя плитка, плитки участников и всё, что уже
    // пришло, — на свои места. Картинка в картинке уходит.
    function goGroup() {
      if (group) return;
      group = true;
      s.group = true;
      // Плитки участников подписываются по составу; свою подписываем «Вы».
      cards.forEach((card, id) => tileOf(s, id, card));
      [s.remoteVideo, s.localVideo, s.remoteAudio].forEach((el) => TKDaily.attach(el, null));
      s.pip.hidden = true;
      s.grid.hidden = false;
      s.stage.classList.remove('hidden');
      tileOf(s, 'me');
      tracks.forEach((bag, userId) => {
        if (bag.video) show(userId, bag.video, true);
        if (bag.audio) show(userId, bag.audio, true);
      });
      s.add.classList.remove('hidden');
      // Переписки на несколько человек в проекте нет: в групповом разговоре
      // кнопки чата не показываем, открытую ленту закрываем.
      s.chatBtn.hidden = true;
      showChat(s, false);
    }

    window.callGroupJoin = ({ peer, roster, offerer, ice }) => {
      // Состав целиком: подписать плитку собеседника, с которым говорили
      // вдвоём, иначе нечем — его имя жило только в шапке окна. Себя из
      // состава выбрасываем: своя плитка одна и подписана «Вы».
      (roster || []).forEach((card) => {
        if (String(card.userId) !== String(TK.userId)) cards.set(String(card.userId), card);
      });
      cards.set(String(peer.userId), peer);
      goGroup();
      tileOf(s, String(peer.userId), peer);
      window._call.add({ userId: String(peer.userId), offerer, ice });
      toast(t('call.joined', { name: peer.displayName }), 'ok');
    };

    window.callGroupLeft = (userId) => {
      if (!group) return;
      cards.delete(String(userId));
      tracks.delete(String(userId));
      dropTile(s, String(userId));
      if (window._call.drop) window._call.drop(String(userId));
    };

    function paint() {
      setBeacon(s, state !== 'reconnecting');
      if (switching && state !== 'live') tkText(s.status, 'call.otherPath');
      else if (state === 'reconnecting') tkText(s.status, 'call.reconnecting');
      else if (state === 'connecting') tkText(s.status, 'call.connectingShort');
      else if (peers) tkText(s.status, silent ? 'call.peerSilent' : 'call.connected');
      else tkText(s.status, hadPeer ? 'call.peerReconnecting' : 'call.waitingPeer');
    }

    // Сколько нас в разговоре — окну приглашения: вдвоём свободных мест два,
    // сетка плиток считает себя сама.
    window.tkCallSize = () => (group ? s.grid.children.length : 2);

    // ── Отчёт о звуке ──
    // Жалоба «слышно только по громкой связи» живёт с сентября, а данных
    // с устройства нет. Теперь каждый звонок рассказывает о себе сам:
    // через десять секунд после соединения и при завершении
    // (public/tk-audio.js, журнал панели, вид CallAudio).
    let reported = 0;
    function reportAudio(when) {
      if (!window.TKAudio || reported > 2) return;
      reported++;
      const sound = window._call && window._call.sound ? window._call.sound() : null;
      const mic = window._call && window._call.mic ? window._call.mic() : null;
      const el = group ? s.grid.querySelector('.tk-call__tile:not([data-user="me"]) audio') : s.remoteAudio;
      // «Звука нет» — только когда есть чем мерить и мера нулевая. Без
      // чисел это был ложный сигнал: на пути Daily их не было вовсе, и
      // журнал панели копил «звука нет» на разговорах, где звук был.
      const verdict = !sound ? 'нечем измерить' : sound.energy > 0 ? 'звук доходит' : 'звука нет';
      // Вердикт — и в попытку: по ней видно звонки без звука строкой, а не
      // разбором журнала (CallAudio там остаётся — ждём отчёт с айфона).
      if (tr) tr.set(reported === 1 ? 'heard' : 'heardEnd', !sound ? 'unknown' : sound.energy > 0 ? 'yes' : 'no');
      window.TKAudio.outputs().then((list) => window.TKAudio.send(
        'Звук в звонке (' + when + '): ' + verdict,
        [
          'когда: ' + when + ', тип звонка: ' + (isVideo ? 'с видео' : 'голосом') +
            ', путь: ' + (first.engine === 'own' ? 'свой сервер' : 'Daily') +
            ', участников: ' + (group ? s.grid.children.length : 2),
        ]
          .concat(window.TKAudio.heard(sound))
          .concat(window.TKAudio.element(el, 'элемент звука'))
          .concat(window.TKAudio.track(mic, 'свой микрофон'))
          .concat(window.TKAudio.device())
          .concat(list)
      ));
    }
    window.tkCallReport = reportAudio;

    // До входа в комнату, то есть до захвата микрофона (tk-notify.js).
    if (window.TKNotify) window.TKNotify.talking(true);
    goLive(s, isVideo);
    paint();
    // Окну всё равно, каким путём идёт разговор: и Daily, и свой путь
    // сообщают о дорожках, собеседнике, состоянии и сети одинаково.
    const view = {
      onTrack: (track, p, on) => {
        // Кто прислал: своя дорожка — «me», чужая — участник (у Daily и
        // разговора на двоих он один, имени у него здесь нет).
        const who = p.local ? 'me' : String(p.userId || 'peer');
        remember(who, track, on);
        if (group) return show(who, track, on);
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
        if (n && tr) { tr.step('peer'); if (n + 1 > size) tr.set('size', size = n + 1); }
        paint();
      },
      onState: (st) => {
        if (st === 'ended') {
          if (window.tkCallEnd) window.tkCallEnd(started ? 'partial' : 'fail', 'lost');
          endCallLocal();
          toast(t('call.lost'), 'error');
          return;
        }
        state = st;
        if (st === 'live') { switching = false; if (tr) tr.step('live'); }
        if (st === 'reconnecting' && tr && started) { tr.mark('reconnect'); tr.set('reconnects', ++reconnects); }
        // Свой объект звонка пересоздаётся, и о пропаже дорожек старый уже не
        // сообщает: без этого сцена оставалась чёрной, а в углу — пустая рамка.
        if (st === 'reconnecting') s.stage.classList.add('tk-call__stage--empty', 'tk-call__stage--nolocal');
        if (st === 'live' && !started) {
          started = true;
          startTimer(s);
          // Десять секунд — чтобы дорожки успели пойти, а человек успел
          // услышать (или не услышать) первое слово.
          setTimeout(() => { if (window._call) reportAudio('через 10 секунд'); }, 10000);
        }
        paint();
      },
      onMediaError: () => {
        if (tr) { tr.step('media_denied'); tr.set('media', 'denied'); }
        toast(t('call.mediaDenied'), 'error');
      },
      // Полоска уровня: сколько звука пришло за последний срез. Сам звук
      // мы измерить не можем (WebAudio в звонке запрещён), а вот сколько
      // его декодировалось — видно из статистики соединения.
      onAudio: (sound) => {
        s.level.classList.remove('hidden');
        const grew = sound.grew || 0;
        // Энергия за три секунды разговора вслух — сотые доли; берём
        // корень, иначе полоска дёргалась бы между нулём и краем.
        s.level.firstElementChild.style.width = Math.min(100, Math.round(Math.sqrt(grew / 0.02) * 100)) + '%';
        s.level.dataset.sound = grew > 0.0001 ? 'yes' : 'no';
        // Тишина от собеседника: только вдвоём — в группе молчат по очереди.
        const now = Date.now();
        if (grew > 0 || group || state !== 'live' || !peers) quietSince = 0;
        else if (!quietSince) quietSince = now;
        const quiet = !!quietSince && now - quietSince >= SILENT_MS;
        if (quiet !== silent) {
          silent = quiet;
          if (silent && tr) tr.step('notice_silent');
          paint();
        }
      },
      // Свой путь: каким путём пошло (напрямую или через наш TURN), дал ли
      // TURN реле, его отказы (tk-peer.js). В группе — последнее соединение.
      onIce: (x) => {
        if (tr) Object.keys(x).forEach((k) => tr.set(k, x[k]));
      },
      onNetwork: (n) => {
        if (tr && n !== 'good') tr.step('net_' + n);
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
      // дорожки собеседника — 1–2 с после его входа. Досиживать joinMs
      // приходится не всегда: недоступный домен Daily виден раньше
      // (reachMs в tk-daily.js), и тогда уходим по нему.
      joinMs: 10000,
      mediaMs: 5000,
      onStuck: (reason, peer) => {
        switching = true;
        paint();
        if (tr) { tr.step('stuck'); tr.set('stuck', String(reason).slice(0, 60)); }
        window.callSocket.emit('call:fallback', { callId, reason, peer });
      },
    }, view));

    // Свой путь — всегда комната (public/tk-peer.js): на двоих в ней одно
    // соединение, в группе — по соединению на участника. Одна дорога на оба
    // случая: разговор становится групповым посреди звонка, и переключать
    // движок в этот момент было бы негде.
    const viaOwn = (access) => {
      (access.cards || []).forEach((card) => {
        if (String(card.userId) !== String(TK.userId)) cards.set(String(card.userId), card);
      });
      if (access.group) goGroup();
      (access.peers || []).forEach((peer) => { if (cards.has(String(peer.userId))) tileOf(s, String(peer.userId), cards.get(String(peer.userId))); });
      return TKPeer.room(Object.assign({
        video: s.video,
        diag,
        ice: access.ice,
        peers: access.peers || [],
        signal: (data, to) => window.callSocket.emit('call:signal', { callId, to, data }),
        onPeerLeft: (userId) => dropTile(s, userId),
      }, view));
    };

    window._call = first.engine === 'own' ? viaOwn(first) : viaDaily();

    // Переход посреди звонка: Daily — прочь, сцена — пустая до первых
    // дорожек своего пути. Запоминает путь только тот, у кого Daily не
    // работает (сервер решает, sockets/index.js, call:fallback): у
    // собеседника он, возможно, в порядке.
    window.switchCallToOwn = (access) => {
      if (!started) { switching = true; paint(); }
      if (tr) { tr.route = 'own'; tr.step('switch_own'); }
      window._call.leave();
      [s.remoteVideo, s.localVideo, s.remoteAudio].forEach((el) => TKDaily.attach(el, null));
      s.stage.classList.add('tk-call__stage--empty', 'tk-call__stage--nolocal');
      s.remoteOn = false;
      paintVideo(s);
      if (access.remember) window.rememberOwnCallPath();
      window._call = viaOwn(access);
      // Выключенные кнопкой микрофон и камера остаются выключенными (правки
      // 29.09): новое соединение начинало с обоими включёнными, а кнопки
      // по-прежнему показывали «выключено» — собеседник вдруг слышал того,
      // кто считал себя без звука.
      if (!s.micOn) window._call.setMic(false);
      if (!s.camOn) window._call.setCamera(false);
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
      // Ниже верхнего ряда кнопок не опускается: значки стоят над «Завершить»,
      // а при открытой переписке на телефоне «Завершить» спрятана вовсе.
      const bar = s.tools.hidden ? s.actions : s.tools;
      const floor = Math.min(b.bottom, bar.getBoundingClientRect().top - 8) - b.top;
      // И выше таймера не поднимается (правки 29.09): на телефоне над ним
      // лежат статус, имя и крестик «закрыть» — своя картинка их закрывала.
      const clock = s.timer.parentElement.getBoundingClientRect();
      const ceil = clock.height ? Math.max(0, Math.min(clock.bottom + 6 - b.top, floor - MIN)) : 0;
      const width = Math.max(MIN, Math.min(w, b.width * 0.7, ((floor - ceil) * from.w) / from.h));
      const height = (width * from.h) / from.w;
      const cx = left + w / 2;
      const cy = top + (w * from.h) / from.w / 2;
      Object.assign(el.style, {
        width: width + 'px',
        height: height + 'px',
        left: Math.max(0, Math.min(cx - width / 2, b.width - width)) + 'px',
        top: Math.max(ceil, Math.min(cy - height / 2, floor - height)) + 'px',
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
    // Отчёт снимается до закрытия соединения: после него статистики не будет.
    if (window.tkCallReport) { window.tkCallReport('в конце разговора'); window.tkCallReport = null; }
    if (window.tkCallEnd) window.tkCallEnd();
    closeInvite();
    window.tkCallSize = null;
    if (window._call) { window._call.leave(); window._call = null; }
    if (window.TKNotify) window.TKNotify.talking(false);
    // Звук у уха не должен пережить разговор: эфиры и записи на странице
    // играли бы в разговорный динамик (routeAudio).
    try { if (navigator.audioSession) navigator.audioSession.type = 'auto'; } catch (e) {}
    clearInterval(window._callTick);
    [OUT, IN].forEach((s) => {
      [s.remoteVideo, s.localVideo, s.remoteAudio].forEach((el) => TKDaily.attach(el, null));
      // Своя картинка — снова в углу к следующему звонку.
      s.localVideo.removeAttribute('style');
    });
  }


  // ── Кнопки разговора и переписка в окне ───────────────────────────────
  //
  // Микрофон и своя камера гаснут, не разрывая соединения. Это не «Только
  // голос» рядом: та кнопка гасит видео в обе стороны ради канала, эти —
  // только своё. Динамик — про айфон: разговор там идёт громкой связью,
  // и переключить его на разговорный динамик у уха было нечем (жалоба
  // заказчика, 23.09). Переписка — та же, что на /chatsPage, но текстом:
  // скрепка, голосовые и кружки остаются на странице переписки.

  const coarse = window.matchMedia('(pointer: coarse)').matches;

  // Подпись кнопки — про действие, а не про состояние: микрофон включён —
  // на кнопке «Выключить микрофон». Нажатое состояние отдельно, в aria.
  function paintTool(btn, on, keyOn, keyOff) {
    const key = on ? keyOn : keyOff;
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('data-i18n-aria', key);
    btn.setAttribute('data-i18n-title', key);
    btn.setAttribute('aria-label', t(key));
    btn.title = t(key);
  }

  // Есть ли чем управлять выводом звука. На компьютере это ни к чему:
  // там динамик один и выбирает его система.
  function canRoute(s) {
    return coarse && !!(navigator.audioSession || s.remoteAudio.setSinkId);
  }

  // Куда вести звук разговора. Айфон решает это типом звуковой сессии.
  // 'auto' — выбор самого Safari: при живом микрофоне это видеосвязь, звук
  // идёт в громкий динамик — именно так разговор и звучит по умолчанию.
  // 'play-and-record', заданный страницей явно, — разговорный динамик у уха.
  //
  // Правка 25.09 (жалоба: «выключаю громкую связь — остаётся громкая»).
  // Прежде громкой связи соответствовал 'playback' — тип «только
  // воспроизведение», которого при захвате микрофона Safari не даёт.
  // И новый тип, судя по всему, вступает в силу, только когда Safari
  // пересчитывает сессию — на запуске или остановке звука страницы, а не
  // в момент присваивания. Поэтому следом перезапускаем элементы звука
  // собеседника: пауза и сразу play — на слух короткий щелчок.
  // Проверяется только на живом айфоне.
  function routeAudio(s, loud) {
    const els = [s.remoteAudio, ...s.grid.querySelectorAll('audio')].filter((el) => el.srcObject);
    try {
      if (navigator.audioSession) {
        navigator.audioSession.type = loud ? 'auto' : 'play-and-record';
        els.forEach((el) => { el.pause(); el.play().catch(() => {}); });
      }
    } catch (e) {}
    // Там, где браузер отдаёт устройства вывода (Android), — выбор по имени.
    if (!HTMLMediaElement.prototype.setSinkId || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then((list) => {
      const outs = list.filter((d) => d.kind === 'audiooutput');
      const ear = outs.find((d) => /receiver|earpiece/i.test(d.label || ''));
      const loudspeaker = outs.find((d) => /speaker/i.test(d.label || '')) || outs[0];
      const pick = loud ? loudspeaker : ear;
      if (pick) els.forEach((el) => el.setSinkId(pick.deviceId).catch(() => {}));
    }).catch(() => {});
  }

  // ── Переписка ──
  // Лента — последняя страница истории (/getMessages), новое приходит
  // событием сокета, которое tk-app и так раздаёт документу. Вложения и
  // исчезающие показываем строкой-заменой: открывать их здесь нечем.
  function chatBubble(m) {
    const mine = String(m.sender) === String(TK.userId);
    let text = m.content || '';
    // Исчезнувшее приходит без текста и файла — пустой пузырь сбивал бы с толку.
    if (m.expired) text = t('chats.gone');
    else if (m.limit) text = t('call.chatSealed');
    else if (!text && (m.attachments || []).length) text = t('call.chatAttachment');
    const at = new Date(m.sentAt);
    const time = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0');
    return '<div class="tk-callchat__msg' + (mine ? ' tk-callchat__msg--mine' : '') + '" data-id="' + escapeHtml(String(m._id || '')) + '">' +
      '<span>' + escapeHtml(text) + '</span><i>' + time + '</i></div>';
  }

  function chatEmpty(s) {
    s.chatFeed.innerHTML = '<p class="tk-callchat__empty">' + escapeHtml(t('call.chatEmpty')) + '</p>';
  }

  // Своё сообщение приходит дважды: ответом на отправку и эхом сокета,
  // которое сервер шлёт всем вкладкам отправителя (messages.js). Второе
  // узнаём по id — раньше отправитель видел его в ленте два раза.
  function addChatMessage(s, m) {
    if (m._id && s.chatFeed.querySelector('[data-id="' + CSS.escape(String(m._id)) + '"]')) return;
    const empty = s.chatFeed.querySelector('.tk-callchat__empty');
    if (empty) empty.remove();
    s.chatFeed.insertAdjacentHTML('beforeend', chatBubble(m));
    s.chatFeed.scrollTop = s.chatFeed.scrollHeight;
  }

  // Прочитано: человек читает сообщение в звонке — значок в шапке должен
  // погаснуть так же, как от страницы переписки. Точное число даёт сервер.
  function markChatRead(s) {
    tkFetch('/messages/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: s.peerId }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (window.tkChatBadge && typeof d.unreadMessages === 'number') window.tkChatBadge({ messages: d.unreadMessages });
      })
      .catch(() => {});
  }

  function loadChat(s) {
    if (s.chatLoaded || !s.peerId) return;
    s.chatLoaded = true;
    tkFetch('/getMessages?recipientId=' + encodeURIComponent(s.peerId))
      // 404 — переписки ещё не было: это не ошибка, а пустая лента.
      .then((r) => (r.status === 404 ? { messages: [] } : r.json()))
      .then((d) => {
        const list = d.messages || [];
        if (!list.length) return chatEmpty(s);
        s.chatFeed.innerHTML = list.map(chatBubble).join('');
        s.chatFeed.scrollTop = s.chatFeed.scrollHeight;
        markChatRead(s);
      })
      .catch(() => { s.chatLoaded = false; chatEmpty(s); });
  }

  function sendChat(s) {
    const content = s.chatInput.value.trim();
    if (!content || s.chatBusy || !s.peerId) return;
    s.chatBusy = true;
    const post = (url, body) => tkFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const send = () => post('/sendMessage', { recipientId: s.peerId, content });
    send()
      // Первое сообщение этому человеку: диалога ещё нет, заводим и шлём снова.
      // Не завёлся (закрытая личка, ограничение) — его отказ и показываем.
      .then((r) => (r.status === 404 ? post('/start-conversation', { recipientId: s.peerId }).then((c) => (c.ok ? send() : c)) : r))
      .then((r) => {
        if (r.ok) return r.json();
        // 403 — правило собеседника: сервер объясняет словами, их и показать.
        if (r.status === 403) return r.json().catch(() => ({})).then((d) => { throw Object.assign(new Error(d.message || ''), { said: !!d.message }); });
        throw new Error(TKNet.explain(r));
      })
      .then((m) => {
        s.chatInput.value = '';
        addChatMessage(s, m);
      })
      .catch((e) => toast(e.said ? e.message : t('call.chatFailed'), 'error'))
      .then(() => { s.chatBusy = false; });
  }

  function paintUnread(s) {
    s.chatCount.hidden = !s.chatUnread;
    s.chatCount.textContent = s.chatUnread > 9 ? '9+' : String(s.chatUnread);
  }

  function showChat(s, on) {
    s.chat.hidden = !on;
    if (s.card) s.card.classList.toggle('has-chat', on);
    paintTool(s.chatBtn, on, 'call.chatHide', 'call.chatShow');
    if (!on) return;
    // Открыли — пришедшее за это время прочитано.
    if (s.chatUnread && s.chatLoaded) markChatRead(s);
    s.chatUnread = 0;
    paintUnread(s);
    loadChat(s);
    // На телефоне клавиатуру не поднимаем сами: она закрыла бы собеседника.
    if (!coarse) s.chatInput.focus();
  }

  [OUT, IN].forEach((s) => {
    s.micBtn.addEventListener('click', () => {
      s.micOn = !s.micOn;
      if (window._call && window._call.setMic) window._call.setMic(s.micOn);
      paintTool(s.micBtn, !s.micOn, 'call.micOn', 'call.micOff');
    });
    s.camBtn.addEventListener('click', () => {
      s.camOn = !s.camOn;
      if (window._call && window._call.setCamera) window._call.setCamera(s.camOn);
      paintTool(s.camBtn, !s.camOn, 'call.camOn', 'call.camOff');
    });
    s.spkBtn.addEventListener('click', () => {
      s.loud = !s.loud;
      routeAudio(s, s.loud);
      paintTool(s.spkBtn, s.loud, 'call.speakerOff', 'call.speakerOn');
    });
    s.chatBtn.addEventListener('click', () => showChat(s, s.chat.hidden));
    s.chatForm.addEventListener('submit', (e) => { e.preventDefault(); sendChat(s); });
  });

  // Сообщение от того, с кем разговариваем (или своё из другой вкладки), —
  // в ленту, если она уже загружена. Переписка закрыта — входящее считаем
  // на значке, прочитанным оно станет, когда её откроют.
  document.addEventListener('tk:message:new', (e) => {
    const d = e.detail || {};
    if (!d.message || !d.peer) return;
    [OUT, IN].forEach((s) => {
      if (!s.peerId || s.peerId !== String(d.peer.id)) return;
      if (s.chatLoaded) addChatMessage(s, d.message);
      if (String(d.message.sender) === String(TK.userId)) return;
      if (!s.chat.hidden) return markChatRead(s);
      s.chatUnread++;
      paintUnread(s);
    });
  });

  window.showOutgoingCall = function(opts){
    const displayName = opts && opts.displayName || t('call.user');
    const callType = opts && opts.callType || 'video';
    outName.textContent = displayName;
    tkText(outType, callType === 'audio' ? 'call.outgoingAudio' : 'call.outgoingVideo');
    tkText(OUT.status, 'call.connecting');
    renderAvatar(outAvatar, opts && opts.avatarUrl || '', displayName);
    resetSide(OUT);
    OUT.peerId = opts && opts.userId ? String(opts.userId) : '';
    // Звонок группе: собеседник не один, переписки на двоих нет.
    OUT.chatBtn.hidden = !OUT.peerId;
    OUT.actions.classList.remove('tk-call__actions--pair', 'tk-call__actions--live');
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
    // Зовут в идущий разговор — человек должен видеть, кто там уже есть,
    // до того как возьмёт трубку.
    if (opts && opts.group) {
      const names = (opts.peers || []).map((p) => p.displayName).filter(Boolean).join(', ');
      inType.removeAttribute('data-i18n');
      inType.textContent = t('call.incomingGroup', { names });
    } else {
      tkText(inType, callType === 'audio' ? 'call.incomingAudio' : 'call.incomingVideo');
    }
    renderAvatar(inAvatar, opts && opts.avatarUrl || '', displayName);
    resetSide(IN);
    // Звонок группе или приглашение в идущий разговор: собеседник не один,
    // и переписка с тем, кто позвал, в общем разговоре только путала бы.
    IN.peerId = opts && opts.userId && !opts.group && !opts.chat ? String(opts.userId) : '';
    IN.chatBtn.hidden = !IN.peerId;
    tkText(IN.status, 'call.ringing');
    IN.actions.classList.remove('tk-call__actions--live');
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

  // ── Позвать в разговор ──
  // Кандидаты — свои контакты (routes/contacts.js), кого в них нет — поиском
  // по сайту. Потолок — четверо (sockets/index.js, GROUP_MAX): сколько мест
  // осталось, окно говорит сразу, а отказы и «не берёт трубку» приходят
  // с сервера и показываются как уведомления.
  const GROUP_MAX = 4;
  const invite = $('callInviteModal');
  const inviteList = $('callInviteList');
  const inviteSearch = $('callInviteSearch');
  const inviteFree = $('callInviteFree');
  window.tkCallNames = {};
  let inviteTimer = null;

  function inviteRows(people) {
    if (!people.length) {
      inviteList.innerHTML = '<p class="tk-note tk-note--center">' + escapeHtml(t('chats.forwardEmpty')) + '</p>';
      return;
    }
    inviteList.innerHTML = people.map((p) => {
      window.tkCallNames[p.id] = p.name;
      return '<button type="button" class="tk-invite__row" data-invite="' + escapeHtml(p.id) + '">' +
        '<span class="tk-invite__ava"' + (p.url ? '' : ' style="background:' + escapeHtml(p.bg || '') + '"') + '>' +
        (p.url ? '<img src="' + escapeHtml(p.url) + '" alt="">' : escapeHtml(p.initial || '?')) + '</span>' +
        '<span class="tk-invite__name">' + escapeHtml(p.name) + '</span></button>';
    }).join('');
  }

  const asInvitee = (u) => {
    const a = u.avatarStyle || {};
    return { id: String(u.id || u._id), name: u.displayName, url: a.url || '', bg: a.gradient || '', initial: a.initial || '' };
  };

  function openInvite() {
    const free = GROUP_MAX - (window.tkCallSize ? window.tkCallSize() : 2);
    inviteFree.textContent = free > 0 ? t('call.addFree', { n: free }) : t('call.addFull');
    inviteSearch.value = '';
    inviteList.innerHTML = '';
    invite.classList.remove('hidden');
    if (free <= 0) return;
    inviteSearch.focus();
    tkFetch('/api/contacts')
      .then((r) => r.json())
      .then((data) => inviteRows((data.contacts || []).map(asInvitee)))
      .catch(() => inviteRows([]));
  }

  function closeInvite() { invite.classList.add('hidden'); }

  [OUT, IN].forEach((s) => s.add.addEventListener('click', openInvite));
  $('callInviteClose').addEventListener('click', closeInvite);
  invite.addEventListener('click', (e) => { if (e.target === invite) closeInvite(); });

  inviteSearch.addEventListener('input', () => {
    clearTimeout(inviteTimer);
    const q = inviteSearch.value.trim();
    if (q.length < 2) return;
    inviteTimer = setTimeout(() => {
      tkFetch('/api/search?type=people&limit=8&q=' + encodeURIComponent(q))
        .then((r) => r.json())
        .then((found) => {
          if (inviteSearch.value.trim() !== q) return;
          inviteRows((found.people || []).map(asInvitee));
        })
        .catch(() => {});
    }, 300);
  });

  inviteList.addEventListener('click', (e) => {
    const row = e.target.closest('[data-invite]');
    if (!row || !window.currentCallId || !window.callSocket) return;
    window.callSocket.emit('call:invite', { callId: window.currentCallId, userId: row.getAttribute('data-invite') });
    toast(t('call.inviteSent', { name: window.tkCallNames[row.getAttribute('data-invite')] || '' }), 'ok');
    closeInvite();
  });

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
