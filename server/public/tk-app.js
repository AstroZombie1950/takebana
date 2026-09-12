/* Каркас кабинета: шапка, левая панель, модальные окна, поиск и звонки.
 *
 * Раньше жил инлайном в header.ejs — 1537 строк в шаблоне, которые заново
 * прилетали с каждой страницей и не кэшировались. Из EJS сюда приходили
 * ровно два значения, они переехали в window.TK.
 *
 * Разметка модалок — views/partials/appModals.ejs, стили — css/app.css.
 */
var TK = window.TK || { userId: '', activeStreamId: '' };

// Подписи — из общего словаря (public/tk-i18n.js), он подключён выше в шапке.
// Этот файл без обёртки, его `var` попадает в window: поэтому именно ссылка
// на готовую функцию, а не обёртка вокруг window.t — обёртка присвоилась бы
// в window.t и вызывала бы саму себя. Заглушка — если словарь не загрузился:
// кабинет должен остаться рабочим.
var t = window.t || function () { return ''; };
// Текст, который переживает переключение языка: ключ остаётся на элементе.
var tkText = window.tkText || function () {};

// Мобильное меню
          document.addEventListener('DOMContentLoaded', () => {
  const mobileMenuButton = document.getElementById('mobileMenuButton');
  const mobileMenu = document.getElementById('mobileMenu');
  const closeMobileMenu = document.getElementById('closeMobileMenu');

  mobileMenuButton.addEventListener('click', () => {
    mobileMenu.classList.remove('hidden');
  });

  closeMobileMenu.addEventListener('click', () => {
    mobileMenu.classList.add('hidden');
  });

  mobileMenu.addEventListener('click', (e) => {
    if (e.target === mobileMenu) {
      mobileMenu.classList.add('hidden');
    }
  });
});

// Выпадающее меню профиля
document.addEventListener('DOMContentLoaded', () => {
  const avatarButton = document.getElementById('avatarButton');
  const profileDropdown = document.getElementById('profileDropdown');

  if (avatarButton && profileDropdown) {
    avatarButton.addEventListener('click', (e) => {
      e.stopPropagation();
      profileDropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!profileDropdown.contains(e.target) && !avatarButton.contains(e.target)) {
        profileDropdown.classList.add('hidden');
      }
    });
  }
});

// Выпадашка языка: открыть и закрыть. Сам перевод, подсветку кнопок, ярлык
// с текущим языком и закрытие после выбора делает общий переключатель
// (public/tk-i18n.js) — он один на кабинет и публичные страницы.
document.addEventListener('DOMContentLoaded', () => {
  const languageToggle = document.getElementById('languageToggle');
  const languageDropdown = document.getElementById('languageDropdown');

  if (!languageToggle || !languageDropdown) return;

  languageToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    languageDropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!languageDropdown.contains(e.target) && !languageToggle.contains(e.target)) {
      languageDropdown.classList.add('hidden');
    }
  });
});

