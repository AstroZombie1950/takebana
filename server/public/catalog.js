/* Каталог эфиров. Три обработчика, больше на странице ничего не делается.
 *
 * Что уехало из прежней версии:
 *   — IntersectionObserver на появление карточек. Роут отдаёт максимум
 *     четыре эфира, все в первом экране: наблюдать за прокруткой было не за чем.
 *     Появление осталось, но его делает CSS-анимация в catalog.css.
 *   — Обработчик .button__subscribe. Кнопок с таким классом на странице нет
 *     ни одной — код висел мёртвым.
 *   — Кнопки «Фильтры» и «Сортировка». Обработчиков у них не было вообще,
 *     нажатие не давало ничего. Вернутся вместе с задачей «Фильтры каталога».
 */

document.addEventListener('DOMContentLoaded', function () {
  // Теги категорий. Пока только запоминают выбор: сама фильтрация — отдельная
  // задача этапа 4, серверного параметра под неё ещё нет.
  document.querySelectorAll('.tk-tag').forEach(function (tag) {
    tag.addEventListener('click', function () {
      var on = tag.getAttribute('aria-pressed') === 'true';
      tag.setAttribute('aria-pressed', String(!on));
    });
  });

  // «Показать ещё» в рекомендациях: раскрывает тех, кого роут уже прислал.
  var more = document.getElementById('showMoreUsers');
  if (more) {
    more.addEventListener('click', function () {
      document.querySelectorAll('.tk-rec__item.hidden').forEach(function (item) {
        item.classList.remove('hidden');
      });
      more.remove();
    });
  }

  // «Стать первым» в пустом состоянии открывает те же настройки эфира,
  // что кнопка в шапке. Разметка окна — partials/appModals.ejs.
  var first = document.getElementById('start-stream-btn');
  var modal = document.getElementById('streamSettingsModal');
  if (first && modal) {
    first.addEventListener('click', function () {
      modal.classList.remove('hidden');
    });
  }
});
