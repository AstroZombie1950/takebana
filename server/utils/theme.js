// Тема оформления (05.10): тёмная, светлая или как в системе.
//
// Выбор — cookie `theme`, её ставит переключатель (public/tk-theme.js), и
// сервер отдаёт страницу сразу в нужной теме: <html data-theme> в шаблоне,
// без вспышки тёмного перед светлым. Вошедшему выбор пишется и в аккаунт
// (User.theme, POST /settings/theme) — на новом устройстве тема та же:
// commonDataMiddleware берёт её из аккаунта и ставит cookie.
//
// «Как в системе» сервер не знает, какая система у человека: страница
// приходит тёмной с пометкой data-theme-auto, а строка в partials/tkHead.ejs
// до первой отрисовки переключает её на светлую, если система светлая.
//
// Цвета обеих тем — public/css/tk.css, блок «Токены».

const THEMES = ['dark', 'light', 'auto'];
const DEFAULT = 'dark';
const COOKIE = { maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax', path: '/' };

function themeOf(req) {
    const m = /(?:^|;\s*)theme=(dark|light|auto)(?:;|$)/.exec(req.headers.cookie || '');
    return m ? m[1] : DEFAULT;
}

// Для шаблонов: theme — выбор человека, themeOn — что рисуем на сервере.
function set(res, theme) {
    res.locals.theme = theme;
    res.locals.themeOn = theme === 'light' ? 'light' : 'dark';
}

function pageLocals(req, res, next) {
    set(res, themeOf(req));
    next();
}

// Выбор из аккаунта поверх cookie — commonDataMiddleware, когда аккаунт
// уже загружен. В аккаунте пусто — туда уходит выбор, сделанный до входа.
function fromAccount(req, res, user) {
    const own = themeOf(req);
    if (!user.theme) return own === DEFAULT ? null : own;
    if (user.theme !== own) {
        res.cookie('theme', user.theme, COOKIE);
        set(res, user.theme);
    }
    return null;
}

module.exports = { THEMES, COOKIE, themeOf, pageLocals, fromAccount };