// Безопасность в профиле
document.addEventListener('DOMContentLoaded', () => {
  const securityToggle = document.getElementById('securityToggle');
  const securityFields = document.getElementById('securityFields');

  securityToggle.addEventListener('click', () => {
    securityFields.classList.toggle('hidden');
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

// Модальные окна
document.addEventListener('DOMContentLoaded', () => {
  const modals = {
    streamSettings: document.getElementById('streamSettingsModal'),
    profileInfo: document.getElementById('profileInfoModal'),
    notification: document.getElementById('notificationModal')
  };

  const closeButtons = {
    streamSettings: document.getElementById('closeStreamModal'),
    profileInfo: document.getElementById('closeProfileModal'),
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

  // Открытие модальных окон
  const notificationButton = document.getElementById('notificationButton');
  const startStreamButtonHeader = document.getElementById('startStreamButtonHeader');

  if (notificationButton) {
    notificationButton.addEventListener('click', async () => {
      modals.notification.classList.remove('hidden');
      const notificationsContent = document.getElementById('notificationsContent');
      notificationsContent.innerHTML = `<p class="tk-note tk-note--center" data-i18n="modal.notifications.loading">${escapeHtml(t('modal.notifications.loading'))}</p>`;

      try {
              const response = await fetch("/api/notifications");
        if (!response.ok) throw new Error(t('modal.notifications.error'));

              const notifications = await response.json();

              if (notifications.length === 0) {
          notificationsContent.innerHTML = `<p class="tk-note tk-note--center" data-i18n="modal.notifications.empty">${escapeHtml(t('modal.notifications.empty'))}</p>`;
                return;
              }

        notificationsContent.innerHTML = notifications.map(notification => {
          const senderName = notification.sender?.login || notification.sender?.email || "неизвестный пользователь";
                const message = notification.content || t('modal.notifications.fallback');

                return `
            <article class="tk-notice">
              <div class="tk-notice__top">
                <h4 class="tk-notice__from">${escapeHtml(t('modal.notifications.from'))} ${escapeHtml(senderName)}</h4>
                <time class="tk-notice__when">${escapeHtml(new Date(notification.createdAt).toLocaleString())}</time>
              </div>
              <p class="tk-notice__text">${escapeHtml(message)}</p>
            </article>`;
        }).join("");
            } catch (error) {
              console.error("Ошибка:", error);
        notificationsContent.innerHTML = `<p class="tk-note tk-note--center tk-note--bad" data-i18n="modal.notifications.error">${escapeHtml(t('modal.notifications.error'))}</p>`;
      }
    });
  }

  // Открывашек настроек эфира две: кнопка в шапке и та же кнопка в мобильном
  // меню, где шапочной нет. Третья — в баннере левой панели, у неё свой скрипт.
  [startStreamButtonHeader, document.getElementById('startStreamButtonMenu')].forEach((btn) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      const menu = document.getElementById('mobileMenu');
      if (menu) menu.classList.add('hidden');
      modals.streamSettings.classList.remove('hidden');
    });
  });

  // Завершение активного стрима из модалки (кнопка в header.ejs)
  const terminateStreamButton = document.getElementById('terminateStreamButton');
  if (terminateStreamButton) {
    terminateStreamButton.addEventListener('click', async () => {
      const streamId = TK.activeStreamId;
      console.log('[terminate] click', { streamId });

      if (!streamId) {
        toast(t('app.streamUnknown'), 'error');
        return;
      }

      const ok = await confirmDialog(t('app.endStreamConfirm'), { okText: t('app.endStreamOk') });
      if (!ok) return;

      terminateStreamButton.disabled = true;
      const prevHtml = terminateStreamButton.innerHTML;
      terminateStreamButton.innerHTML = 'Завершаем...';

      try {
        const response = await fetch('/terminate-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ streamId })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          console.error('[terminate] failed', response.status, data);
          toast(data?.message || t('app.endStreamFailed'), 'error');
          return;
        }

        console.log('[terminate] success', data);
        // Закрываем модалку и обновляем страницу, чтобы пропал "активный стрим"
        if (modals.streamSettings) modals.streamSettings.classList.add('hidden');
        window.location.reload();
      } catch (e) {
        console.error('[terminate] exception', e);
        toast(t('app.endStreamNetwork'), 'error');
      } finally {
        terminateStreamButton.disabled = false;
        terminateStreamButton.innerHTML = prevHtml;
      }
    });
  }

  // Кнопка профиля в выпадающем меню
  const profileButton = document.getElementById('profileButton');
  const profileDropdown = document.getElementById('profileDropdown');
  if (profileButton && profileDropdown) {
    profileButton.addEventListener('click', () => {
      modals.profileInfo.classList.remove('hidden');
      profileDropdown.classList.add('hidden');
    });
  }
});

// Поиск
document.addEventListener('DOMContentLoaded', function() {
  const searchInput = document.getElementById('searchInput');
  const searchResults = document.getElementById('searchResults');
  const mobileSearchInput = document.getElementById('mobileSearchInput');
  const mobileSearchResults = document.getElementById('mobileSearchResults');

  // Функция поиска (общая для десктопа и мобильного)
  async function performSearch(query, resultsContainer) {
    if (!query) {
      resultsContainer.classList.add('hidden');
      resultsContainer.innerHTML = '';
      return;
    }

    try {
      const response = await fetch(`/search-users?q=${encodeURIComponent(query)}`);
      const users = await response.json();

      if (users.length > 0) {
        resultsContainer.classList.remove('hidden');
        resultsContainer.innerHTML = users.map(user => {
          // Исправляем градиент для аватарок - правильный формат
          let gradientStyle = '';
          if (user.avatarStyle && user.avatarStyle.gradient) {
            // Если градиент уже в правильном формате
            if (user.avatarStyle.gradient.includes('linear-gradient')) {
              gradientStyle = user.avatarStyle.gradient;
            } else {
              // Если градиент в старом формате, преобразуем
              gradientStyle = `linear-gradient(135deg, ${user.avatarStyle.gradient})`;
            }
          } else {
            // Дефолтный градиент
            gradientStyle = 'linear-gradient(135deg, #6366f1, #8b5cf6)';
          }
          
          const avatarHtml = user.avatarStyle?.url
            ? `<img class="tk-found__ava" src="${escapeHtml(user.avatarStyle.url)}" alt="" loading="lazy">`
            : `<div class="tk-found__ava" style="background: ${escapeHtml(gradientStyle)};">${escapeHtml(user.avatarStyle?.initial || user.displayName?.charAt(0)?.toUpperCase() || '?')}</div>`;
          
          return `
            <a href="/userPage/${encodeURIComponent(user._id)}" class="search-result-item" data-user-id="${escapeHtml(user._id)}" data-presence-user="${escapeHtml(user._id)}">
              ${avatarHtml}
              <span class="tk-found__body">
                <span class="tk-found__name">${escapeHtml(user.displayName || 'Безымянный')}</span>
                <span class="tk-found__meta">${escapeHtml(String(user.followersCount || 0))} подписчиков</span>
                <span class="tk-found__meta">
                  <span class="presence-dot"></span>
                  <span data-presence-text></span>
                </span>
              </span>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true"><path d="M9 5l7 7-7 7"></path></svg>
            </a>`;
        }).join('');
        
        // Добавляем обработчики кликов для результатов поиска
        addSearchResultClickHandlers(resultsContainer);
        // Инициализируем presence для новых результатов
        const ids = Array.from(resultsContainer.querySelectorAll('[data-presence-user]')).map(n => n.getAttribute('data-presence-user'));
        // Люди из поиска появились на экране только что — подписываемся и на них.
        if (window.subscribePresence) window.subscribePresence(ids.filter(Boolean));
        if (ids.length) {
          fetch('/api/presence?ids=' + encodeURIComponent(ids.join(',')))
            .then(r => r.json())
            .then(data => {
              (data.users || []).forEach(u => {
                // используем глобальную функцию, если доступна
                if (typeof window !== 'undefined') {
                  const ev = new CustomEvent('presence:init', { detail: u });
                  window.dispatchEvent(ev);
                }
              });
            })
            .catch(() => {});
        }
      } else {
        resultsContainer.classList.remove('hidden');
        resultsContainer.innerHTML = `
          <div class="tk-found__empty">
            <p class="tk-found__name">Ничего не найдено</p>
            <p class="tk-note">Попробуйте изменить поисковый запрос</p>
          </div>`;
      }
    } catch (error) {
      console.error('Ошибка поиска пользователей:', error);
    }
  }
  
  // Функция для добавления обработчиков кликов к результатам поиска
  function addSearchResultClickHandlers(resultsContainer) {
    // Убираем старые обработчики
    const existingItems = resultsContainer.querySelectorAll('.search-result-item');
    existingItems.forEach(item => {
      const newItem = item.cloneNode(true);
      item.parentNode.replaceChild(newItem, item);
    });
    
    // Добавляем новые обработчики
    const searchItems = resultsContainer.querySelectorAll('.search-result-item');
    searchItems.forEach(item => {
      item.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        const href = this.getAttribute('href');
        
        // Скрываем результаты поиска
        resultsContainer.classList.add('hidden');
        
        // Переходим на страницу пользователя
        setTimeout(() => {
          window.location.href = href;
        }, 100);
      });
      
      // Добавляем hover эффект
      item.addEventListener('mouseenter', function() {
        this.style.backgroundColor = '#f9fafb';
      });
      
      item.addEventListener('mouseleave', function() {
        this.style.backgroundColor = '';
      });
    });
  }

  // Обработчики для десктопного поиска
  if (searchInput && searchResults) {

    searchInput.addEventListener('input', async function() {
      const query = searchInput.value.trim();
      await performSearch(query, searchResults);
    });

    document.addEventListener('click', function(event) {
      if (!searchInput.contains(event.target) && !searchResults.contains(event.target)) {
        searchResults.classList.add('hidden');
      }
    });
  }

  // Обработчики для выдвижного мобильного поиска
  const mobileSearchToggle = document.getElementById('mobileSearchToggle');
  const mobileSearchBar = document.getElementById('mobileSearchBar');
  const mobileSearchField = document.getElementById('mobileSearchField');
  const closeMobileSearch = document.getElementById('closeMobileSearch');
  const mobileSearchFieldResults = document.getElementById('mobileSearchFieldResults');
  
  if (mobileSearchToggle && mobileSearchBar) {
    // Открытие поиска
    mobileSearchToggle.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      
      mobileSearchBar.classList.remove('hidden');
      if (mobileSearchField) mobileSearchField.focus();
    });
    
    // Закрытие поиска
    if (closeMobileSearch) {
      closeMobileSearch.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        closeMobileSearchBar();
      });
    }
    
    // Функция закрытия мобильного поиска
    function closeMobileSearchBar() {
      mobileSearchBar.classList.add('hidden');
      if (mobileSearchField) {
        mobileSearchField.value = '';
      }
      if (mobileSearchFieldResults) {
        mobileSearchFieldResults.classList.add('hidden');
      }
    }
    
    // Поиск в выдвижном поле
    if (mobileSearchField && mobileSearchFieldResults) {
      mobileSearchField.addEventListener('input', async function() {
        const query = mobileSearchField.value.trim();
        await performSearch(query, mobileSearchFieldResults);
      });
      
      // Предотвращаем закрытие при клике на поле поиска
      mobileSearchField.addEventListener('click', function(e) {
        e.stopPropagation();
      });
      
      // Предотвращаем закрытие при клике на результаты
      mobileSearchFieldResults.addEventListener('click', function(e) {
        e.stopPropagation();
      });
      
      // Закрытие поиска при нажатии Escape
      mobileSearchField.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
          closeMobileSearchBar();
        }
      });
      
      // Закрытие результатов при клике вне (но не закрываем весь поиск)
      document.addEventListener('click', function(event) {
        if (!mobileSearchBar.contains(event.target) && !mobileSearchToggle.contains(event.target)) {
          // Только скрываем результаты, но оставляем поле поиска открытым
          if (mobileSearchFieldResults) {
            mobileSearchFieldResults.classList.add('hidden');
          }
        }
      });
    }
  }
});

