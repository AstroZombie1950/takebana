/* Переписка: список диалогов, лента сообщений, отправка.
 *
 * Раньше жил инлайном в chatsPage.ejs — 722 строки. Ни одной вставки EJS
 * там не было, поэтому файл переехал целиком.
 *
 * Что убрано при переносе:
 *   — Первая из двух функций selectConversation. Их было две подряд, вторая
 *     перекрывала первую, и первая не выполнялась никогда.
 *   — Блок переменных от старой шапки: .profile__box, .AVATAR, .button__exit,
 *     .shodow, .serh-button и ещё дюжина. Этих элементов нет в разметке
 *     со дня переверстки шапки, все обработчики висели вхолостую.
 *   — Полтора десятка отладочных console.log.
 */

var loadedMessages = [];
var offset = 0;
var lastMessageTimestamp = null;
var loadingOldMessages = false;
var currentRecipientId = null;
var currentRecipientName = '';
var currentRecipientAvatar = '';
var messageCheckInterval = null;
var feedScrollHandler = null;

// Подпись из словаря с запасным вариантом: lang.js подключается после этого
// файла, поэтому на момент разбора его ещё нет, а на момент клика — уже есть.
function t(key, ru, en) {
  var lang = 'ru';
  try {
    var v = localStorage.getItem('lang');
    if (v === 'en' || v === 'ru') lang = v;
  } catch (e) {}
  try {
    if (window.langDict && window.langDict[key] && typeof window.langDict[key][lang] !== 'undefined') {
      return window.langDict[key][lang];
    }
  } catch (e) {}
  return lang === 'en' ? en : ru;
}

function uiLang() {
  try {
    var v = localStorage.getItem('lang');
    if (v === 'en' || v === 'ru') return v;
  } catch (e) {}
  return 'ru';
}

function feed() { return document.getElementById('feed'); }

// Дата и время сообщения — в локали интерфейса. По умолчанию toLocaleString
// берёт локаль браузера, и на русской странице выходило «9/9/2026, 10:04 AM».
function when(value) {
  var lang = uiLang();
  return new Date(value).toLocaleString(lang === 'en' ? 'en-US' : 'ru-RU');
}

// «5 минут назад» вместо серверного «5 minutes ago»: сервер не знает языка
// интерфейса, он живёт в localStorage.
var AGO = {
  ru: { s: ['секунду', 'секунды', 'секунд'], m: ['минуту', 'минуты', 'минут'],
        h: ['час', 'часа', 'часов'], d: ['день', 'дня', 'дней'],
        mo: ['месяц', 'месяца', 'месяцев'], y: ['год', 'года', 'лет'] },
  en: { s: ['second', 'seconds'], m: ['minute', 'minutes'], h: ['hour', 'hours'],
        d: ['day', 'days'], mo: ['month', 'months'], y: ['year', 'years'] }
};

function plural(n, forms) {
  if (forms.length === 2) return forms[n === 1 ? 0 : 1];
  var a = n % 100;
  if (a > 4 && a < 20) return forms[2];
  var b = n % 10;
  if (b === 1) return forms[0];
  if (b > 1 && b < 5) return forms[1];
  return forms[2];
}

function timeAgo(value) {
  var lang = uiLang();
  var sec = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  var steps = [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];

  for (var i = 0; i < steps.length; i++) {
    var n = Math.floor(sec / steps[i][1]);
    if (n >= 1 || steps[i][0] === 's') {
      var word = plural(n, AGO[lang][steps[i][0]]);
      return lang === 'en' ? n + ' ' + word + ' ago' : n + ' ' + word + ' назад';
    }
  }
  return '';
}

function refreshTimes() {
  document.querySelectorAll('[data-time]').forEach(function (el) {
    el.textContent = timeAgo(el.getAttribute('data-time'));
  });
}

// ── Загрузка и отрисовка ───────────────────────────────────────────────────

