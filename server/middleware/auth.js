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

// То же самое, но для маршрутов /api/*: всегда JSON и всегда 401.
//
// requireAuth для GET-запросов, принимающих HTML, отвечает редиректом на главную —
// это верно для страниц, но не для API: обычный fetch() без заголовков посылает
// Accept: */*, получил бы 302 и HTML, а потом упал бы на .json(). Молча.
function requireAuthApi(req, res, next) {
    if (req.session && req.session.userId) return next();
    return res.status(401).json({ error: 'unauthorized' });
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

// Модерация: администратор и модератор.
//
// Роль модератора заведена рядом с администраторской, но пока не шире её:
// точный набор прав ещё обсуждается, и раздавать их авансом хуже, чем
// дать одну общую проверку и сузить её потом в одном месте.
//
// Владение проверяется отдельно (requireOwner): владелец эфира гасит свой
// эфир и чистит свой чат, но не трогает чужие.
function canModerate(user) {
    return !!user && (user.role === 'admin' || user.role === 'moderator');
}

function requireModerator(req, res, next) {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ message: 'Необходима авторизация' });
    }

    const User = require('../models/User');
    User.findById(req.session.userId).select('role')
        .then(user => {
            if (!canModerate(user)) {
                return res.status(403).json({ message: 'Нет прав модератора' });
            }
            return next();
        })
        .catch(next);
}

// Только администратор. Модератору сюда нельзя: раздача ролей — это выдача
// прав, а не модерация, и смешивать их означало бы, что модератор может
// назначить модератором кого угодно, включая себя же повторно.
function requireAdmin(req, res, next) {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ message: 'Необходима авторизация' });
    }

    const User = require('../models/User');
    User.findById(req.session.userId).select('role')
        .then(user => {
            if (!user || user.role !== 'admin') {
                return res.status(403).json({ message: 'Нужны права администратора' });
            }
            return next();
        })
        .catch(next);
}

// Бан затыкает запись, а не вход: страницы забаненный открывает, но отправить
// сообщение или выйти в эфир не может. Поэтому проверка вешается только на
// маршруты, которые что-то создают, — на чтении лишний запрос к базе не нужен.
//
// Состояние бана не кэшируется в сессии намеренно: иначе снятый бан продолжал
// бы действовать до перелогина, а выданный — не действовал бы вовсе.
function requireNotBanned(req, res, next) {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ message: 'Необходима авторизация' });
    }

    const User = require('../models/User');
    User.findById(req.session.userId).select('banned banReason')
        .then(user => {
            if (user && user.banned) {
                return res.status(403).json({
                    message: 'Аккаунт ограничен модерацией',
                    reason: user.banReason || ''
                });
            }
            return next();
        })
        .catch(next);
}

// Оборачивает async-обработчик, чтобы ошибка внутри уходила в обработчик ошибок
// Express, а не оставляла запрос висеть навсегда: Express 4 сам отклонённые
// промисы не ловит.
function wrap(handler) {
    return function (req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

module.exports = { requireAuth, requireAuthApi, requireOwner, canModerate, requireModerator, requireAdmin, requireNotBanned, wrap };