// Сохранение пароля
document.addEventListener('DOMContentLoaded', function() {
  const savePasswordButton = document.getElementById('savePasswordButton');
  const oldPasswordInput = document.getElementById('oldPassword');
  const newPasswordInput = document.getElementById('newPassword');
  const confirmPasswordInput = document.getElementById('confirmPassword');

  if (!savePasswordButton) return;

  savePasswordButton.addEventListener('click', async function(event) {
    event.preventDefault();

    const oldPassword = oldPasswordInput.value.trim();
    const newPassword = newPasswordInput.value.trim();
    const confirmPassword = confirmPasswordInput.value.trim();

    if (!oldPassword || !newPassword || !confirmPassword) {
      toast(t('app.passwordFields'), 'error');
      return;
    }

    if (newPassword !== confirmPassword) {
      toast(t('app.passwordMismatch'), 'error');
      return;
    }

    try {
      const response = await fetch('/update-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          oldPassword: oldPassword,
          newPassword: newPassword
        })
      });

      const result = await response.json();

      if (response.ok) {
        toast(t('app.passwordSaved'), 'ok');
        // Очищаем поля пароля
        oldPasswordInput.value = '';
        newPasswordInput.value = '';
        confirmPasswordInput.value = '';
        // Закрываем блок Security
        document.getElementById('securityFields').classList.add('hidden');
        window.location.reload();
      } else {
        toast(t('app.errorPrefix', { message: result.message || t('app.passwordFailed') }), 'error');
      }
    } catch (error) {
      console.error('Ошибка:', error);
      toast(t('app.passwordError'), 'error');
    }
  });
});

