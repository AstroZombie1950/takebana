// Ошибки в браузере посетителя.
//
// Половина поломок вёрстки и скриптов не доходит до сервера вообще: упал
// обработчик, не загрузился файл, отвалился сокет — человек видит неработающую
// кнопку и уходит, а в логах сервера чисто. Страницы шлют такие ошибки сюда
// (public/tk-errors.js), и они попадают в тот же журнал, что серверные.
//
// Маршрут открыт без входа — иначе не увидеть ошибок у гостей, а витрина,
// эфир и карта теперь открыты и им. Поэтому он под лимитом и с потолком
// на размер полей: это единственный маршрут, куда пишет кто угодно.

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { record } = require('../utils/errorLog');

// Двадцать сообщений с адреса за пять минут. Сломанный цикл на странице
// способен слать их сотнями в секунду, и записывать это все — значит
// писать шум вместо журнала. Ответ всегда 204: странице от него ничего
// не нужно, а сообщение об ошибке отправки ошибки никому не поможет.
const clientErrorLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 20,
    standardHeaders: false,
    legacyHeaders: false,
    handler: (req, res) => res.status(204).end(),
});

const cut = (v, n) => String(v == null ? '' : v).slice(0, n);

router.post('/api/client-error', clientErrorLimiter, express.json({ limit: '16kb' }), (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const message = cut(body.message, 500);

    // Пустое сообщение записывать нечего: так приходят ошибки загрузки
    // сторонних файлов, у которых браузер прячет подробности.
    if (message) {
        record({
            scope: 'client',
            err: { name: cut(body.name, 100) || 'ClientError', message, stack: cut(body.stack, 4000) },
            route: cut(body.page || req.get('referer'), 200),
            req,
            meta: {
                source: cut(body.source, 200),
                line: Number(body.line) || 0,
                column: Number(body.column) || 0,
            },
        });
    }

    res.status(204).end();
});

module.exports = router;
