// Уведомления и подтверждения вместо alert() и confirm().
//
// Браузерные диалоги останавливают исполнение страницы: пока висит alert, эфир
// не рисуется, сокет не обрабатывает события, таймеры стоят. На странице
// вещателя это особенно заметно — там их было десять.
//
// Здесь нет зависимостей и нет фреймворка: стили свои, вставляются один раз.
// Наружу выходят две функции:
//   toast('текст')                — уведомление, гаснет само
//   toast('текст', 'error' | 'ok')
//   await confirmDialog('текст')  — подтверждение, возвращает true или false
(function () {
  if (window.toast) return; // файл подключён дважды — второй раз ничего не делаем

  const CSS = `
.tb-toasts {
  position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
  z-index: 10000; display: flex; flex-direction: column; gap: 8px;
  width: min(420px, calc(100vw - 32px)); pointer-events: none;
}
.tb-toast {
  pointer-events: auto; cursor: pointer;
  display: flex; align-items: flex-start; gap: 10px;
  padding: 12px 14px; border-radius: 12px;
  background: #fff; color: #1f2328;
  border: 1px solid #e3e5e8;
  box-shadow: 0 6px 24px rgba(0, 0, 0, .12);
  font: 500 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  opacity: 0; transform: translateY(-8px);
  transition: opacity .18s ease, transform .18s ease;
  word-break: break-word;
}
.tb-toast.tb-in { opacity: 1; transform: translateY(0); }
.tb-toast::before {
  content: ""; flex: none; width: 4px; align-self: stretch;
  border-radius: 2px; background: #9aa1a9;
}
.tb-toast.tb-error::before { background: #d64545; }
.tb-toast.tb-ok::before { background: #2f9e5f; }

.tb-backdrop {
  position: fixed; inset: 0; z-index: 10001;
  background: rgba(17, 19, 22, .45);
  display: flex; align-items: center; justify-content: center; padding: 16px;
  opacity: 0; transition: opacity .15s ease;
}
.tb-backdrop.tb-in { opacity: 1; }
.tb-dialog {
  width: min(420px, 100%); background: #fff; border-radius: 16px;
  padding: 20px; box-shadow: 0 20px 60px rgba(0, 0, 0, .28);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #1f2328;
}
.tb-dialog p { margin: 0 0 18px; font-size: 15px; }
.tb-dialog-buttons { display: flex; gap: 10px; justify-content: flex-end; }
.tb-dialog button {
  font: 600 14px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  padding: 10px 16px; border-radius: 10px; cursor: pointer; border: 1px solid transparent;
}
.tb-dialog .tb-cancel { background: #f2f3f5; color: #1f2328; border-color: #e3e5e8; }
.tb-dialog .tb-cancel:hover { background: #e8eaed; }
.tb-dialog .tb-ok-btn { background: #d64545; color: #fff; }
.tb-dialog .tb-ok-btn:hover { background: #c03a3a; }
.tb-dialog button:focus-visible { outline: 2px solid #1f2328; outline-offset: 2px; }

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

  window.confirmDialog = function (message, options) {
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
      cancel.textContent = opts.cancelText || 'Отмена';

      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'tb-ok-btn';
      ok.textContent = opts.okText || 'Подтвердить';

      buttons.append(cancel, ok);
      dialog.append(text, buttons);
      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);
      requestAnimationFrame(() => backdrop.classList.add('tb-in'));
      ok.focus();

      const close = (result) => {
        document.removeEventListener('keydown', onKey, true);
        backdrop.classList.remove('tb-in');
        setTimeout(() => backdrop.remove(), 160);
        if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
        resolve(result);
      };

      // Клавиатура: Esc — отмена, Tab не выпускает фокус из двух кнопок.
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        else if (e.key === 'Tab') {
          e.preventDefault();
          (document.activeElement === ok ? cancel : ok).focus();
        }
      }

      document.addEventListener('keydown', onKey, true);
      cancel.addEventListener('click', () => close(false));
      ok.addEventListener('click', () => close(true));
      // Клик мимо окна равнозначен отмене: действие деструктивное, по умолчанию «нет».
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
    });
  };
})();
