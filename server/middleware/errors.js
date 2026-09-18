// Обработчик ошибок Express.
//
// До этого его не было вовсе: ошибка из маршрута уходила во встроенный
// обработчик Express, который в проде отвечает голым «Internal Server Error»,
// а след оставляет только в stderr под pm2. Ни найти, ни посчитать, ни
// связать с человеком такую ошибку было нельзя.
//
// Ставится последним, после всех маршрутов (app.js). Четыре аргумента
// обязательны: по их числу Express отличает обработчик ошибок от обычного.

const { record, fingerprint, flush: flushErrors } = require('../utils/errorLog');
const { flush: flushAudit } = require('../utils/audit');

// Ответ JSON или страницей. Маршруты /api/* и запросы из скриптов всегда
// получают JSON: fetch(), поймавший HTML вместо него, падает на .json()
// молча — та же ловушка, что в requireAuthApi.
function wantsJson(req) {
    return req.path.startsWith('/api/') || req.xhr || !req.accepts('html');
}

function errorHandler(err, req, res, next) {
    // multer сообщает о слишком большом или неподходящем файле обычной
    // ошибкой. Без этой строки такая загрузка отвечала 500 и ложилась
    // в журнал ошибок, хотя сервер отработал ровно так, как должен.
    const fromMulter = err && err.name === 'MulterError';
    const status = Number(err.status || err.statusCode) || (fromMulter ? 400 : 500);

    // 4xx — это ответ приложения, а не поломка: негодное тело, нет прав,
    // не тот формат файла. В журнал ошибок они не идут, иначе он превратится
    // в шум, в котором настоящая авария незаметна.
    let code = '';
    if (status >= 500) {
        const route = `${req.method} ${req.path}`;
        code = fingerprint('server', route, err.name || 'Error', err.message || '');
        record({ scope: 'server', err, route, status, req });
        console.error(`[error] ${route} ${status} #${code}`, err.message);
    }

    // Заголовки уже ушли — дописать ответ нельзя, отдаём Express, он закроет
    // соединение.
    if (res.headersSent) return next(err);

    // Наружу — только общее сообщение: текст ошибки и стек могут содержать
    // и пути на диске, и части запроса к базе. Отпечаток безопасен и позволяет
    // найти запись в панели. Исключение — ошибки, которые мы сами пометили
    // expose: их текст написан для человека («Только изображения JPEG…»)
    // и без него он не поймёт, что именно не так с его файлом.
    // Тексты multer — английские и технические («File too large»), поэтому
    // свои: переводит их общий словарь сообщений (utils/i18n.js).
    const MULTER = { LIMIT_FILE_SIZE: 'Файл слишком большой' };
    const message = status >= 500 ? 'Ошибка сервера'
        : fromMulter ? (MULTER[err.code] || 'Ошибка загрузки файла')
        : err.expose ? String(err.message)
        : 'Ошибка сервера';

    if (wantsJson(req)) {
        return res.status(status).json({ message, code });
    }

    // Страница ошибки сама рендерится шаблоном, и он тоже может упасть —
    // например, когда сломан как раз движок представлений. Тогда простой текст.
    res.status(status).render('error', { code }, (renderErr, html) => {
        if (renderErr) return res.type('text/plain').send('Ошибка сервера' + (code ? ' #' + code : ''));
        res.send(html);
    });
}

// Остановка процесса: pm2 при деплое шлёт SIGINT, systemd — SIGTERM.
// Успеть дописать журналы стоит: иначе при каждом перезапуске теряется
// последняя секунда действий, а это как раз то, что делали перед аварией.
// Жёсткий предел обязателен — недоступная база не должна задерживать выход.
function installShutdown() {
    let leaving = false;
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            if (leaving) return process.exit(0);
            leaving = true;
            const kill = setTimeout(() => process.exit(0), 500);
            Promise.allSettled([flushAudit(), flushErrors()]).then(() => {
                clearTimeout(kill);
                process.exit(0);
            });
        });
    }
}

module.exports = { errorHandler, installShutdown };
