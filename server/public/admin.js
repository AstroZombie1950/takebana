/* Панель администрирования: список заведений, правка, статус, смена пароля.
 *
 * Раньше жил инлайном в admin.ejs. Разметка карточки была там переписана
 * трижды — в первой загрузке, в поиске и в подгрузке по прокрутке; теперь
 * её собирает одна функция, и подписи полей не расходятся между копиями.
 */

var PER_PAGE = 9;
var page = 1;
var loading = false;
var reachedEnd = false;

var grid = document.getElementById('fields');
var statusFilter = document.getElementById('statusFilter');
var searchInput = document.getElementById('searchInput');

// Подписи полей. Прежде здесь стояли плейсхолдеры «name», «lat», «lng»:
// по-английски и пропадали, как только поле заполнялось.
var FIELDS = [
  { key: 'name',    label: 'Название', wide: true },
  { key: 'country', label: 'Страна' },
  { key: 'city',    label: 'Город' },
  { key: 'address', label: 'Адрес', wide: true },
  { key: 'email',   label: 'Email', type: 'email' },
  { key: 'phone',   label: 'Телефон', type: 'tel' },
  { key: 'lat',     label: 'Широта' },
  { key: 'lng',     label: 'Долгота' }
];

function valueOf(est, key) {
  if (key === 'lat' || key === 'lng') {
    return (est.location && est.location[key] != null) ? est.location[key] : '';
  }
  return est[key] != null ? est[key] : '';
}

function cardHtml(est) {
  var on = !!est.status;
  var fields = FIELDS.map(function (f) {
    var id = f.key + '-' + est._id;
    return '<div class="tk-adm__field' + (f.wide ? ' tk-adm__field--wide' : '') + '">' +
             '<label class="tk-adm__label" for="' + escapeHtml(id) + '">' + f.label + '</label>' +
             '<input type="' + (f.type || 'text') + '" id="' + escapeHtml(id) + '" class="tk-field ' + f.key + '" ' +
                    'value="' + escapeHtml(valueOf(est, f.key)) + '">' +
           '</div>';
  }).join('');

  return '<div class="tk-adm__card' + (on ? '' : ' tk-adm__card--off') + '" data-id="' + escapeHtml(est._id) + '">' +
           '<div class="tk-adm__card-head">' +
             '<p class="tk-adm__card-name">' + escapeHtml(est.name || 'Без названия') + '</p>' +
             '<span class="tk-adm__state' + (on ? ' tk-adm__state--on' : '') + '">' + (on ? 'активно' : 'скрыто') + '</span>' +
           '</div>' +
           '<div class="tk-adm__fields">' + fields + '</div>' +
           '<div class="tk-adm__acts">' +
             '<button type="button" class="tk-btn tk-btn--primary tk-btn--xs save" disabled>Сохранить</button>' +
             '<button type="button" class="tk-btn tk-btn--outline tk-btn--xs delete">Удалить</button>' +
             '<label class="tk-adm__switch">' +
               '<input type="checkbox" class="status"' + (on ? ' checked' : '') + '>' +
               '<span>Активно</span>' +
             '</label>' +
           '</div>' +
         '</div>';
}

function note(text) {
  return '<p class="tk-adm__note">' + escapeHtml(text) + '</p>';
}