// Сохранение только имени
document.addEventListener('DOMContentLoaded', function() {
  const saveNameButton = document.getElementById('saveNameButton');
  const nameInput = document.getElementById('profileNameInput');

  if (!saveNameButton || !nameInput) return;

  saveNameButton.addEventListener('click', async function(event) {
    event.preventDefault();

    const newName = nameInput.value.trim();
    if (!newName) {
      toast(t('app.nameEmpty'), 'error');
      return;
    }

    try {
      const response = await fetch('/update-profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          login: newName
        })
      });

      const result = await response.json();

      if (response.ok) {
        toast(t('app.nameSaved'), 'ok');
        window.location.reload();
      } else {
        toast(t('app.errorPrefix', { message: result.message || t('app.nameFailed') }), 'error');
      }
    } catch (error) {
      console.error('Ошибка:', error);
      toast(t('app.nameError'), 'error');
    }
  });
});

// Запуск стрима
document.addEventListener('DOMContentLoaded', function() {
  const startStreamButton = document.getElementById('startStreamButton');
  const streamTitleInput = document.getElementById('streamTitle');
  const streamCategoryInput = document.getElementById('streamCategory');
  const streamSubcategoryInput = document.getElementById('streamSubcategory');
  const streamDescriptionInput = document.getElementById('streamDescription');
  const streamCityInput = document.getElementById('streamCity');
  const streamAdultInput = document.getElementById('streamAdult');

  if (!startStreamButton) return;

  startStreamButton.addEventListener('click', async function(event) {
    event.preventDefault();

    const title = streamTitleInput.value.trim();
    const category = streamCategoryInput.value;
    const subcategory = streamSubcategoryInput.value;
    const description = streamDescriptionInput.value.trim();

    if (!title || !category) {
      toast(t('app.startStreamFields'), 'error');
      return;
    }

    try {
      const response = await fetch('/start-stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          title,
          category,
          subcategory,
          description,
          city: streamCityInput ? streamCityInput.value : '',
          isAdult: !!(streamAdultInput && streamAdultInput.checked)
        })
      });

      const result = await response.json();

      if (response.ok) {
        window.location.href = `/stream/${result.streamId}`;
      } else {
        toast(t('app.errorPrefix', { message: result.message }), 'error');
      }
    } catch (error) {
      console.error('Ошибка при запуске трансляции:', error);
      toast(t('app.startStreamFailed'), 'error');
    }
  });
});

