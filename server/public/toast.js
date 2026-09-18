// Уведомления и подтверждения вместо alert() и confirm().
//
// Браузерные диалоги останавливают исполнение страницы: пока висит alert, эфир
// не рисуется, сокет не обрабатывает события, таймеры стоят. На странице
// вещателя это особенно заметно — там их было десять.
//
// Здесь нет зависимостей и нет фреймворка: стили свои, вставляются один раз.
// Наружу выходят три функции:
//   toast('текст')                — уведомление, гаснет само
//   toast('текст', 'error' | 'ok')
//   await confirmDialog('текст')  — подтверждение, возвращает true или false
//   await chooseDialog('текст', [{ value, text, danger }]) — выбор действия, value или null
(function () {
  if (window.toast) return; // файл подключён дважды — второй раз ничего не делаем

  // Оформление — дизайн-системы (public/css/tk.css): тёмная карточка, прямые
  // углы, Golos Text, кнопки как .tk-btn--sm. Значения здесь, а не токенами:
  // файл подключается и там, где tk.css может не быть.
  const CSS = `
.tb-toasts {
  position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
  z-index: 10000; display: flex; flex-direction: column; gap: 8px;
  width: min(420px, calc(100vw - 32px)); pointer-events: none;
}
.tb-toast {
  pointer-events: auto; cursor: pointer;
  display: flex; align-items: flex-start; gap: 12px;
  padding: 12px 14px;
  background: #0A0A0A; color: #F5F1EA;
  border: 1px solid rgba(144, 113, 99, .5);
  box-shadow: 0 8px 28px rgba(0, 0, 0, .5);
  font: 500 14px/1.45 'Golos Text', Helvetica, sans-serif;
  opacity: 0; transform: translateY(-8px);
  transition: opacity .18s ease, transform .18s ease;
  word-break: break-word;
}
.tb-toast.tb-in { opacity: 1; transform: translateY(0); }
.tb-toast::before {
  content: ""; flex: none; width: 3px; align-self: stretch;
  background: #8A827C;
}
.tb-toast.tb-error::before { background: #E34234; }
.tb-toast.tb-ok::before { background: #679267; }

.tb-backdrop {
  position: fixed; inset: 0; z-index: 10001;
  background: rgba(10, 10, 10, .78);
  display: flex; align-items: center; justify-content: center; padding: 16px;
  opacity: 0; transition: opacity .15s ease;
}
.tb-backdrop.tb-in { opacity: 1; }
.tb-dialog {
  width: min(460px, 100%); background: #0A0A0A;
  border: 1px solid rgba(144, 113, 99, .5);
  padding: 24px 22px 22px; box-shadow: 0 20px 60px rgba(0, 0, 0, .6);
  font: 14px/1.5 'Golos Text', Helvetica, sans-serif;
  color: #F5F1EA;
}
/* Вопрос — заголовком окна: сверху и по центру. */
.tb-dialog p { margin: 0 0 22px; font-size: 16px; font-weight: 700; text-align: center; }
/* Действия слева направо, отмена — последней: «у меня · у всех · отмена».
 * Раньше отмена стояла первой и с выравниванием вправо оказывалась
 * посередине между двумя удалениями. */
.tb-dialog-buttons { display: flex; flex-wrap: wrap; gap: 10px; }
.tb-dialog button {
  flex: 1 1 auto;
  font: 700 12px/1 'Golos Text', Helvetica, sans-serif;
  letter-spacing: .1em; text-transform: uppercase;
  padding: 12px 12px; cursor: pointer; border: 1px solid transparent;
  transition: background-color .18s ease, border-color .18s ease, color .18s ease;
}
.tb-dialog .tb-cancel { background: transparent; color: #C9C2B7; border-color: rgba(144, 113, 99, .7); }
.tb-dialog .tb-cancel:hover { border-color: #F5F1EA; color: #F5F1EA; }
.tb-dialog .tb-ok-btn { background: #E34234; border-color: #E34234; color: #0A0A0A; }
.tb-dialog .tb-ok-btn:hover { background: #F5F1EA; border-color: #F5F1EA; }
.tb-dialog button:focus-visible { outline: 2px solid #E34234; outline-offset: 3px; }

@media (max-width: 480px) {
  .tb-dialog-buttons { flex-direction: column; }
  .tb-dialog button { width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .tb-toast, .tb-backdrop { transition: none; }
}
`;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  let stack = null;
  function toastStack() {
    if (!stack || !stack.isConnected) {
      stack = document.createElement('div');
      stack.className = 'tb-toasts';
      // aria-live: экранный диктор прочитает уведомление, не перехватывая фокус.
      stack.setAttribute('role', 'status');
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    return stack;
  }

  const VISIBLE_LIMIT = 4;
  const LIFETIME_MS = 4000;
  const LIFETIME_ERROR_MS = 6000;

  window.toast = function (message, type) {
    const text = message === undefined || message === null ? '' : String(message);
    if (!text) return;

    const box = toastStack();
    // Больше четырёх на экране — нижние уже не читают, верхние убираем.
    while (box.children.length >= VISIBLE_LIMIT) box.firstElementChild.remove();

    const el = document.createElement('div');
    el.className = 'tb-toast' + (type === 'error' ? ' tb-error' : type === 'ok' ? ' tb-ok' : '');
    // textContent, а не innerHTML: в сообщение попадают ответы сервера и имена.
    el.textContent = text;
    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add('tb-in'));

    let timer = null;
    const hide = () => {
      if (timer) clearTimeout(timer);
      el.classList.remove('tb-in');
      setTimeout(() => el.remove(), 200);
    };
    el.addEventListener('click', hide);
    timer = setTimeout(hide, type === 'error' ? LIFETIME_ERROR_MS : LIFETIME_MS);
    return hide;
  };

  // Выбор из нескольких действий: «Удалить у меня», «Удалить у всех», «Отмена».
  // Возвращает value выбранного действия или null — отмена, Esc, клик мимо.
  window.chooseDialog = function (message, choices, options) {
    const opts = options || {};
    return new Promise((resolve) => {
      const previouslyFocused = document.activeElement;

      const backdrop = document.createElement('div');
      backdrop.className = 'tb-backdrop';

      const dialog = document.createElement('div');
      dialog.className = 'tb-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');

      const text = document.createElement('p');
      text.textContent = String(message == null ? '' : message);

      const buttons = document.createElement('div');
      buttons.className = 'tb-dialog-buttons';

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'tb-cancel';
      cancel.textContent = opts.cancelText || (window.t ? window.t('common.cancel') : 'Отмена');

      const actions = choices.map((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = c.danger === false ? 'tb-cancel' : 'tb-ok-btn';
        b.textContent = c.text;
        b.addEventListener('click', () => close(c.value));
        return b;
      });

      buttons.append(...actions, cancel);
      dialog.append(text, buttons);
      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);
      requestAnimationFrame(() => backdrop.classList.add('tb-in'));
      // Фокус на отмене: действие деструктивное, по умолчанию «нет».
      cancel.focus();

      // Порядок обхода по Tab — тот же, что на глаз.
      const all = [...actions, cancel];
      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        backdrop.classList.remove('tb-in');
        setTimeout(() => backdrop.remove(), 160);
        if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
        resolve(result);
      }

      // Клавиатура: Esc — отмена, Tab ходит по кнопкам окна и не выпускает фокус.
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
        else if (e.key === 'Tab') {
          e.preventDefault();
          const i = all.indexOf(document.activeElement);
          all[(i + (e.shiftKey ? all.length - 1 : 1)) % all.length].focus();
        }
      }

      document.addEventListener('keydown', onKey, true);
      cancel.addEventListener('click', () => close(null));
      // Клик мимо окна равнозначен отмене: действие деструктивное, по умолчанию «нет».
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
    });
  };

  window.confirmDialog = function (message, options) {
    const opts = options || {};
    const okText = opts.okText || (window.t ? window.t('common.confirm') : 'Подтвердить');
    return window.chooseDialog(message, [{ value: true, text: okText }], opts).then((v) => v === true);
  };
})();
