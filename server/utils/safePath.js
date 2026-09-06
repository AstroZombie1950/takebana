// Безопасная склейка путей.
//
// Express декодирует %2F в параметрах маршрута, поэтому :filename вида
// `..%2F..%2Fapp.js` приходит в обработчик уже как `../../app.js`. Через это
// воспроизводилось удаление произвольного файла на сервере
// (DELETE /profile/gallery/:name и POST /upload-thumbnail) и чтение файлов
// вне папки трансляций (GET /segment/:streamKey/:filename).
//
// resolveWithin склеивает путь и возвращает null, если результат вышел
// за пределы базовой папки. Проверка идёт после path.resolve, то есть
// после схлопывания «..» — сравнивать сырые строки бесполезно.

const path = require('path');

function resolveWithin(baseDir, ...parts) {
    if (parts.some(p => typeof p !== 'string' || p.length === 0)) return null;

    const base = path.resolve(baseDir);
    const target = path.resolve(base, ...parts);

    // Ровно база тоже не подходит: ожидается файл или папка внутри неё.
    if (target === base) return null;
    if (!target.startsWith(base + path.sep)) return null;

    return target;
}

// Отдельно — проверка одного сегмента пути (имя файла без папок).
// Годится там, где ожидается именно имя файла: `abc.jpg`, но не `a/b.jpg`.
function isPlainFileName(name) {
    if (typeof name !== 'string' || !name) return false;
    if (name === '.' || name === '..') return false;
    return !/[\\/]/.test(name) && !name.includes('\0');
}

module.exports = { resolveWithin, isPlainFileName };
