// Описание страницы для поисковиков и карточек ссылок (docs/seo, задача 4
// аудита 24.09): переводы строк и двойные пробелы схлопнуты, длина — до
// max знаков, резка по слову с многоточием, а не посреди слова. Пустой
// текст — пустая строка: шаблон тогда подставляет запасное описание.
function snippet(text, max = 155) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  // Одно длинное слово без пробелов (ссылка) режем как есть.
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:—–-]+$/, '') + '…';
}

module.exports = { snippet };