function addMessagesToLoaded(newMessages) {
  var fresh = newMessages.filter(function (m) {
    return !loadedMessages.some(function (loaded) { return loaded._id === m._id; });
  });
  loadedMessages = loadedMessages.concat(fresh);
}

async function loadMessages(recipientId) {
  try {
    var response = await fetch('/getMessages?recipientId=' + encodeURIComponent(recipientId) + '&offset=' + offset);
    if (!response.ok) {
      console.error('getMessages:', response.statusText);
      return;
    }
    var messages = await response.json();
    addMessagesToLoaded(messages);
    renderMessages();
    scrollToBottom();
    if (messages.length) lastMessageTimestamp = messages[messages.length - 1].sentAt;
  } catch (e) {
    console.error('getMessages:', e);
  }
}

async function loadMoreMessages(recipientId) {
  try {
    offset += 15;
    var response = await fetch('/getMessages?recipientId=' + encodeURIComponent(recipientId) + '&offset=' + offset);
    if (!response.ok) {
      console.error('getMessages (старые):', response.statusText);
      loadingOldMessages = false;
      return;
    }
    var messages = await response.json();
    var fresh = messages.filter(function (m) {
      return !loadedMessages.some(function (loaded) { return loaded._id === m._id; });
    });
    // Высоту запоминаем до отрисовки: иначе лента прыгает к началу.
    var box = feed();
    var before = box.scrollHeight;
    loadedMessages = fresh.concat(loadedMessages);
    renderMessages();
    box.scrollTop = box.scrollHeight - before;
    loadingOldMessages = false;
  } catch (e) {
    console.error('getMessages (старые):', e);
    loadingOldMessages = false;
  }
}

function handleScroll(container, recipientId) {
  if (container.scrollTop === 0 && !loadingOldMessages) {
    loadingOldMessages = true;
    loadMoreMessages(recipientId);
  }
}

// Аватар собеседника: либо ссылка на файл, либо градиент с буквой.
function peerAvatar(cls) {
  var name = escapeHtml(currentRecipientName);
  if (currentRecipientAvatar && currentRecipientAvatar.indexOf('http') === 0) {
    return '<span class="' + cls + '" data-peer><img src="' + escapeHtml(currentRecipientAvatar) + '" alt="' + name + '"></span>';
  }
  var initial = currentRecipientName ? escapeHtml(currentRecipientName.charAt(0).toUpperCase()) : '?';
  return '<span class="' + cls + '" data-peer style="background: ' + escapeHtml(currentRecipientAvatar || '') + '">' + initial + '</span>';
}

function renderMessages() {
  var box = feed();
  box.innerHTML = '';

  if (!loadedMessages.length) {
    box.innerHTML = '<p class="tk-note tk-note--center">' +
      escapeHtml(t('221', 'Нет сообщений в этом диалоге', 'No messages in this conversation')) + '</p>';
    return;
  }

  loadedMessages.forEach(function (message) {
    var stamp = escapeHtml(when(message.sentAt));
    var text = escapeHtml(message.content);
    var wrap = document.createElement('div');

    if (message.sender === currentRecipientId) {
      wrap.className = 'tk-msg tk-msg--in';
      wrap.innerHTML =
        '<div class="tk-msg__row">' +
          peerAvatar('tk-msg__ava') +
          '<p class="tk-msg__text">' + text + '</p>' +
        '</div>' +
        '<p class="tk-msg__when">' + stamp + '</p>';
    } else {
      wrap.className = 'tk-msg tk-msg--out';
      wrap.innerHTML =
        '<p class="tk-msg__text">' + text + '</p>' +
        '<p class="tk-msg__when">' + stamp + '</p>';
    }

    box.appendChild(wrap);
  });
}

function scrollToBottom() {
  var box = feed();
  box.scrollTop = box.scrollHeight;
}

// ── Отправка и добор новых ────────────────────────────────────────────────

