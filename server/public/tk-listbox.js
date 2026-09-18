// Свой выпадающий список поверх <select class="tk-select">.
//
// Поле у <select> оформлено давно, а раскрывающийся список рисует система:
// белый, со своим шрифтом, мимо дизайна. option { background } она чаще всего
// игнорирует — это предел <select>, а не забытый класс.
//
// Родной <select> остаётся хозяином значения: он в форме, его читают и меняют
// скрипты страниц (select.value = …, selectedIndex, перезаполнение списка
// камер и подкатегорий), по нему идёт проверка required. Здесь поверх него
// рисуется кнопка и список, и оба следят за ним:
//   — выбор в списке ставит значение в <select> и шлёт change, как родной;
//   — значение, поставленное скриптом, видно сразу: сеттеры value и
//     selectedIndex у этого <select> перехвачены;
//   — новые option, смена подписей при переключении языка, disabled —
//     через MutationObserver.
//
// На сенсорных экранах не включается: там системный выбор — полноэкранное
// колесо или шторка, привычные и удобные, а свой список пальцем хуже.

(function () {
  'use strict';

  if (!window.matchMedia || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  var uid = 0;
  var openBox = null;   // открыт может быть только один список

  function enhance(select) {
    if (select.dataset.listbox || select.hidden || select.multiple) return;
    select.dataset.listbox = '1';

    var id = 'tk-lb-' + (++uid);
    var wrap = document.createElement('div');
    wrap.className = 'tk-lb';

    // Кнопка — с теми же классами, что у поля: выглядит ровно как было.
    var button = document.createElement('button');
    button.type = 'button';
    button.className = select.className + ' tk-lb__button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', id);

    var list = document.createElement('ul');
    list.className = 'tk-lb__list';
    list.id = id;
    list.setAttribute('role', 'listbox');
    list.tabIndex = -1;
    list.hidden = true;

    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    wrap.appendChild(button);
    wrap.appendChild(list);

    // Сам <select> остаётся в форме, но с глаз и из обхода по Tab убран.
    // Не display: none — иначе браузер не сможет показать на нём подсказку
    // required, а форма заявки ею пользуется.
    select.classList.add('tk-lb__native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    // Подпись поля (<label for>) теперь называет кнопку.
    if (select.id) {
      var label = document.querySelector('label[for="' + CSS.escape(select.id) + '"]');
      if (label) {
        if (!label.id) label.id = id + '-label';
        button.setAttribute('aria-labelledby', label.id + ' ' + id + '-value');
        list.setAttribute('aria-labelledby', label.id);
        label.addEventListener('click', function (e) { e.preventDefault(); button.focus(); });
      }
    }

    var active = -1;    // подсвеченный пункт при открытом списке

    function items() { return Array.prototype.slice.call(select.options); }

    function render() {
      var opts = items();
      var current = select.options[select.selectedIndex];
      button.innerHTML = '';
      var value = document.createElement('span');
      value.className = 'tk-lb__value';
      value.id = id + '-value';
      value.textContent = current ? current.textContent : '';
      button.appendChild(value);
      button.disabled = select.disabled;
      // Пустое значение — это подсказка («Город», «Не выбрано»): приглушаем,
      // как плейсхолдер у текстового поля.
      button.classList.toggle('tk-lb__button--empty', !current || current.value === '');

      list.innerHTML = '';
      opts.forEach(function (o, i) {
        var li = document.createElement('li');
        li.className = 'tk-lb__option';
        li.id = id + '-o' + i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === select.selectedIndex));
        if (o.disabled) li.setAttribute('aria-disabled', 'true');
        li.textContent = o.textContent;
        li.dataset.index = i;
        list.appendChild(li);
      });
      if (!list.hidden) highlight(active);
    }

    function highlight(i) {
      var lis = list.children;
      if (!lis.length) return;
      active = Math.max(0, Math.min(i, lis.length - 1));
      for (var k = 0; k < lis.length; k++) lis[k].classList.toggle('tk-lb__option--active', k === active);
      list.setAttribute('aria-activedescendant', lis[active].id);
      var li = lis[active];
      if (li.offsetTop < list.scrollTop) list.scrollTop = li.offsetTop;
      else if (li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight;
      }
    }

    function open() {
      if (select.disabled || !select.options.length) return;
      if (openBox && openBox !== close) openBox();
      openBox = close;
      list.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      wrap.classList.add('tk-lb--open');
      place();
      highlight(select.selectedIndex < 0 ? 0 : select.selectedIndex);
      list.focus({ preventScroll: true });
    }

    // Список — position: fixed по координатам кнопки, а не absolute в обёртке:
    // форма жалобы и настройки заведения лежат в окнах с прокруткой, и
    // absolute-список обрезался бы их краем. Не влезает вниз — открываем вверх.
    function place() {
      var r = button.getBoundingClientRect();
      var below = innerHeight - r.bottom, above = r.top;
      var up = below < Math.min(list.scrollHeight, 280) + 12 && above > below;
      list.style.left = r.left + 'px';
      list.style.minWidth = r.width + 'px';
      list.style.top = up ? '' : (r.bottom + 4) + 'px';
      list.style.bottom = up ? (innerHeight - r.top + 4) + 'px' : '';
      list.style.maxHeight = Math.max(120, Math.min(280, (up ? above : below) - 16)) + 'px';
    }

    function close(refocus) {
      if (list.hidden) return;
      list.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      wrap.classList.remove('tk-lb--open');
      if (openBox === close) openBox = null;
      if (refocus) button.focus({ preventScroll: true });
    }

    function pick(i) {
      var o = select.options[i];
      if (!o || o.disabled) return;
      var changed = select.selectedIndex !== i;
      select.selectedIndex = i;
      close(true);
      if (changed) {
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // Набор букв подряд — прыжок к пункту, как у родного списка.
    var typed = '', typedAt = 0;
    function typeahead(ch) {
      var now = Date.now();
      typed = now - typedAt > 700 ? ch : typed + ch;
      typedAt = now;
      var lis = list.children;
      for (var k = 0; k < lis.length; k++) {
        var n = (active + 1 + k) % lis.length;
        if (typed.length > 1) n = (active + k) % lis.length;
        if (lis[n].textContent.trim().toLowerCase().indexOf(typed) === 0) return n;
      }
      return -1;
    }

    button.addEventListener('click', function () { list.hidden ? open() : close(true); });

    button.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Закрытый список: буква сразу выбирает, как у родного.
        active = select.selectedIndex;
        var n = typeahead(e.key.toLowerCase());
        if (n >= 0 && n !== select.selectedIndex) pick(n);
      }
    });

    list.addEventListener('keydown', function (e) {
      var last = list.children.length - 1;
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); highlight(active + 1); break;
        case 'ArrowUp': e.preventDefault(); highlight(active - 1); break;
        case 'Home': e.preventDefault(); highlight(0); break;
        case 'End': e.preventDefault(); highlight(last); break;
        case 'PageDown': e.preventDefault(); highlight(active + 8); break;
        case 'PageUp': e.preventDefault(); highlight(active - 8); break;
        case 'Enter': case ' ': e.preventDefault(); pick(active); break;
        case 'Escape': e.preventDefault(); e.stopPropagation(); close(true); break;
        case 'Tab': pick(active); break;
        default:
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            var n = typeahead(e.key.toLowerCase());
            if (n >= 0) highlight(n);
          }
      }
    });

    // mousedown, а не click: иначе список успевает потерять фокус и закрыться
    // раньше, чем выбор дойдёт.
    list.addEventListener('mousedown', function (e) {
      var li = e.target.closest('.tk-lb__option');
      e.preventDefault();
      if (li) pick(Number(li.dataset.index));
    });
    list.addEventListener('mousemove', function (e) {
      var li = e.target.closest('.tk-lb__option');
      if (li && Number(li.dataset.index) !== active) highlight(Number(li.dataset.index));
    });
    list.addEventListener('blur', function () { setTimeout(function () { if (!wrap.contains(document.activeElement)) close(); }, 0); });

    // Значение, поставленное скриптом страницы, — сразу на кнопку.
    ['value', 'selectedIndex'].forEach(function (prop) {
      var d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
      Object.defineProperty(select, prop, {
        configurable: true,
        get: function () { return d.get.call(this); },
        set: function (v) { d.set.call(this, v); render(); },
      });
    });
    select.addEventListener('change', render);
    // Скрипт формы при ошибке ставит фокус на поле — отдаём его кнопке.
    // И метод, и событие: событие не приходит, когда у окна нет фокуса
    // системы, а focus() зовут не только наши скрипты.
    select.focus = function (opts) { button.focus(opts); };
    select.addEventListener('focus', function () { button.focus(); });
    if (select.form) select.form.addEventListener('reset', function () { setTimeout(render, 0); });

    new MutationObserver(render).observe(select, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label'],
    });

    render();
  }

  // Клик мимо — закрыть открытый список.
  document.addEventListener('mousedown', function (e) {
    if (openBox && !e.target.closest('.tk-lb--open')) openBox();
  });
  // Список прибит к окну: страница уехала — закрываем, иначе он повис бы
  // в воздухе отдельно от поля. Прокрутка самого списка не в счёт.
  window.addEventListener('resize', function () { if (openBox) openBox(); });
  document.addEventListener('scroll', function (e) {
    if (openBox && !(e.target.classList && e.target.classList.contains('tk-lb__list'))) openBox();
  }, true);

  function init(root) {
    (root || document).querySelectorAll('select.tk-select').forEach(enhance);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { init(); });
  else init();

  window.TKListbox = { init: init };
})();
