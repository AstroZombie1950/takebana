// Ограничение частоты запросов.
//
// Вешается точечно — на вход, регистрацию и смену пароля. Глобальный лимит
// здесь не годится: страница эфира держит открытый сокет и дёргает несколько
// служебных маршрутов, и общий счётчик отрубал бы обычных зрителей.

const rateLimit = require('express-rate-limit');
const { audit } = require('../utils/audit');

// Срабатывание лимита — это событие для журнала, а не только отказ в ответе:
// подбор пароля и накрутка регистраций видны именно по нему. Ответ остаётся
// прежним, обработчик только добавляет запись.
const hit = (what) => (req, res, next, options) => {
    audit(req, 'auth.ratelimit', {
        result: 'denied',
        actorLogin: (req.body && typeof req.body.email === 'string') ? req.body.email : '',
        meta: { what },
    });
    res.status(options.statusCode).json(options.message);
};

// Пределы вынесены в переменные окружения: при отладке удобно поднять,
// чтобы не заблокировать самому себе вход десятком опечаток.
const LOGIN_LIMIT = Number(process.env.RATE_LIMIT_LOGIN) || 20;
const REGISTER_LIMIT = Number(process.env.RATE_LIMIT_REGISTER) || 5;

// Подбор пароля: 20 попыток с одного адреса за 15 минут — верхняя граница
// над счётчиками utils/loginGuard.js, которые ставят паузу раньше.
// Успешные входы не считаются, иначе рабочий сеанс упирался бы в лимит.
// Не считаются и ответы самой защиты — пауза и просьба решить задачу:
// пароль при них не проверялся, а нажатия «Войти» во время паузы иначе
// досрочно упирали бы человека в эти пятнадцать минут.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: LOGIN_LIMIT,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.statusCode < 400 || Boolean(res.locals.guardSoft),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Слишком много попыток. Попробуйте через 15 минут.' },
    handler: hit('login'),
});

// Регистрация: 5 аккаунтов с адреса в час.
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: REGISTER_LIMIT,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Слишком много регистраций с этого адреса. Попробуйте позже.' },
    handler: hit('register'),
});

// Письмо восстановления пароля: 5 запросов с адреса за 15 минут. Считаются
// все, а не только неудачные: ответ всегда одинаковый, и именно частота —
// единственное, что мешает забрасывать чужие ящики письмами.
const resetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Слишком много запросов. Попробуйте через 15 минут.' },
    handler: hit('password-reset'),
});

// Поиск адреса (routes/geocode.js): за нашим маршрутом стоит чужой
// общественный сервис, которому обещано не больше запроса в секунду. Очередь
// в utils/geocode.js это соблюдает, но без лимита одна страница в цикле
// заняла бы её на всех. Сорока хватает с избытком: адрес в форме ищут
// нажатием, а не на каждую букву.
const geocodeLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: Number(process.env.RATE_LIMIT_GEOCODE) || 40,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Слишком много запросов адреса. Попробуйте через несколько минут.' },
});

// Вложения в переписке: 60 файлов с адреса за 10 минут. Каждый файл — место
// в хранилище и, у видео, минута кодирования; живому человеку хватает
// с запасом, скрипту, заливающему хранилище, — нет.
const attachLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: Number(process.env.RATE_LIMIT_ATTACH) || 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Слишком много файлов. Попробуйте через несколько минут.' },
});

// Поиск (routes/search.js): открыт гостю, и каждый запрос — до четырёх
// проходов по коллекциям регулярным выражением. Шапка ищет по мере набора,
// поэтому потолок щедрый: 90 в минуту. Вошедшего считаем по нему самому —
// за адресом мобильного оператора сидят сотни людей; гостя — по адресу.
const searchLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.RATE_LIMIT_SEARCH) || 90,
    keyGenerator: (req) => (req.session && req.session.userId ? 'u:' + req.session.userId : rateLimit.ipKeyGenerator(req.ip)),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Слишком много запросов поиска. Подождите минуту.' },
});

module.exports = { authLimiter, registerLimiter, resetLimiter, geocodeLimiter, attachLimiter, searchLimiter };
