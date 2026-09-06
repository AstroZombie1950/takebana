// Express 4 не ловит отклонённые промисы из async-обработчиков: ошибка внутри
// такого обработчика не доходит до обработчика ошибок, ответ не отправляется,
// и запрос висит до таймаута клиента. Воспроизводилось, например, на
// GET /establishmentsLocation без параметров.
//
// asyncify подменяет методы роутера так, что каждый async-обработчик
// автоматически оборачивается в перехват ошибки. Это избавляет от нужды
// писать try/catch в каждом из сотни маршрутов.

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'all', 'use'];

function wrapHandler(h) {
    if (typeof h !== 'function') return h;
    if (h.constructor && h.constructor.name === 'AsyncFunction') {
        const wrapped = function (req, res, next) {
            Promise.resolve(h(req, res, next)).catch(next);
        };
        Object.defineProperty(wrapped, 'name', { value: h.name || 'asyncHandler' });
        return wrapped;
    }
    return h;
}

function asyncify(target) {
    for (const method of METHODS) {
        if (typeof target[method] !== 'function') continue;
        const original = target[method].bind(target);
        target[method] = function (...args) {
            return original(...args.map(wrapHandler));
        };
    }
    return target;
}

module.exports = { asyncify };