// Переход к сервису заведений
document.addEventListener('DOMContentLoaded', function() {
  const goMapButton = document.querySelector('.goMap');
  if (goMapButton) {
    goMapButton.addEventListener('click', function() {
      localStorage.setItem('targetService', 'service1');
    });
  }
});

// Подкатегории для стрима. Список приходит из config/catalog.js атрибутом
// data-subs: [[код, подпись], …] на каждую категорию. Подпись из атрибута —
// русская; на английском её отдаёт словарь по ключу sub.<код>, а data-i18n
// на созданной строке нужен, чтобы переключение языка её тоже подхватило.
document.addEventListener('DOMContentLoaded', function() {
  const categorySelect = document.getElementById('streamCategory');
  const subSelect = document.getElementById('streamSubcategory');
  if (!categorySelect || !subSelect) return;

  const subcategories = JSON.parse(subSelect.dataset.subs || '{}');

  categorySelect.addEventListener('change', function() {
    const subs = subcategories[this.value];
    subSelect.disabled = !subs;
    const firstKey = subs ? 'modal.stream.subcategoryPick' : 'modal.stream.subcategoryPh';
    const first = new Option(t(firstKey, subs ? 'Выберите подкатегорию' : 'Сначала выберите категорию'), '');
    first.setAttribute('data-i18n', firstKey);
    subSelect.replaceChildren(first, ...(subs || []).map(([code, name]) => {
      const option = new Option(t('sub.' + code, name), code);
      option.setAttribute('data-i18n', 'sub.' + code);
      return option;
    }));
  });
});

// Обработчик кнопки "Мой канал"
document.addEventListener('DOMContentLoaded', function() {
  const myChannelButton = document.querySelector('.myChannelButton');
  const myUid = TK.userId;
  if (myChannelButton) {
    myChannelButton.addEventListener('click', function() {
      if (myUid) {
        window.location.href = '/userPage/' + myUid;
      } else {
        console.error('Current user ID not found');
        toast(t('app.noUserId'), 'error');
      }
    });
  }
});

