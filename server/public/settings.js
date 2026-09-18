/* Настройки профиля: имя, фото, пароль, удаление аккаунта. Язык переключает общий
 * tk-i18n.js по кнопкам с data-lang — здесь для него ничего не нужно.
 *
 * Раньше жило в tk-app.js и грузилось с каждой страницей кабинета вместе
 * с окном профиля.
 */
(function () {
  var t = window.t || function () { return ''; };
  var tkText = window.tkText || function () {};
  var $ = function (id) { return document.getElementById(id); };

  // Ответ сервера — JSON с message; не 2xx — ошибка с этим текстом.
  // Accept — чтобы и общий обработчик ошибок (middleware/errors.js) ответил
  // JSON, а не страницей: иначе отказ загрузки («Только изображения JPEG…»)
  // доходил до человека как безликое «HTTP 400».
  function send(url, options) {
    options = options || {};
    options.headers = Object.assign({ Accept: 'application/json' }, options.headers);
    return fetch(url, options).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok || data.success === false) throw new Error(data.message || 'HTTP ' + r.status);
        return data;
      });
    });
  }

  function json(body) {
    return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }

  // ── Имя ───────────────────────────────────────────────────────────────
  // После сохранения — перезагрузка: имя и буква аватара стоят по всей
  // странице, от шапки панели до подписей.
  $('nameForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var login = $('profileNameInput').value.trim();
    if (!login) return toast(t('app.nameEmpty'), 'error');
    send('/update-profile', json({ login: login }))
      .then(function () { location.reload(); })
      .catch(function (err) { toast(t('app.errorPrefix', { message: err.message }), 'error'); });
  });

  // ── Фото профиля ──────────────────────────────────────────────────────
  var avatarInput = $('avatarInput');
  var chooseAvatar = $('chooseAvatarBtn');
  var deleteAvatar = $('deleteAvatarBtn');
  var avatarHint = $('avatarHint');

  // Аватар везде на странице — здесь и в левой панели: фото или градиент
  // с буквой, как его отдал сервер (utils/userView.js).
  function paintAvatar(ava) {
    var boxes = [$('avatarBox')].concat(Array.prototype.slice.call(document.querySelectorAll('[data-my-avatar]')));
    boxes.forEach(function (box) {
      box.style.background = ava.url ? '' : ava.gradient;
      box.innerHTML = ava.url ? '<img src="' + escapeHtml(ava.url) + '" alt="">' : escapeHtml(ava.initial || '');
    });
    tkText(chooseAvatar, ava.url ? 'settings.photoReplace' : 'settings.photoUpload');
    deleteAvatar.hidden = !ava.url;
  }

  function busy(on) {
    chooseAvatar.disabled = on;
    deleteAvatar.disabled = on;
  }

  chooseAvatar.addEventListener('click', function () { avatarInput.click(); });

  avatarInput.addEventListener('change', function () {
    var file = avatarInput.files[0];
    avatarInput.value = ''; // тот же файл ещё раз — снова change
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      return tkText(avatarHint, 'app.fileBad');
    }
    var form = new FormData();
    form.append('avatar', file);
    busy(true);
    tkText(avatarHint, 'app.uploading');
    send('/profile/avatar', { method: 'POST', body: form })
      .then(function (data) {
        paintAvatar(data.avatar);
        tkText(avatarHint, 'app.photoDone');
      })
      .catch(function (err) { avatarHint.removeAttribute('data-i18n'); avatarHint.textContent = t('app.errorShort', { message: err.message }); })
      .finally(function () { busy(false); });
  });

  deleteAvatar.addEventListener('click', function () {
    confirmDialog(t('settings.photoDeleteQ'), { okText: t('settings.photoDelete') }).then(function (ok) {
      if (!ok) return;
      busy(true);
      return send('/profile/avatar', { method: 'DELETE' })
        .then(function (data) {
          paintAvatar(data.avatar);
          tkText(avatarHint, 'settings.photoLimit');
        })
        .finally(function () { busy(false); });
    }).catch(function (err) { toast(t('app.deleteError', { message: err.message }), 'error'); });
  });

  // ── Удаление аккаунта ─────────────────────────────────────────────────
  // Подтверждение — пароль (у входа через Google его нет) и вопрос в диалоге:
  // отменить удаление нельзя, случайное нажатие стоит слишком дорого.
  var deleteForm = $('deleteForm');
  if (deleteForm) {
    deleteForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var pass = $('deletePassword');
      if (pass && !pass.value) return toast(t('settings.delete.needPassword'), 'error');
      confirmDialog(t('settings.delete.ask'), { okText: t('settings.delete.btn') }).then(function (yes) {
        if (!yes) return;
        send('/profile/delete', json(pass ? { password: pass.value } : {}))
          .then(function () { location.href = '/'; })
          .catch(function (err) {
            if (pass) pass.value = '';
            toast(t('app.errorPrefix', { message: err.message }), 'error');
          });
      });
    });
  }

  // ── Пароль ────────────────────────────────────────────────────────────
  var passwordForm = $('passwordForm');
  if (passwordForm) {
    passwordForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var fields = [$('oldPassword'), $('newPassword'), $('confirmPassword')];
      var v = fields.map(function (f) { return f.value; });
      if (!v[0] || !v[1] || !v[2]) return toast(t('app.passwordFields'), 'error');
      if (v[1] !== v[2]) return toast(t('app.passwordMismatch'), 'error');
      send('/update-password', json({ oldPassword: v[0], newPassword: v[1] }))
        .then(function () {
          fields.forEach(function (f) { f.value = ''; });
          toast(t('app.passwordSaved'), 'ok');
        })
        .catch(function (err) { toast(t('app.errorPrefix', { message: err.message }), 'error'); });
    });
  }
})();
