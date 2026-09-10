/* Каркас кабинета: шапка, левая панель, модальные окна, поиск и звонки.
 *
 * Раньше жил инлайном в header.ejs — 1537 строк в шаблоне, которые заново
 * прилетали с каждой страницей и не кэшировались. Из EJS сюда приходили
 * ровно два значения, они переехали в window.TK.
 *
 * Разметка модалок — views/partials/appModals.ejs, стили — css/app.css.
 */
var TK = window.TK || { userId: '', activeStreamId: '' };

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

// Переключатель языка
document.addEventListener('DOMContentLoaded', () => {
  const languageToggle = document.getElementById('languageToggle');
  const languageDropdown = document.getElementById('languageDropdown');

  if (!languageToggle || !languageDropdown) return;

  // Sync current label from localStorage (used by /lang.js)
  try {
    const saved = localStorage.getItem('lang');
    if (saved === 'ru' || saved === 'en') {
      const label = languageToggle.querySelector('span');
      if (label) label.textContent = saved.toUpperCase();
    }
  } catch (e) {}

  languageToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    languageDropdown.classList.toggle('hidden');
  });

  // Кнопки языка стоят в двух местах: выпадашка шапки и мобильное меню,
  // где их не видно на широком экране. Обработчик один на документ.
  function markCurrent(lang) {
    document.querySelectorAll('.tk-mmenu__lang [data-lang]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === lang));
    });
  }

  try { markCurrent(localStorage.getItem('lang') || 'ru'); } catch (e) {}

  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-lang]') : null;
    if (!btn) return;
    const next = btn.getAttribute('data-lang');
    if (next !== 'ru' && next !== 'en') return;

    try { localStorage.setItem('lang', next); } catch (e) {}
    if (typeof window.applyLang === 'function') window.applyLang(next);

    const label = languageToggle.querySelector('span');
    if (label) label.textContent = next.toUpperCase();
    markCurrent(next);
    languageDropdown.classList.add('hidden');
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
      notificationsContent.innerHTML = `<p class="tk-note tk-note--center" lng="249">${escapeHtml(t('249'))}</p>`;

      try {
              const response = await fetch("/api/notifications");
        if (!response.ok) throw new Error(t('250'));

              const notifications = await response.json();

              if (notifications.length === 0) {
          notificationsContent.innerHTML = `<p class="tk-note tk-note--center" lng="251">${escapeHtml(t('251'))}</p>`;
                return;
              }

        notificationsContent.innerHTML = notifications.map(notification => {
          const senderName = notification.sender?.login || notification.sender?.email || "неизвестный пользователь";
                const message = notification.content || t('252');

                return `
            <article class="tk-notice">
              <div class="tk-notice__top">
                <h4 class="tk-notice__from">${escapeHtml(t('253'))} ${escapeHtml(senderName)}</h4>
                <time class="tk-notice__when">${escapeHtml(new Date(notification.createdAt).toLocaleString())}</time>
              </div>
              <p class="tk-notice__text">${escapeHtml(message)}</p>
            </article>`;
        }).join("");
            } catch (error) {
              console.error("Ошибка:", error);
        notificationsContent.innerHTML = `<p class="tk-note tk-note--center tk-note--bad" lng="250">${escapeHtml(t('250'))}</p>`;
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
        toast('Не удалось определить активный стрим. Обновите страницу.', 'error');
        return;
      }

      const ok = await confirmDialog('Завершить стрим? Он будет удалён.', { okText: 'Завершить' });
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
          toast(data?.message || 'Ошибка завершения стрима', 'error');
          return;
        }

        console.log('[terminate] success', data);
        // Закрываем модалку и обновляем страницу, чтобы пропал "активный стрим"
        if (modals.streamSettings) modals.streamSettings.classList.add('hidden');
        window.location.reload();
      } catch (e) {
        console.error('[terminate] exception', e);
        toast('Ошибка сети при завершении стрима', 'error');
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
      toast('Пожалуйста, заполните все поля для смены пароля.', 'error');
      return;
    }

    if (newPassword !== confirmPassword) {
      toast('Новый пароль и подтверждение не совпадают.', 'error');
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
        toast('Пароль успешно обновлен!', 'ok');
        // Очищаем поля пароля
        oldPasswordInput.value = '';
        newPasswordInput.value = '';
        confirmPasswordInput.value = '';
        // Закрываем блок Security
        document.getElementById('securityFields').classList.add('hidden');
        window.location.reload();
      } else {
        toast('Ошибка: ' + (result.message || 'Не удалось обновить пароль'), 'error');
      }
    } catch (error) {
      console.error('Ошибка:', error);
      toast('Ошибка при обновлении пароля', 'error');
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
      toast('Пожалуйста, введите имя', 'error');
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
        toast('Имя успешно обновлено!', 'ok');
        window.location.reload();
      } else {
        toast('Ошибка: ' + (result.message || 'Не удалось обновить имя'), 'error');
      }
    } catch (error) {
      console.error('Ошибка:', error);
      toast('Ошибка при обновлении имени', 'error');
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
      toast('Пожалуйста, заполните название и категорию трансляции.', 'error');
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
        toast(`Ошибка: ${result.message}`, 'error');
      }
    } catch (error) {
      console.error('Ошибка при запуске трансляции:', error);
      toast('Произошла ошибка при запуске трансляции. Пожалуйста, попробуйте снова.', 'error');
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
// data-subs: [[код, подпись], …] на каждую категорию.
document.addEventListener('DOMContentLoaded', function() {
  const categorySelect = document.getElementById('streamCategory');
  const subSelect = document.getElementById('streamSubcategory');
  if (!categorySelect || !subSelect) return;

  const subcategories = JSON.parse(subSelect.dataset.subs || '{}');

  categorySelect.addEventListener('change', function() {
    const subs = subcategories[this.value];
    subSelect.disabled = !subs;
    subSelect.replaceChildren(
      new Option(subs ? 'Выберите подкатегорию' : 'Сначала выберите категорию', ''),
      ...(subs || []).map(([code, name]) => new Option(name, code))
    );
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
        toast('Ошибка: не удалось найти ID пользователя', 'error');
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
      hint.textContent = 'Неверный формат или размер файла';
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
    hint.textContent = 'Загрузка...';
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
      
      hint.textContent = 'Готово! Фото загружено';
      
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
    hint.textContent = 'Загрузка...';
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
        hint.textContent = `Загружено. Всего фото: ${data.total}`;
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
        hint.textContent = 'Ошибка: ' + e.message;
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
        .catch(err => { hint.textContent = 'Ошибка удаления: ' + err.message; })
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
      const getUILang = () => {
        try {
          const v = localStorage.getItem('lang');
          return (v === 'en' || v === 'ru') ? v : 'ru';
        } catch (e) {
          return 'ru';
        }
      };
      const t = (key, fallbackRu, fallbackEn) => {
        const l = getUILang();
        try {
          if (window.langDict && window.langDict[key] && typeof window.langDict[key][l] !== 'undefined') {
            return window.langDict[key][l];
          }
        } catch (e) {}
        return l === 'en' ? fallbackEn : fallbackRu;
      };

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
          textEl.textContent = online ? t('159', 'онлайн', 'online') : t('160', 'оффлайн', 'offline');
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
        lsEl.textContent = online ? t('178', 'Сейчас', 'Now') : (lastSeen ? new Date(lastSeen).toLocaleString() : t('179', '—', '—'));
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

    // ===== Calls client bindings =====
    window.startAudioCall = async function(calleeId){
      try {
        window._callType = 'audio';
        const res = await fetch('/api/calls/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ calleeId, type: 'audio' }) });
        const data = await res.json();
        console.log('[client] startAudioCall response', data);
        if (!data.success) throw new Error(data.error || 'call_create_failed');
        window.currentCallId = data.callId;
        window.updateOutgoingCallStatus && window.updateOutgoingCallStatus('Ожидание ответа…');
      } catch (e) {
        console.error('[client] startAudioCall error', e);
        toast('Не удалось начать звонок: ' + e.message, 'error');
      }
    };

    window.startVideoCall = async function(calleeId){
      try {
        window._callType = 'video';
        const res = await fetch('/api/calls/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ calleeId, type: 'video' }) });
        const data = await res.json();
        console.log('[client] startVideoCall response', data);
        if (!data.success) throw new Error(data.error || 'call_create_failed');
        window.currentCallId = data.callId;
        window.updateOutgoingCallStatus && window.updateOutgoingCallStatus('Ожидание ответа…');
      } catch (e) {
        console.error('[client] startVideoCall error', e);
        toast('Не удалось начать звонок: ' + e.message, 'error');
      }
    };

    socket.on('incoming_call', ({ callId, type, from, daily }) => {
      console.log('[client] incoming_call', { callId, type, from, daily });
      if (!from) return;
      window._incomingCallType = type;
      window._callType = type;
      window.showIncomingCall && window.showIncomingCall({
        userId: from.userId,
        displayName: from.displayName,
        avatarUrl: from.avatarUrl,
        callType: type,
        onAccept: () => socket.emit('call:accept', { callId }),
        onDecline: () => socket.emit('call:decline', { callId })
      });
      window.pendingDaily = daily || null;
    });

    socket.on('call:accepted', async ({ callId, daily }) => {
      console.log('[client] call:accepted', callId);
      window.updateOutgoingCallStatus && window.updateOutgoingCallStatus('Соединение установлено');
      window.currentCallId = callId;
      try {
        if (typeof window.DailyIframe === 'undefined') {
          const s = document.createElement('script');
          s.src = 'https://unpkg.com/@daily-co/daily-js@0.83.1/dist/daily-iframe.js';
          document.head.appendChild(s);
          await new Promise(r => { s.onload = r; s.onerror = r; });
        }
        const d = daily || window.pendingDaily || {};
        if (d && (d.roomUrl || d.roomName)) {
          // Предпочитаем roomUrl, присланный сервером (он уже содержит правильный daily subdomain).
          // Fallback оставляем на исторический домен, чтобы ребрендинг не ломал звонки.
          const url = d.roomUrl || `https://webcatravel.daily.co/${d.roomName}`;
          window._audioCallObject = window.DailyIframe.createCallObject();
          await window._audioCallObject.join({ url });
          // Тип вызова (для обоих сторон)
          const wantVideo = (window._callType === 'video');
          // Включим echoCancellation/noiseSuppression на локальном аудио
          try {
            const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
            const track = mic.getAudioTracks()[0];
            const devId = track && track.getSettings && track.getSettings().deviceId;
            if (devId && window._audioCallObject.setInputDevicesAsync) {
              await window._audioCallObject.setInputDevicesAsync({ audioDeviceId: devId });
            }
            try { mic.getTracks().forEach(t => t.stop()); } catch(_) {}
          } catch(e) { console.warn('getUserMedia with echo cancel failed', e); }
          await window._audioCallObject.setLocalVideo(!!wantVideo);
          await window._audioCallObject.setLocalAudio(true);
          // Постараемся разблокировать воспроизведение на iOS/Safari
          async function unlockAudio(){
            try { await window._audioCallObject.startAudio(); console.log('[client] startAudio ok'); return true; } catch(e){ console.warn('[client] startAudio failed', e); return false; }
          }
          const ok = await unlockAudio();
          if (!ok) {
            const handler = async () => { await unlockAudio(); document.removeEventListener('click', handler, true); };
            document.addEventListener('click', handler, true);
          }
          console.log('[client] daily joined', wantVideo ? 'video' : 'audio');
          // Видео контейнеры (показываем, если видеозвонок)
          function setVideoVisible(visible){
            const ov = document.getElementById('outgoingVideos');
            const iv = document.getElementById('incomingVideos');
            if (ov) ov.classList.toggle('hidden', !visible);
            if (iv) iv.classList.toggle('hidden', !visible);
          }
          setVideoVisible(!!wantVideo);
          const oa = document.getElementById('outgoingAudioUI');
          const ia = document.getElementById('incomingAudioUI');
          if (oa) oa.classList.remove('hidden');
          if (ia) ia.classList.remove('hidden');
          // Привязка треков к <video>
          function bindTrackToVideo(videoEl, track, muted){
            if (!videoEl) return;
            if (track) {
              const ms = new MediaStream();
              ms.addTrack(track);
              try { videoEl.srcObject = ms; } catch(e) {}
              try { videoEl.muted = !!muted; } catch(e) {}
              try { videoEl.playsInline = true; videoEl.setAttribute('playsinline',''); } catch(e) {}
              try { videoEl.play().catch(()=>{}); } catch(e) {}
            }
          }
          function updateVideoElements(){
            try {
              const parts = window._audioCallObject.participants();
              const local = Object.values(parts||{}).find(p => p.local);
              const remote = Object.values(parts||{}).find(p => !p.local);
              const localTrack = (local && (local.tracks && local.tracks.video && local.tracks.video.track)) || local?.videoTrack || null;
              const remoteTrack = (remote && (remote.tracks && remote.tracks.video && remote.tracks.video.track)) || remote?.videoTrack || null;
              bindTrackToVideo(document.getElementById('outLocalVideo'), localTrack, true);
              bindTrackToVideo(document.getElementById('inLocalVideo'), localTrack, true);
              bindTrackToVideo(document.getElementById('outRemoteVideo'), remoteTrack, false);
              bindTrackToVideo(document.getElementById('inRemoteVideo'), remoteTrack, false);
            } catch(e) {}
          }
          if (wantVideo) {
            updateVideoElements();
            window._audioCallObject.on('participant-joined', updateVideoElements);
            window._audioCallObject.on('participant-updated', updateVideoElements);
            window._audioCallObject.on('participant-left', updateVideoElements);
          }
          // Участники
          function renderParticipants(){
            try {
              const participants = window._audioCallObject.participants();
              const list = Object.values(participants || {}).map(p => p.info?.user_name || (p.local ? 'Вы' : 'Гость')).filter(Boolean);
              const txt = 'Участники: ' + list.join(', ');
              const oP = document.getElementById('outgoingParticipants');
              const iP = document.getElementById('incomingParticipants');
              if (oP) { oP.textContent = txt; oP.classList.remove('hidden'); }
              if (iP) { iP.textContent = txt; iP.classList.remove('hidden'); }
            } catch(e) {}
          }
          renderParticipants();
          window._audioCallObject.on('participant-joined', renderParticipants);
          window._audioCallObject.on('participant-left', renderParticipants);
          window._audioCallObject.on('participant-updated', renderParticipants);
          // уровни аудио убраны
          // Диагностика аудио: разрешения, девайсы, треки
          async function audioDiagnostics(){
            try {
              const perms = navigator.permissions && navigator.permissions.query ? await navigator.permissions.query({ name: 'microphone' }) : null;
              const devices = await navigator.mediaDevices.enumerateDevices();
              const parts = window._audioCallObject.participants();
              const me = Object.values(parts||{}).find(p => p.local);
              const other = Object.values(parts||{}).find(p => !p.local);
              const outA = document.getElementById('outRemoteAudio');
              const inA = document.getElementById('inRemoteAudio');
              const sinkSupported = !!(HTMLMediaElement.prototype && HTMLMediaElement.prototype.setSinkId);
              const diag = {
                permissionState: perms && perms.state || 'unknown',
                devices: devices.map(d => ({ kind: d.kind, label: d.label, deviceId: d.deviceId, groupId: d.groupId })),
                localHasAudio: !!(me && (me.tracks && me.tracks.audio && me.tracks.audio.state === 'playable')), 
                remoteHasAudio: !!(other && (other.tracks && other.tracks.audio && other.tracks.audio.state === 'playable')),
                localAudioEnabled: !!(me && me.audio),
                remoteAudioEnabled: !!(other && other.audio),
                output: {
                  sinkApiSupported: sinkSupported,
                  outElementVolume: outA ? outA.volume : null,
                  inElementVolume: inA ? inA.volume : null,
                  // sinkId is readable in Chromium; Safari does not expose
                  outSinkId: (outA && 'sinkId' in outA) ? outA.sinkId : null,
                  inSinkId: (inA && 'sinkId' in inA) ? inA.sinkId : null,
                }
              };
              console.log('[audio] diagnostics', diag);
              const oDbg = document.getElementById('outAudioDebug');
              const iDbg = document.getElementById('inAudioDebug');
              if (oDbg) { oDbg.textContent = JSON.stringify(diag, null, 2); oDbg.classList.remove('hidden'); }
              if (iDbg) { iDbg.textContent = JSON.stringify(diag, null, 2); iDbg.classList.remove('hidden'); }
            } catch(e) { console.warn('audioDiagnostics failed', e); }
          }
          // диагностика убрана
          // Привязка remote audio к <audio>
          function updateAudioElements(){
            try {
              const parts = window._audioCallObject.participants();
              const remote = Object.values(parts||{}).find(p => !p.local);
              const remoteTrack = (remote && (remote.tracks && remote.tracks.audio && remote.tracks.audio.track)) || remote?.audioTrack || null;
              const outA = document.getElementById('outRemoteAudio');
              const inA = document.getElementById('inRemoteAudio');
              if (remoteTrack) {
                const ms = new MediaStream();
                ms.addTrack(remoteTrack);
                // Отдаём звук только в видимую модалку
                const outgoingVisible = document.getElementById('outgoingCallModal') && !document.getElementById('outgoingCallModal').classList.contains('hidden');
                const incomingVisible = document.getElementById('incomingCallModal') && !document.getElementById('incomingCallModal').classList.contains('hidden');
                if (outA) { outA.srcObject = null; }
                if (inA) { inA.srcObject = null; }
                const tuneOutput = async (el) => {
                  if (!el) return;
                  try {
                    // На поддерживаемых браузерах выведем на коммуникационное устройство
                    if (typeof el.setSinkId === 'function') {
                      const devices = await navigator.mediaDevices.enumerateDevices();
                      const outs = devices.filter(d => d.kind === 'audiooutput');
                      const pref = outs.find(d => /communications|headset|earpiece/i.test(d.label));
                      if (pref) { await el.setSinkId(pref.deviceId); }
                    }
                  } catch(_) {}
                  try { el.volume = (window._callType === 'audio') ? 0.7 : 1.0; } catch(_) {}
                };
                if (outgoingVisible && outA) { try { outA.srcObject = ms; outA.muted = false; outA.play().catch(()=>{}); tuneOutput(outA); } catch(e){} }
                else if (incomingVisible && inA) { try { inA.srcObject = ms; inA.muted = false; inA.play().catch(()=>{}); tuneOutput(inA); } catch(e){} }
              }
            } catch(e) {}
          }
          updateAudioElements();
          window._audioCallObject.on('participant-joined', updateAudioElements);
          window._audioCallObject.on('participant-updated', updateAudioElements);
          window._audioCallObject.on('participant-left', () => {
            updateAudioElements();
            // если удалённый участник ушёл — закрыть обе модалки и очистить состояние
            try {
              const parts = window._audioCallObject.participants();
              const hasRemote = Object.values(parts||{}).some(p => !p.local);
              if (!hasRemote) {
                window.hideIncomingCall && window.hideIncomingCall();
                window.hideOutgoingCall && window.hideOutgoingCall();
                if (window._audioCallObject){ window._audioCallObject.leave(); window._audioCallObject.destroy(); window._audioCallObject=null; }
                clearInterval(window._callTick);
                window.currentCallId = null;
              }
            } catch(e){}
          });

          // Кнопки разблокировки аудио (для iOS/Safari)
          // тихая попытка включить аудио без UI
          try { await window._audioCallObject.startAudio(); } catch(e) {}
          // уровни не отображаем
          // Переведём исходящую кнопку в “Завершить”
          const btn = document.getElementById('outgoingCancelBtn');
          if (btn) { btn.textContent = 'Завершить'; btn.classList.remove('tk-btn--danger'); btn.classList.add('tk-btn--mute'); }
          // Назначим завершение звонка на кнопку
          if (btn) {
            btn.onclick = function(){ endCallLocal(); };
          }
          // Преобразуем входящую модалку в активный звонок
          const iS = document.getElementById('incomingStatus');
          if (iS) iS.textContent = 'Соединение установлено';
          const iT = document.getElementById('incomingTimer');
          if (iT) iT.classList.remove('hidden');
          const acc = document.getElementById('incomingAcceptBtn');
          const dec = document.getElementById('incomingDeclineBtn');
          const cls = document.getElementById('incomingCloseBtn');
          if (acc) {
            acc.disabled = false; acc.textContent = 'Завершить';
            acc.classList.remove('tk-btn--ok');
            acc.classList.add('tk-btn--mute');
            // «Отклонить» скрывается — кнопка остаётся одна на всю ширину
            acc.parentElement.classList.remove('tk-call__actions--pair');
            acc.onclick = function(){ endCallLocal(); };
          }
          if (dec) { dec.classList.add('hidden'); }
          if (cls) { cls.classList.add('hidden'); }
        }
      } catch (e) {
        console.error('[client] daily join error', e);
      }
      try {
        // Показать таймер и статус
        const oT = document.getElementById('outgoingTimer');
        const iT = document.getElementById('incomingTimer');
        const iS = document.getElementById('incomingStatus');
        if (oT) oT.classList.remove('hidden');
        if (iT) iT.classList.remove('hidden');
        if (iS) iS.textContent = 'Соединение установлено';
        let sec = 0; clearInterval(window._callTick);
        window._callTick = setInterval(() => {
          sec++; const mm = String(Math.floor(sec/60)).padStart(2,'0'); const ss = String(sec%60).padStart(2,'0');
          if (oT && !oT.classList.contains('hidden')) oT.textContent = mm+':'+ss;
          if (iT && !iT.classList.contains('hidden')) iT.textContent = mm+':'+ss;
        }, 1000);
      } catch(e){}
    });
    socket.on('call:declined', ({ callId }) => {
      console.log('[client] call:declined', callId);
      window.updateOutgoingCallStatus && window.updateOutgoingCallStatus('Отклонено');
      setTimeout(() => window.hideOutgoingCall && window.hideOutgoingCall(), 1000);
      if (window.currentCallId === callId) window.currentCallId = null;
    });
    socket.on('call:canceled', ({ callId }) => {
      console.log('[client] call:canceled', callId);
      window.hideIncomingCall && window.hideIncomingCall();
      if (window.currentCallId === callId) window.currentCallId = null;
      if (window._audioCallObject) { try { window._audioCallObject.leave(); window._audioCallObject.destroy(); } catch(e){} window._audioCallObject=null; }
      try { clearInterval(window._callTick); } catch(e){}
    });
    socket.on('call:ended', ({ callId }) => {
      console.log('[client] call:ended', callId);
      window.hideIncomingCall && window.hideIncomingCall();
      window.hideOutgoingCall && window.hideOutgoingCall();
      if (window.currentCallId === callId) window.currentCallId = null;
      if (window._audioCallObject) { try { window._audioCallObject.leave(); window._audioCallObject.destroy(); } catch(e){} window._audioCallObject=null; }
      try { clearInterval(window._callTick); } catch(e){}
    });
    socket.on('call:timeout', ({ callId }) => {
      console.log('[client] call:timeout', callId);
      window.updateOutgoingCallStatus && window.updateOutgoingCallStatus('Нет ответа');
      // Закрываем обе модалки на всякий случай
      setTimeout(() => {
        window.hideOutgoingCall && window.hideOutgoingCall();
        window.hideIncomingCall && window.hideIncomingCall();
      }, 200);
      if (window.currentCallId === callId) window.currentCallId = null;
      if (window._audioCallObject) { try { window._audioCallObject.leave(); window._audioCallObject.destroy(); } catch(e){} window._audioCallObject=null; }
      try { clearInterval(window._callTick); } catch(e){}
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

// Глобальные помощники модалок звонков
document.addEventListener('DOMContentLoaded', function(){
  const outgoing = document.getElementById('outgoingCallModal');
  const outName = document.getElementById('outgoingName');
  const outType = document.getElementById('outgoingType');
  const outStatus = document.getElementById('outgoingStatus');
  const outAvatar = document.getElementById('outgoingAvatar');
  const outClose = document.getElementById('outgoingCloseBtn');
  const outCancel = document.getElementById('outgoingCancelBtn');

  const incoming = document.getElementById('incomingCallModal');
  const inName = document.getElementById('incomingName');
  const inType = document.getElementById('incomingType');
  const inAvatar = document.getElementById('incomingAvatar');
  const inClose = document.getElementById('incomingCloseBtn');
  const inDecline = document.getElementById('incomingDeclineBtn');
  const inAccept = document.getElementById('incomingAcceptBtn');

  function renderAvatar(el, url, name){
    if (!el) return;
    el.innerHTML = '';
    if (url) {
      el.innerHTML = '<img src="' + escapeHtml(url) + '" alt="">';
    } else {
      el.textContent = name ? name.charAt(0).toUpperCase() : '?';
    }
  }

  window.showOutgoingCall = function(opts){
    if (!outgoing) return;
    const displayName = opts && opts.displayName || 'Пользователь';
    const avatarUrl = opts && opts.avatarUrl || '';
    const callType = opts && opts.callType || 'video';
    outName.textContent = displayName;
    outType.textContent = callType === 'audio' ? 'Исходящий аудиозвонок' : 'Исходящий видеозвонок';
    outStatus.textContent = 'Соединение...';
    renderAvatar(outAvatar, avatarUrl, displayName);
    outgoing.classList.remove('hidden');
    // сброс таймера
    const t = document.getElementById('outgoingTimer');
    if (t) { t.textContent = '00:00'; t.classList.add('hidden'); }
    // В состоянии дозвона кнопка = Отменить
    const btn = document.getElementById('outgoingCancelBtn');
    if (btn) { btn.textContent = 'Отменить'; btn.classList.remove('tk-btn--mute'); btn.classList.add('tk-btn--danger'); }
  };
  window.updateOutgoingCallStatus = function(text){ if (outStatus) outStatus.textContent = text || ''; };
  window.hideOutgoingCall = function(){
    if (outgoing){
      outgoing.classList.add('hidden');
    }
    // При скрытии исходящей модалки — стоп её <audio>
    try { const a = document.getElementById('outRemoteAudio'); if (a) a.srcObject = null; } catch(e){}
  };

  function hideIncoming(){
    if (incoming){
      incoming.classList.add('hidden');
      inAccept.onclick=null; inDecline.onclick=null; inClose.onclick=null;
    }
    // При скрытии входящей модалки — стоп её <audio>
    try { const a = document.getElementById('inRemoteAudio'); if (a) a.srcObject = null; } catch(e){}
  }
  window.showIncomingCall = function(opts){
    if (!incoming) return;
    const displayName = opts && opts.displayName || 'Пользователь';
    const avatarUrl = opts && opts.avatarUrl || '';
    const callType = opts && opts.callType || 'video';
    const onAccept = opts && opts.onAccept;
    const onDecline = opts && opts.onDecline;
    inName.textContent = displayName;
    inType.textContent = callType === 'audio' ? 'Входящий аудиозвонок' : 'Входящий видеозвонок';
    renderAvatar(inAvatar, avatarUrl, displayName);
    // Reset UI state to initial (new call)
    try {
      window.pendingDaily = null;
      const st = document.getElementById('incomingStatus');
      const it = document.getElementById('incomingTimer');
      const ip = document.getElementById('incomingParticipants');
      const acc = document.getElementById('incomingAcceptBtn');
      const dec = document.getElementById('incomingDeclineBtn');
      const cls = document.getElementById('incomingCloseBtn');
      if (st) st.textContent = 'Звонит...';
      if (it) { it.textContent = '00:00'; it.classList.add('hidden'); }
      if (ip) { ip.textContent = ''; ip.classList.add('hidden'); }
      if (acc) {
        acc.disabled = false; acc.textContent = 'Принять';
        acc.classList.remove('tk-btn--mute');
        acc.classList.add('tk-btn--ok');
        acc.parentElement.classList.add('tk-call__actions--pair');
      }
      if (dec) { dec.disabled = false; dec.classList.remove('hidden'); }
      if (cls) { cls.disabled = false; cls.classList.remove('hidden'); }
    } catch(e) {}
    incoming.classList.remove('hidden');
    inAccept.onclick = function(){
      try {
        // UI: сообщим пользователю, что идёт подключение
        const st = document.getElementById('incomingStatus');
        if (st) st.textContent = 'Подключаемся...';
        const it = document.getElementById('incomingTimer');
        if (it) it.classList.add('hidden');
        inAccept.disabled = true; inDecline.disabled = true; inClose.disabled = true;
        onAccept && onAccept();
      } catch(e) {}
      // не закрываем, ждём call:accepted
    };
    inDecline.onclick = function(){ try{ onDecline && onDecline(); }catch(e){} hideIncoming(); };
    inClose.onclick = function(){ try{ onDecline && onDecline(); }catch(e){} hideIncoming(); };
  };
  // Экспортируем хелпер для внешних событий (cancel/timeout)
  window.hideIncomingCall = hideIncoming;

  function endCallLocal(){
    try { if (window.callSocket && window.currentCallId) window.callSocket.emit('call:end', { callId: window.currentCallId }); } catch(e){}
    window.hideIncomingCall && window.hideIncomingCall();
    window.hideOutgoingCall && window.hideOutgoingCall();
    try { if (window._audioCallObject){ window._audioCallObject.leave(); window._audioCallObject.destroy(); window._audioCallObject=null; } } catch(e){}
    try { clearInterval(window._callTick); } catch(e){}
    window.currentCallId = null;
  }
  window.endCallLocal = endCallLocal;

  if (outClose) outClose.addEventListener('click', function(){
    try { if (window.callSocket && window.currentCallId) window.callSocket.emit('call:cancel', { callId: window.currentCallId }); } catch(e) {}
    window.hideOutgoingCall();
    window.currentCallId = null;
  });
  if (outCancel) outCancel.addEventListener('click', function(){
    try { if (window.callSocket && window.currentCallId) window.callSocket.emit('call:cancel', { callId: window.currentCallId }); } catch(e) {}
    window.hideOutgoingCall();
    window.currentCallId = null;
  });
});

// ... existing code ...