async function loadEstablishments(reset) {
  if (loading) return;
  loading = true;

  if (reset) {
    page = 1;
    reachedEnd = false;
    grid.innerHTML = note('Загрузка…');
  }

  var params = new URLSearchParams({ page: page, perPage: PER_PAGE, status: statusFilter.value });
  var search = searchInput.value.trim();
  if (search) params.set('search', search);

  try {
    var response = await fetch('/admin/establishments?' + params.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    var data = await response.json();
    if (reset) grid.innerHTML = '';

    if (!data.length) {
      reachedEnd = true;
      if (!grid.querySelector('.tk-adm__card')) {
        grid.innerHTML = note(search ? 'По запросу ничего не найдено' : 'Заведений пока нет');
      }
      return;
    }

    if (data.length < PER_PAGE) reachedEnd = true;
    grid.insertAdjacentHTML('beforeend', data.map(cardHtml).join(''));
  } catch (e) {
    console.error('establishments:', e);
    toast('Ошибка: ' + e.message, 'error');
    if (reset) grid.innerHTML = note('Не удалось загрузить список');
  } finally {
    loading = false;
  }
}

// ── Правка заведения ───────────────────────────────────────────────────────

grid.addEventListener('input', function (e) {
  var card = e.target.closest('.tk-adm__card');
  if (!card || e.target.tagName !== 'INPUT' || e.target.type === 'checkbox') return;
  // Кнопка оживает только когда есть что сохранять.
  card.querySelector('.save').disabled = false;
});

grid.addEventListener('click', async function (e) {
  var card = e.target.closest('.tk-adm__card');
  if (!card) return;
  var id = card.dataset.id;

  if (e.target.classList.contains('save')) {
    var body = {
      name: card.querySelector('.name').value,
      country: card.querySelector('.country').value,
      city: card.querySelector('.city').value,
      address: card.querySelector('.address').value,
      email: card.querySelector('.email').value,
      phone: card.querySelector('.phone').value,
      location: {
        lat: parseFloat(card.querySelector('.lat').value),
        lng: parseFloat(card.querySelector('.lng').value)
      }
    };

    try {
      var res = await fetch('/admin/updEstablishment/' + encodeURIComponent(id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await res.json();
      e.target.disabled = true;
      card.querySelector('.tk-adm__card-name').textContent = body.name || 'Без названия';
      toast('Заведение обновлено', 'ok');
    } catch (err) {
      console.error('updEstablishment:', err);
      toast('Ошибка: ' + err.message, 'error');
    }
    return;
  }

  if (e.target.classList.contains('delete')) {
    var name = card.querySelector('.tk-adm__card-name').textContent;
    // Удаление необратимо — спрашиваем. Прежде заведение исчезало по клику.
    var sure = await confirmDialog('Удалить «' + name + '»? Отменить будет нельзя.', { okText: 'Удалить' });
    if (!sure) return;

    try {
      var del = await fetch('/admin/deleteEstablishment/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!del.ok) throw new Error('HTTP ' + del.status);
      await del.json();
      card.remove();
      toast('Заведение удалено', 'ok');
    } catch (err) {
      console.error('deleteEstablishment:', err);
      toast('Ошибка: ' + err.message, 'error');
    }
  }
});

grid.addEventListener('change', async function (e) {
  if (!e.target.classList.contains('status')) return;
  var card = e.target.closest('.tk-adm__card');
  var on = e.target.checked;

  try {
    var res = await fetch('/admin/updateEstablishmentStatus/' + encodeURIComponent(card.dataset.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: on })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await res.json();

    card.classList.toggle('tk-adm__card--off', !on);
    var mark = card.querySelector('.tk-adm__state');
    mark.textContent = on ? 'активно' : 'скрыто';
    mark.classList.toggle('tk-adm__state--on', on);
    toast('Статус обновлён', 'ok');
  } catch (err) {
    console.error('updateEstablishmentStatus:', err);
    e.target.checked = !on;
    toast('Ошибка: ' + err.message, 'error');
  }
});

// ── Фильтр, поиск, подгрузка ───────────────────────────────────────────────

statusFilter.addEventListener('change', function () { loadEstablishments(true); });

// Поиск с задержкой: прежде запрос уходил на каждое нажатие клавиши.
var searchTimer = null;
searchInput.addEventListener('input', function () {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function () { loadEstablishments(true); }, 300);
});

window.addEventListener('scroll', function () {
  if (loading || reachedEnd) return;
  if (window.innerHeight + window.scrollY < document.body.offsetHeight - 200) return;
  page++;
  loadEstablishments(false);
});

// ── Смена пароля ───────────────────────────────────────────────────────────

var modal = document.getElementById('repassModal');
var openRepass = document.getElementById('openRepass');

openRepass.addEventListener('click', function () {
  modal.classList.remove('hidden');
  document.getElementById('oldPassword').focus();
});

function closeRepass() {
  modal.classList.add('hidden');
  document.getElementById('repassForm').reset();
}

document.getElementById('closeRepass').addEventListener('click', closeRepass);
modal.addEventListener('click', function (e) { if (e.target === modal) closeRepass(); });
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeRepass();
});

document.getElementById('repassForm').addEventListener('submit', async function (e) {
  e.preventDefault();

  var oldPassword = document.getElementById('oldPassword').value;
  var newPassword = document.getElementById('newPassword').value;
  var confirmPassword = document.getElementById('confirmPassword').value;

  if (!oldPassword || !newPassword || !confirmPassword) {
    toast('Заполните все поля', 'error');
    return;
  }
  if (newPassword !== confirmPassword) {
    toast('Новый пароль и подтверждение не совпадают', 'error');
    return;
  }
  if (newPassword.length < 8) {
    toast('Новый пароль короче восьми символов', 'error');
    return;
  }

  try {
    var res = await fetch('/admin/updatePassword', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: oldPassword, newPassword: newPassword })
    });
    if (!res.ok) {
      if (res.status === 400) throw new Error('Текущий пароль не подходит');
      if (res.status === 401) throw new Error('Неверный текущий пароль');
      throw new Error('HTTP ' + res.status);
    }
    var data = await res.json();
    toast(data.message || 'Пароль обновлён', 'ok');
    closeRepass();
  } catch (err) {
    console.error('updatePassword:', err);
    toast('Ошибка: ' + err.message, 'error');
  }
});

loadEstablishments(true);
