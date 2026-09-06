// Проверки доступа для маршрутов.
//
// До этого каждый обработчик решал сам: часть проверяла req.session.userId
// внутри тела, часть не проверяла ничего. Из-за этого, например,
// PUT /updateEstablishment/:id позволял анониму переписать любое заведение,
// зная только его идентификатор.

// Пускает только вошедшего пользователя.
// Для обычных страниц отвечает редиректом на главную, для запросов из
// JavaScript — кодом 401, чтобы фронтенд мог показать «войдите».
function requireAuth(req, res, next) {
    if (req.session && req.session.userId) return next();

    if (req.accepts('html') && !req.xhr && req.method === 'GET') {
        return res.redirect('/');
    }
    return res.status(401).json({ message: 'Необходима авторизация' });
}

// Пускает владельца записи, а также администратора.
//
//   requireOwner(Establishments)                       — id берётся из req.params.id, владелец из поля owner
//   requireOwner(Stream, { param: 'streamId', field: 'userId' })
//
// Найденный документ кладётся в req.resource, чтобы обработчик не искал его заново.
function requireOwner(Model, options = {}) {
    const param = options.param || 'id';
    const field = options.field || 'owner';

    return async function (req, res, next) {
        try {
            if (!req.session || !req.session.userId) {
                return res.status(401).json({ message: 'Необходима авторизация' });
            }

            const id = req.params[param] || req.body[param];
            if (!id) {
                return res.status(400).json({ message: 'Не указан идентификатор' });
            }

            const doc = await Model.findById(id);
            if (!doc) {
                return res.status(404).json({ message: 'Запись не найдена' });
            }

            const ownerId = doc[field];
            const isOwner = ownerId && ownerId.toString() === req.session.userId.toString();

            if (!isOwner) {
                // администратору владение не требуется
                const User = require('../models/User');
                const user = await User.findById(req.session.userId).select('role');
                if (!user || user.role !== 'admin') {
                    return res.status(403).json({ message: 'Нет прав на эту запись' });
                }
            }

            req.resource = doc;
            return next();
        } catch (err) {
            return next(err);
        }
    };
}

// Оборачивает async-обработчик, чтобы ошибка внутри уходила в обработчик ошибок
// Express, а не оставляла запрос висеть навсегда: Express 4 сам отклонённые
// промисы не ловит.
function wrap(handler) {
    return function (req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

module.exports = { requireAuth, requireOwner, wrap };
