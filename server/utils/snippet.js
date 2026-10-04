// Тексты страницы для поисковиков и карточек ссылок (docs/seo).
//
// Правило проекта (решение Ивана 04.10.2026): у каждой страницы в индексе
// нормальное описание. Свой текст человека — если он что-то говорит; иначе
// наш, из шаблона словаря. Шаблон передаёт запасной текст сам: в нём язык,
// ник и дата, которых здесь нет.

// Схлопнуть пробелы и переводы строк, обрезать до max знаков по слову,
// с многоточием. Пустой текст — пустая строка.
function snippet(text, max = 155) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  // Одно длинное слово без пробелов (ссылка) режем как есть.
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:—–-]+$/, '') + '…';
}

// Говорит ли текст хоть что-то: две буквы или цифры. «.», «)», «🩷» — нет.
// Такое название или описание считаем пустым.
const meaningful = (text) => /[\p{L}\p{N}][^]*[\p{L}\p{N}]/u.test(String(text || ''));

// Описание из своего текста и запасного. Короче SHORT знаков — свой текст
// остаётся первым, запасной дописывается за ним («ляляля. Запись эфира
// anna от 2 октября…»): так и слова автора на месте, и сниппет не пустой.
const SHORT = 70;
function describe(text, fallback) {
  const own = snippet(text);
  if (!meaningful(own)) return snippet(fallback);
  if (own.length >= SHORT) return own;
  return snippet(own.replace(/[\s.!?…]+$/, '') + '. ' + fallback);
}

module.exports = { snippet, meaningful, describe };