async function sendMessage() {
  var input = document.getElementById('messageInput');
  var recipientId = input.getAttribute('data-id');
  var content = input.value.trim();

  if (!recipientId || content === '') {
    toast(t('222', 'Выберите диалог и введите сообщение.', 'Select a conversation and type a message.'), 'error');
    return;
  }

  try {
    var response = await fetch('/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipientId: recipientId, content: content })
    });

    if (!response.ok) {
      toast(t('223', 'Ошибка при отправке сообщения.', 'Failed to send message.'), 'error');
      return;
    }

    var message = await response.json();
    loadedMessages.push(message);
    renderMessages();
    scrollToBottom();
    input.value = '';
    lastMessageTimestamp = message.sentAt;
  } catch (e) {
    console.error('sendMessage:', e);
    toast(t('223', 'Ошибка при отправке сообщения.', 'Failed to send message.'), 'error');
  }
}

async function checkForNewMessages(recipientId) {
  try {
    var url = '/getNewMessages?recipientId=' + encodeURIComponent(recipientId);
    if (lastMessageTimestamp) url += '&after=' + encodeURIComponent(lastMessageTimestamp);

    var response = await fetch(url);
    if (!response.ok) {
      console.error('getNewMessages:', response.statusText);
      return;
    }

    var messages = await response.json();
    if (!messages.length) return;

    addMessagesToLoaded(messages);
    renderMessages();
    scrollToBottom();
    lastMessageTimestamp = messages[messages.length - 1].sentAt;
  } catch (e) {
    console.error('getNewMessages:', e);
  }
}

// ── Уведомления ───────────────────────────────────────────────────────────

async function markNotificationsAsRead(senderId) {
  try {
    await fetch('/api/notifications/markAsRead', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderId: senderId })
    });
  } catch (e) {
    console.error('markAsRead:', e);
  }
}

async function removeChatNotifications(recipientId) {
  try {
    var response = await fetch('/removeChatNotifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipientId: recipientId })
    });
    if (!response.ok) {
      console.error('removeChatNotifications:', response.statusText);
      return;
    }

    var dialog = document.querySelector('.tk-dialog[data-id="' + recipientId + '"]');
    var mark = dialog && dialog.querySelector('.unread-indicator');
    if (mark) mark.remove();

    updateHeaderNotificationIndicator();
  } catch (e) {
    console.error('removeChatNotifications:', e);
  }
}

// Точка непрочитанного в шапке. Прежняя версия искала `.notification-btn
// .absolute` — селектор от старой шапки, которого в разметке нет; функция
// не делала ничего. В новой шапке это .tk-ahead__dot.
function updateHeaderNotificationIndicator() {
  var dot = document.querySelector('.tk-ahead__dot');
  if (!dot) return;
  if (!document.querySelector('.unread-indicator')) dot.remove();
}

// ── Выбор диалога ─────────────────────────────────────────────────────────

function goToUserProfile() {
  if (currentRecipientId) window.location.href = '/userPage/' + encodeURIComponent(currentRecipientId);
}