// Аватар: выбор, предпросмотр и загрузка
document.addEventListener('DOMContentLoaded', () => {
  const chooseBtn = document.getElementById('chooseAvatarBtn');
  const uploadBtn = document.getElementById('uploadAvatarBtn');
  const fileInput = document.getElementById('profileAvatarInput');
  const preview = document.getElementById('profileAvatarPreview');
  const empty = document.getElementById('profileAvatarEmpty');
  const hint = document.getElementById('avatarHint');

  if (!chooseBtn || !uploadBtn || !fileInput) return;

  chooseBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) { uploadBtn.disabled = true; return; }
    const valid = /image\/(png|jpeg)/.test(file.type) && file.size <= 5 * 1024 * 1024;
    if (!valid) {
      tkText(hint, 'app.fileBad');
      uploadBtn.disabled = true;
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      if (empty) empty.classList.add('hidden');
      preview.src = e.target.result;
      preview.classList.remove('hidden');
      uploadBtn.disabled = false;
    };
    reader.readAsDataURL(file);
  });

  uploadBtn.addEventListener('click', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    uploadBtn.disabled = true;
    tkText(hint, 'app.uploading');
    try {
      const form = new FormData();
      form.append('avatar', file);
      const res = await fetch('/profile/avatar', { method: 'POST', body: form });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Ошибка загрузки');
      
      // Обновляем превью в модалке
      if (empty) empty.classList.add('hidden');
      if (preview) {
        preview.src = data.url + '?t=' + Date.now(); // Добавляем timestamp для обхода кеша
        preview.classList.remove('hidden');
      }
      
      // Обновляем все аватары в хедере
      const headerAvatars = document.querySelectorAll('#avatarButton img, .avatar-tiny, [id*="avatar"] img');
      const avatarUrl = data.url + '?t=' + Date.now();
      headerAvatars.forEach(img => {
        if (img) img.src = avatarUrl;
      });
      
      // Обновляем аватары в выпадающем меню профиля
      const dropdownAvatars = document.querySelectorAll('#profileDropdown img');
      dropdownAvatars.forEach(img => {
        if (img) img.src = avatarUrl;
      });
      
      tkText(hint, 'app.photoDone');
      
      console.log('Аватар обновлен:', data.url);
      
      // Перезагружаем страницу через небольшую задержку, чтобы пользователь увидел сообщение
      setTimeout(() => {
        window.location.reload();
      }, 500);
    } catch (e) {
      console.error('Ошибка загрузки аватара:', e);
    hint.textContent = ((localStorage.getItem('lang') === 'en') ? 'Error: ' : 'Ошибка: ') + (e.message || ((localStorage.getItem('lang') === 'en') ? 'Failed to upload photo' : 'Не удалось загрузить фото'));
      uploadBtn.disabled = false;
    }
  });
});

