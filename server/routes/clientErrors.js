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

// Робот поисковика, а не человек. Bingbot и его родня разбирают страницы
// своим движком и присылают сюда отказы загрузки наших же файлов: чинить
// в них нечего, увидеть их у людей мы не можем, а в списке они занимают
// место наравне с настоящими поломками (журнал 21.09 — bingbot и наш CSS).
// Ловим по двум приметам, которых у нынешних браузеров не бывает: адрес
// робота прямо в подписи и старое «compatible;».
const BOT_UA = /\+https?:\/\/|\bcompatible;|(bot|spider|crawler|slurp)\//i;

// Вкладку закрыли или ушли со страницы, пока висел незавершённый промис:
// браузер отклоняет его сам и сам же об этом рассказывает. Такое приходило
// с /upload при закрытии страницы посреди загрузки — поломки здесь нет
// ни нашей, ни браузера, а в журнале это выглядит ошибкой.
const UNLOAD_NOISE = /browsing context is going away|page was (unloaded|discarded)/i;

// Отчёты, а не ошибки: их шлёт исправно работающая страница. Проверка
// связи и проверка звука — со страницы /check по нажатию человека, отчёт
// о звуке — ещё и сам, через десять секунд каждого разговора. В списке
// поломок они считались наравне с ними: «браузер: 11» — это девять ошибок
// и два успешных отчёта. Вид записи check, свой пункт в фильтре панели.
const CHECK_NAMES = /^(CallAudio|NetCheck)$/;

router.post('/api/client-error', clientErrorLimiter, express.json({ limit: '16kb' }), (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const message = cut(body.message, 500);
    // Старые вкладки ещё шлют «Script error.» — ошибку чужого скрипта без
    // подробностей (см. partials/tkHead.ejs). Не пишем и её.
    const opaque = /^Script error\.?$/.test(message) && !body.source;
    const noise = UNLOAD_NOISE.test(message) || BOT_UA.test(req.get('user-agent') || '');

    // Пустое сообщение записывать нечего: так приходят ошибки загрузки
    // сторонних файлов, у которых браузер прячет подробности.
    if (message && !opaque && !noise) {
        const name = cut(body.name, 100) || 'ClientError';
        record({
            scope: CHECK_NAMES.test(name) ? 'check' : 'client',
            err: { name, message, stack: cut(body.stack, 4000) },
            route: cut(body.page || req.get('referer'), 200),
            req,
            meta: {
                source: cut(body.source, 200),
                line: Number(body.line) || 0,
                column: Number(body.column) || 0,
                // Подробности построчно — отчёт о несоединившемся звонке
                // (public/tk-daily.js): хронология длиннее стека, который
                // журнал режет до двенадцати строк.
                ...(Array.isArray(body.details) ? { details: body.details.slice(0, 120).map((x) => cut(x, 300)) } : {}),
            },
        });
    }

    res.status(204).end();
});

module.exports = router;