function selectConversation(element) {
  var recipientId = element.getAttribute('data-id');
  var recipientName = element.getAttribute('data-name');
  var recipientAvatar = element.getAttribute('data-avatar');

  currentRecipientId = recipientId;
  currentRecipientName = recipientName;
  currentRecipientAvatar = recipientAvatar;

  removeChatNotifications(recipientId);
  markNotificationsAsRead(recipientId);

  document.querySelectorAll('.tk-dialog').forEach(function (d) {
    d.classList.toggle('tk-dialog--on', d === element);
  });

  var name = document.querySelector('.avatar__name');
  if (name) {
    name.textContent = recipientName;
    // Ключ словаря снимаем: иначе applyLang вернёт «Выберите диалог».
    name.removeAttribute('lng');
  }

  var note = document.querySelector('.tk-chat__peer-note');
  if (note) { note.textContent = ''; note.removeAttribute('lng'); }

  var avatar = document.getElementById('chatAvatar');
  if (avatar) {
    if (recipientAvatar && recipientAvatar.indexOf('http') === 0) {
      avatar.removeAttribute('style');
      avatar.innerHTML = '<img src="' + escapeHtml(recipientAvatar) + '" alt="' + escapeHtml(recipientName) + '">';
    } else {
      avatar.setAttribute('style', 'background: ' + recipientAvatar);
      avatar.textContent = recipientName.charAt(0).toUpperCase();
    }
  }

  // Присутствие собеседника в шапке диалога
  var presence = document.getElementById('chatHeaderPresence');
  if (presence) {
    presence.setAttribute('data-presence-user', recipientId);
    if (window.subscribePresence) window.subscribePresence([recipientId]);
    var dot = presence.querySelector('.presence-dot');
    if (dot) dot.classList.remove('hidden');
    fetch('/api/presence?ids=' + encodeURIComponent(recipientId))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var u = (data.users || [])[0];
        if (u) window.dispatchEvent(new CustomEvent('presence:init', { detail: u }));
      })
      .catch(function () {});
  }

  var input = document.getElementById('messageInput');
  var send = document.querySelector('.input__button-icons');
  if (input) {
    input.setAttribute('data-id', recipientId);
    input.placeholder = t('224', 'Сообщение для', 'Message to') + ' ' + recipientName + '…';
    input.removeAttribute('lng');
  }
  if (send) send.setAttribute('data-id', recipientId);

  loadedMessages = [];
  offset = 0;
  lastMessageTimestamp = null;
  loadingOldMessages = false;

  // Подгрузка старых сообщений при прокрутке вверх. Обработчик вешала только
  // первая, перекрытая функция выбора диалога, — то есть не вешал никто.
  var box = feed();
  if (feedScrollHandler) box.removeEventListener('scroll', feedScrollHandler);
  feedScrollHandler = function () { handleScroll(box, recipientId); };
  box.addEventListener('scroll', feedScrollHandler);

  if (messageCheckInterval) clearInterval(messageCheckInterval);
  messageCheckInterval = setInterval(function () { checkForNewMessages(recipientId); }, 3000);

  loadMessages(recipientId);
  showChatArea();
}

// ── Переключение панелей на узком экране ──────────────────────────────────

function showChatArea() {
  document.getElementById('chat').classList.add('is-open');
}

function showConversationsList() {
  document.getElementById('chat').classList.remove('is-open');
  if (messageCheckInterval) {
    clearInterval(messageCheckInterval);
    messageCheckInterval = null;
  }
}

// ── Запуск ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.tk-dialog').forEach(function (dialog) {
    dialog.addEventListener('click', function () { selectConversation(dialog); });
  });

  var back = document.getElementById('backToList');
  if (back) back.addEventListener('click', showConversationsList);

  var peer = document.getElementById('peerLink');
  if (peer) peer.addEventListener('click', goToUserProfile);

  // Аватар собеседника в ленте ведёт на его страницу
  feed().addEventListener('click', function (e) {
    if (e.target.closest('[data-peer]')) goToUserProfile();
  });

  var form = document.getElementById('composeForm');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      sendMessage();
    });
  }

  window.addEventListener('beforeunload', function () {
    if (messageCheckInterval) clearInterval(messageCheckInterval);
  });

  updateHeaderNotificationIndicator();
  refreshTimes();
  // Подписи «N минут назад» стареют, пока страница открыта.
  setInterval(refreshTimes, 60000);

  // Переход с профиля по кнопке «Сообщение»: открыть нужный диалог сразу.
  // Прежде страница получала ?conversationId=..., но его никто не читал —
  // человек попадал в список и искал собеседника заново.
  var peerId = new URLSearchParams(window.location.search).get('peer');
  if (peerId) {
    var target = document.querySelector('.tk-dialog[data-id="' + peerId + '"]');
    if (target) selectConversation(target);
  }
});
