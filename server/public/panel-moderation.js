/* Панель модерации: вкладки «Жалобы» и «Люди».
 *
 * Отдельный файл, а не часть admin.js: тот целиком про заведения и модератору
 * не грузится вовсе. Общего у них только оформление карточек.
 *
 * Всё внутри функции, а не в общей области: у admin.js есть свои cardHtml()
 * и note(), и без обёртки последний загруженный файл молча перетирал бы чужие —
 * заведения начинали рисоваться разметкой жалоб.
 */
(function () {
'use strict';

// Скрипт грузится только на странице панели, но проверку оставляем: файл
// статический и может быть подключён где-то ещё.
if (!document.querySelector('.tk-panel-page')) return;

var reportsBox = document.getElementById('reports');

var reportStatus = document.getElementById('reportStatus');
var reportsBadge = document.getElementById('reportsBadge');

var REASONS = {
  spam: 'спам',
  abuse: 'оскорбления',
  adult: 'контент 18+',
  violence: 'насилие',
  copyright: 'права на контент',
  other: 'другое'
};

var TARGETS = {
  stream: 'эфир',
  user: 'пользователь',
  message: 'сообщение чата'
};

// Дата в панели читается человеком, а не машиной: день и время, без года —
// жалобы разбирают по горячим следам.
function when(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function targetLine(r) {
  var kind = TARGETS[r.targetType] || r.targetType;

  if (!r.target) {
    return '<span class="tk-adm__gone">' + escapeHtml(kind) + ' удалён или уже недоступен</span>';
  }

  var title = escapeHtml(r.target.title || 'без названия');
  var marks = '';

  if (r.targetType === 'stream') {
    marks = r.target.stopped
      ? '<span class="tk-adm__state">погашен модерацией</span>'
      : (r.target.isActive ? '<span class="tk-adm__state tk-adm__state--on">в эфире</span>' : '<span class="tk-adm__state">не в эфире</span>');
  }
  if (r.target.banned) {
    marks = '<span class="tk-adm__state">уже ограничен</span>';
  }

  return escapeHtml(kind) + ' <b>' + title + '</b> ' + marks;
}

function cardHtml(r) {
  // Автор нарушения: для жалобы на пользователя это он сам, для эфира
  // и сообщения — их владелец. Кнопка ограничения одна на все три случая.
  var authorId = r.targetType === 'user' ? r.targetId : (r.target && r.target.ownerId ? r.target.ownerId : '');
  var reporter = r.reporter ? (r.reporter.login || r.reporter.email || 'без имени') : 'аккаунт удалён';
  var open = r.status === 'new';

  var acts = '';
  if (open) {
    if (r.targetType === 'stream' && r.target && r.target.isActive) {
      acts += '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs stop">Остановить эфир</button>';
    }
    if (authorId && !(r.target && r.target.banned)) {
      acts += '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs ban" data-user="' + escapeHtml(authorId) + '">Ограничить автора</button>';
    }
    acts += '<button type="button" class="tk-btn tk-btn--primary tk-btn--xs close-report" data-status="resolved">Разобрано</button>' +
            '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs close-report" data-status="rejected">Отклонить</button>';
  }

  return '<article class="tk-adm__card tk-adm__report" data-id="' + escapeHtml(r._id) + '"' +
              ' data-target="' + escapeHtml(r.targetId) + '">' +
           '<div class="tk-adm__card-head">' +
             '<p class="tk-adm__card-name">' + escapeHtml(REASONS[r.reason] || r.reason) + '</p>' +
             '<span class="tk-adm__when">' + escapeHtml(when(r.createdAt)) + '</span>' +
           '</div>' +
           '<p class="tk-adm__report-target">' + targetLine(r) + '</p>' +
           (r.comment ? '<p class="tk-adm__report-comment">' + escapeHtml(r.comment) + '</p>' : '') +
           '<p class="tk-adm__report-from">пожаловался ' + escapeHtml(reporter) + '</p>' +
           (r.action ? '<p class="tk-adm__report-from">решение: ' + escapeHtml(r.action) + '</p>' : '') +
           (open
             ? '<div class="tk-adm__acts">' +
                 '<input type="text" class="tk-field reason" placeholder="Причина или что сделано" maxlength="300">' +
                 acts +
               '</div>'
             : '') +
         '</article>';
}

function note(text) {
  return '<p class="tk-adm__note">' + escapeHtml(text) + '</p>';
}

async function loadReports() {
  if (!reportsBox) return;

  var status = reportStatus ? reportStatus.value : 'new';
  reportsBox.innerHTML = note('Загружаем…');

  try {
    var res = await fetch('/api/moderation/reports?status=' + encodeURIComponent(status));
    if (!res.ok) throw new Error('HTTP ' + res.status);

    var data = await res.json();
    var list = data.reports || [];

    if (reportsBadge && status === 'new') {
      reportsBadge.textContent = list.length ? String(list.length) : '';
      reportsBadge.hidden = !list.length;
    }

    reportsBox.innerHTML = list.length
      ? list.map(cardHtml).join('')
      : note(status === 'new' ? 'Новых жалоб нет' : 'Здесь пусто');
  } catch (err) {
    reportsBox.innerHTML = note('Не удалось загрузить жалобы');
  }
}

async function send(url, body) {
  var res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });

  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(data.message || 'HTTP ' + res.status);
  return data;
}

if (reportsBox) reportsBox.addEventListener('click', async function (e) {
  var btn = e.target.closest('button');
  if (!btn) return;

  var card = btn.closest('.tk-adm__report');
  if (!card) return;

  var id = card.dataset.id;
  var field = card.querySelector('.reason');
  var reason = field ? field.value.trim() : '';

  try {
    if (btn.classList.contains('stop')) {
      await send('/api/moderation/streams/' + card.dataset.target + '/stop', { reason: reason });
      toast('Эфир остановлен', 'ok');
      return loadReports();
    }

    if (btn.classList.contains('ban')) {
      // Причина у бана обязательна и на сервере: без неё запрос вернётся
      // с 400, поэтому спрашиваем здесь, а не после отказа.
      if (reason.length < 3) {
        toast('Впишите причину ограничения', 'error');
        if (field) field.focus();
        return;
      }
      var ok = await confirmDialog('Ограничить автора? Вход останется, писать и вещать он не сможет.', {
        confirmText: 'Ограничить'
      });
      if (!ok) return;

      await send('/api/moderation/users/' + btn.dataset.user + '/ban', { reason: reason });
      toast('Автор ограничен', 'ok');
      return loadReports();
    }

    if (btn.classList.contains('close-report')) {
      await send('/api/moderation/reports/' + id + '/close', {
        status: btn.dataset.status,
        action: reason
      });
      toast(btn.dataset.status === 'resolved' ? 'Жалоба разобрана' : 'Жалоба отклонена', 'ok');
      return loadReports();
    }
  } catch (err) {
    toast(err.message || 'Не получилось', 'error');
  }
});

if (reportStatus) reportStatus.addEventListener('change', loadReports);

// ── Люди ────────────────────────────────────────────────────────────────────

var peopleBox = document.getElementById('people');
var peopleSearch = document.getElementById('peopleSearch');
// Смена роли — право администратора, у модератора этих кнопок нет. Разметку
// решает сервер, здесь только флаг: скрывать нарисованное поздно.
var canGrant = peopleBox && peopleBox.dataset.grant === '1';

var ROLES = { user: 'пользователь', moderator: 'модератор', admin: 'администратор' };

function personHtml(u) {
  var name = escapeHtml(u.login || u.email || 'без имени');
  var isMod = u.role === 'moderator' || u.role === 'admin';

  var roleCell = canGrant && !isMod
    ? '<select class="tk-field tk-select role">' +
        Object.keys(ROLES).map(function (r) {
          return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + ROLES[r] + '</option>';
        }).join('') +
      '</select>'
    : '<span class="tk-adm__state' + (isMod ? ' tk-adm__state--on' : '') + '">' + escapeHtml(ROLES[u.role] || u.role) + '</span>';

  // Модератора и администратора не банят — это же правило стоит на сервере,
  // здесь просто не рисуем кнопку, которая гарантированно вернёт 403.
  var banCell = isMod
    ? ''
    : (u.banned
        ? '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs unban">Снять ограничение</button>'
        : '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs ban">Ограничить</button>');

  return '<article class="tk-adm__card tk-adm__person" data-id="' + escapeHtml(u._id) + '">' +
           '<div class="tk-adm__card-head">' +
             '<p class="tk-adm__card-name">' + name + '</p>' +
             roleCell +
           '</div>' +
           '<p class="tk-adm__report-from">' + escapeHtml(u.email || '') + '</p>' +
           (u.banned
             ? '<p class="tk-adm__report-comment">ограничен: ' + escapeHtml(u.banReason || 'без причины') + '</p>'
             : '') +
           // Строка действий рисуется только если в ней есть действие:
           // модератора и администратора не банят, и поле причины у них
           // висело бы в одиночестве, обещая кнопку, которой нет.
           (banCell
             ? '<div class="tk-adm__acts">' +
                 (u.banned ? '' : '<input type="text" class="tk-field reason" placeholder="Причина ограничения" maxlength="300">') +
                 banCell +
               '</div>'
             : '') +
         '</article>';
}

async function loadPeople() {
  if (!peopleBox) return;

  var q = peopleSearch ? peopleSearch.value.trim() : '';
  peopleBox.innerHTML = note('Загружаем…');

  try {
    var res = await fetch('/api/moderation/users?q=' + encodeURIComponent(q));
    if (!res.ok) throw new Error('HTTP ' + res.status);

    var data = await res.json();
    var list = data.users || [];

    peopleBox.innerHTML = list.length ? list.map(personHtml).join('') : note('Никого не нашли');
  } catch (err) {
    peopleBox.innerHTML = note('Не удалось загрузить список');
  }
}

if (peopleBox) {
  peopleBox.addEventListener('click', async function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;

    var card = btn.closest('.tk-adm__person');
    if (!card) return;

    var field = card.querySelector('.reason');
    var reason = field ? field.value.trim() : '';

    try {
      if (btn.classList.contains('ban')) {
        if (reason.length < 3) {
          toast('Впишите причину ограничения', 'error');
          if (field) field.focus();
          return;
        }
        var ok = await confirmDialog('Ограничить этого человека? Вход останется, писать и вещать он не сможет.', {
          confirmText: 'Ограничить'
        });
        if (!ok) return;

        var res = await send('/api/moderation/users/' + card.dataset.id + '/ban', { reason: reason });
        toast(res.streamsStopped ? 'Ограничен, эфир остановлен' : 'Ограничен', 'ok');
        return loadPeople();
      }

      if (btn.classList.contains('unban')) {
        await send('/api/moderation/users/' + card.dataset.id + '/unban', {});
        toast('Ограничение снято', 'ok');
        return loadPeople();
      }
    } catch (err) {
      toast(err.message || 'Не получилось', 'error');
    }
  });

  peopleBox.addEventListener('change', async function (e) {
    var select = e.target.closest('.role');
    if (!select) return;

    var card = select.closest('.tk-adm__person');
    try {
      await send('/api/moderation/users/' + card.dataset.id + '/role', { role: select.value });
      toast('Роль изменена', 'ok');
      loadPeople();
    } catch (err) {
      toast(err.message || 'Не получилось', 'error');
      loadPeople();
    }
  });
}

