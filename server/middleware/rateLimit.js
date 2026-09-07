// Ограничение частоты запросов.
//
// Вешается точечно — на вход, регистрацию и смену пароля. Глобальный лимит
// здесь не годится: страница эфира держит открытый сокет и дёргает несколько
// служебных маршрутов, и общий счётчик отрубал бы обычных зрителей.

const rateLimit = require('express-rate-limit');

// Пределы вынесены в переменные окружения: при отладке удобно поднять,
// чтобы не заблокировать самому себе вход десятком опечаток.
const LOGIN_LIMIT = Number(process.env.RATE_LIMIT_LOGIN) || 10;
const REGISTER_LIMIT = Number(process.env.RATE_LIMIT_REGISTER) || 5;

// Подбор пароля: 10 попыток с одного адреса за 15 минут.
// Успешные входы не считаются, иначе рабочий сеанс упирался бы в лимит.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: LOGIN_LIMIT,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Слишком много попыток. Попробуйте через 15 минут.' },
});

// Регистрация: 5 аккаунтов с адреса в час.
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: REGISTER_LIMIT,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Слишком много регистраций с этого адреса. Попробуйте позже.' },
});

module.exports = { authLimiter, registerLimiter };