// Галерея: превью и подготовка к загрузке (без отправки на сервер)
document.addEventListener('DOMContentLoaded', () => {
  const dz = document.getElementById('galleryDropzone');
  const input = document.getElementById('galleryInput');
  const chooseBtn = document.getElementById('chooseGalleryBtn');
  const uploadBtn = document.getElementById('uploadGalleryBtn');
  const countEl = document.getElementById('galleryCount');
  const hint = document.getElementById('galleryHint');
  const previewGrid = document.getElementById('galleryPreview');
  const persistedGrid = document.getElementById('galleryPersisted');
  let files = [];

  if (!dz || !input || !chooseBtn || !uploadBtn) return;

  function renderPreviews() {
    previewGrid.innerHTML = '';
    files.slice(0, 30).forEach((file, idx) => {
      const url = URL.createObjectURL(file);
      const item = document.createElement('div');
      item.className = 'tk-thumb';
      item.innerHTML = `
        <img src="${url}" alt="">
        <button type="button" data-idx="${idx}" class="tk-thumb__del" aria-label="Убрать">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"></path></svg>
        </button>`;
      previewGrid.appendChild(item);
    });
    countEl.textContent = String(files.length);
    uploadBtn.disabled = files.length === 0;
    hint.textContent = files.length
      ? ((localStorage.getItem('lang') === 'en') ? 'Ready to upload' : 'Готово к загрузке')
      : ((localStorage.getItem('lang') === 'en') ? 'No files selected' : 'Файлы не выбраны');
  }

  function addFiles(fileList) {
    const incoming = Array.from(fileList).filter(f => /image\/(png|jpeg)/.test(f.type) && f.size <= 10 * 1024 * 1024);
    files = [...files, ...incoming].slice(0, 30);
    renderPreviews();
  }

  chooseBtn.addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => addFiles(e.target.files || []));

  dz.addEventListener('click', () => input.click());
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('is-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('is-over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('is-over'); addFiles(e.dataTransfer.files || []); });

  previewGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-idx]');
    if (!btn) return;
    const idx = Number(btn.getAttribute('data-idx'));
    files.splice(idx, 1);
    renderPreviews();
  });

  uploadBtn.addEventListener('click', () => {
    if (!files.length) return;
    tkText(hint, 'app.uploading');
    uploadBtn.disabled = true;
    const form = new FormData();
    files.forEach(f => form.append('photos', f));
    fetch('/profile/gallery', { method: 'POST', body: form })
      .then(r => r.json())
      .then(data => {
        if (!data.success) throw new Error(data.message || 'Ошибка загрузки');
        // Очистим локальный список и обновим UI
        files = [];
        renderPreviews();
        tkText(hint, 'app.galleryDone', { total: data.total });
        // Добавим загруженные в persisted сетку
        if (persistedGrid && Array.isArray(data.urls)) {
          data.urls.forEach(url => {
            const name = (url || '').split('/').pop();
            const div = document.createElement('div');
            div.className = 'tk-thumb';
            div.innerHTML = `
              <img src="${escapeHtml(url)}" alt="" loading="lazy">
              <button type="button" data-name="${escapeHtml(name)}" class="tk-thumb__del" aria-label="Удалить">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"></path></svg>
              </button>`;
            persistedGrid.prepend(div);
          });
        }
      })
      .catch(e => {
        hint.textContent = t('app.errorShort', { message: e.message });
      })
      .finally(() => { uploadBtn.disabled = false; });
  });

  // Удаление из галереи (persisted)
  if (persistedGrid) {
    persistedGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-name]');
      if (!btn) return;
      const name = btn.getAttribute('data-name');
      btn.disabled = true;
      fetch('/profile/gallery/' + encodeURIComponent(name), { method: 'DELETE' })
        .then(r => r.json())
        .then(data => {
          if (!data.success) throw new Error(data.message || 'Ошибка удаления');
          const card = btn.closest('.group');
          if (card) card.remove();
        })
        .catch(err => { hint.textContent = t('app.deleteError', { message: err.message }); })
        .finally(() => { btn.disabled = false; });
    });
  }
});