// Поиск с задержкой: список перезапрашивается после паузы в наборе,
// а не на каждую букву.
if (peopleSearch) {
  var searchTimer = null;
  peopleSearch.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadPeople, 300);
  });
}

// ── Вкладки ─────────────────────────────────────────────────────────────────
//
// Вкладка пишется в адрес: /panel#people открывается сразу на людях, и после
// перезагрузки страница остаётся там же, где была.
var tabs = document.querySelectorAll('.tk-adm__tab');

function show(view) {
  // Сначала убеждаемся, что такая вкладка есть, и только потом трогаем
  // состояние: иначе адрес с чужим или пустым хешем гасил отметку на всех
  // вкладках сразу и панель оставалась без активной.
  var tab = null;
  tabs.forEach(function (t) { if (t.dataset.tab === view) tab = t; });
  if (!tab) return false;

  tabs.forEach(function (t) { t.classList.toggle('tk-adm__tab--on', t === tab); });
  document.querySelectorAll('[data-view]').forEach(function (el) {
    el.hidden = el.dataset.view !== view;
  });

  if (view === 'reports') loadReports();
  if (view === 'people') loadPeople();
  return true;
}

function showFromHash() {
  show((location.hash || '').replace('#', ''));
}

tabs.forEach(function (tab) {
  tab.addEventListener('click', function () {
    show(tab.dataset.tab);
    history.replaceState(null, '', '#' + tab.dataset.tab);
  });
});

// Жалобы подгружаются в любом случае: счётчик новых висит на вкладке
// и должен быть виден, даже когда открыта не она.
loadReports();

// Адрес может указывать на вкладку, которой у этой роли нет — тогда остаёмся
// на той, что отмечена в разметке.
showFromHash();

// Переход на /panel#people с той же страницы — это смена хеша, а не загрузка:
// без этого обработчика ни ссылка, ни кнопки «назад» и «вперёд» вкладку
// не переключают.
window.addEventListener('hashchange', showFromHash);
})();