// ===== Presence Client (глобально) =====
(function(){
  function initPresenceAndCalls(){
  try {
    if (typeof io !== 'function') return; // socket.io клиент должен быть подключен
    const socket = io(window.location.origin, { transports: ['websocket'] });
    window.callSocket = socket;
    console.log('[client] socket init');
    socket.on('connect', () => console.log('[client] socket connected id=', socket.id));
    socket.on('connect_error', (err) => console.error('[client] socket connect_error', err));
    socket.on('disconnect', (reason) => console.log('[client] socket disconnected', reason));

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
          textEl.title = lastSeen ? new Date(lastSeen).toLocaleString() : '';
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
        if (!key) lsEl.textContent = new Date(lastSeen).toLocaleString();
      });
    }

    socket.on('presence:update', ({ userId, isOnline, lastSeen }) => {
      if (!userId) return;
      setPresence(String(userId), !!isOnline, lastSeen);
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
    const closeCall = (callId) => (window.closeCall ? window.closeCall(callId) : false);

    async function startCall(calleeId, type) {
      try {
        const res = await fetch('/api/calls/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ calleeId, type }) });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || data.error || 'call_create_failed');
        window.currentCallId = data.callId;
        window.updateOutgoingCallStatus && window.updateOutgoingCallStatus('Ожидание ответа…');
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
      window.showIncomingCall && window.showIncomingCall({
        userId: from.userId,
        displayName: from.displayName,
        avatarUrl: from.avatarUrl,
        callType: type,
        onAccept: () => { window.currentCallId = callId; socket.emit('call:accept', { callId }); },
        onDecline: () => socket.emit('call:decline', { callId })
      });
    });

    // Разговор идёт в одной вкладке с каждой стороны: у звонящего — там, где
    // нажали «позвонить», у собеседника — там, где приняли. Остальные вкладки
    // в комнату на двоих не ломятся.
    socket.on('call:accepted', ({ callId, type, url, token }) => {
      if (callId !== window.currentCallId || window._call) return;
      window.startCallMedia && window.startCallMedia(callId, type, { url, token });
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
      window.updateOutgoingCallStatus && window.updateOutgoingCallStatus('Отклонено');
      setTimeout(() => window.hideOutgoingCall && window.hideOutgoingCall(), 1000);
    });
    socket.on('call:canceled', ({ callId }) => closeCall(callId));
    socket.on('call:ended', ({ callId }) => closeCall(callId));
    socket.on('call:timeout', ({ callId }) => {
      if (callId === window.currentCallId) window.updateOutgoingCallStatus && window.updateOutgoingCallStatus('Нет ответа');
      setTimeout(() => closeCall(callId), 800);
    });

    // Инициализация: подхватить присутствующие на странице id
    const ids = Array.from(document.querySelectorAll('[data-presence-user]'))
      .map(el => el.getAttribute('data-presence-user'))
      .filter(Boolean);
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

  const NET_LABEL = { good: 'хорошая', low: 'слабая', bad: 'плохая' };

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
    s.voice.setAttribute('aria-pressed', 'false');
    tkText(s.voice, 'call.voiceOnly');
  }

  // Окно переходит в разговор: «Отменить» и «Принять» становятся «Завершить»,
  // у видеозвонка рядом встаёт «Только голос».
  function goLive(s, isVideo) {
    s.stage.classList.toggle('hidden', !isVideo);
    s.stage.classList.add('tk-call__stage--empty', 'tk-call__stage--nolocal');
    s.voice.classList.toggle('hidden', !isVideo);
    s.actions.classList.toggle('tk-call__actions--pair', isVideo);
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
      else s.status.textContent = hadPeer ? 'Собеседник переподключается…' : 'Ждём собеседника…';
    }

    goLive(s, isVideo);
    paint();
    window._call = TKDaily.connect({
      send: true,
      video: isVideo,
      access: () => {
        if (!firstAccess) return window.requestCallToken(callId);
        const a = firstAccess;
        firstAccess = null;
        return Promise.resolve(a);
      },
      onTrack: (track, p, on) => {
        if (track.kind === 'video') {
          TKDaily.attach(p.local ? s.localVideo : s.remoteVideo, on && track);
          s.stage.classList.toggle(p.local ? 'tk-call__stage--nolocal' : 'tk-call__stage--empty', !on);
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
        s.net.setAttribute('aria-label', 'Сеть: ' + (NET_LABEL[n] || n));
        s.net.title = s.net.getAttribute('aria-label');
        s.net.classList.remove('hidden');
      }
    });
  };

  [OUT, IN].forEach((s) => s.voice.addEventListener('click', () => {
    if (!window._call) return;
    const on = s.voice.getAttribute('aria-pressed') !== 'true';
    window._call.setVoiceOnly(on);
    s.voice.setAttribute('aria-pressed', String(on));
    tkText(s.voice, on ? 'call.videoBack' : 'call.voiceOnly');
    s.stage.classList.toggle('hidden', on);
  }));

  function stopMedia() {
    if (window._call) { window._call.leave(); window._call = null; }
    clearInterval(window._callTick);
    [OUT, IN].forEach((s) => [s.remoteVideo, s.localVideo, s.remoteAudio].forEach((el) => TKDaily.attach(el, null)));
  }

  window.showOutgoingCall = function(opts){
    const displayName = opts && opts.displayName || 'Пользователь';
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
  window.updateOutgoingCallStatus = function(text){ OUT.status.textContent = text || ''; };
  window.hideOutgoingCall = function(){ outgoing.classList.add('hidden'); };

  function hideIncoming(){
    incoming.classList.add('hidden');
    inAccept.onclick = null; inDecline.onclick = null; inClose.onclick = null;
  }
  window.hideIncomingCall = hideIncoming;

  window.showIncomingCall = function(opts){
    const displayName = opts && opts.displayName || 'Пользователь';
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
