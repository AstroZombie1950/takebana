// Язык страниц и ответов сервера.
//
// Язык запроса — cookie `lang`, её ставит переключатель (public/tk-i18n.js).
//
// Страницы. Словарь интерфейса один — public/tk-i18n-ru.js и tk-i18n-en.js,
// сервер подключает те же файлы, что и браузер. Шаблоны берут строки через
// `t` и отдают страницу сразу на нужном языке; ключи `data-i18n` в разметке
// остаются для переключения без перезагрузки.
//
// Сообщения — «Эфир не найден», «Неверная почта или пароль», разбор полей
// из middleware/validate.js. Ключ здесь — сам русский текст, как он написан
// в маршруте: код остаётся читаемым, а строка без перевода показывается
// по-русски, а не пустой. Полноту проверяет temp/probe-i18n.mjs: каждая
// русская строка в message/label маршрутов обязана быть здесь.

const EN = {
    // Общие
    'Ошибка сервера': 'Server error',
    'Необходима авторизация': 'Please sign in',
    'Пользователь не авторизован': 'Please sign in',
    'Пользователь не аутентифицирован': 'Please sign in',
    'Недостаточно данных': 'Not enough data',
    'Не указан идентификатор': 'No identifier given',
    'Запись не найдена': 'Record not found',
    'Нет прав на эту запись': 'You have no rights to this record',
    'Нет прав модератора': 'Moderator rights required',
    'Нужны права администратора': 'Administrator rights required',
    'Аккаунт ограничен модерацией': 'Your account has been restricted by moderators',
    'Тело запроса должно быть объектом': 'The request body must be an object',
    'Слишком много попыток. Попробуйте через 15 минут.': 'Too many attempts. Try again in 15 minutes.',
    'Слишком много регистраций с этого адреса. Попробуйте позже.': 'Too many sign-ups from this address. Try again later.',
    'Слишком много запросов адреса. Попробуйте через несколько минут.': 'Too many address lookups. Try again in a few minutes.',

    // Вход, регистрация, профиль
    'Неверная почта или пароль': 'Invalid email or password',
    'Вход выполнен': 'Signed in',
    'Пользователь с такой почтой уже есть': 'A user with this email already exists',
    'Регистрация прошла успешно': 'Registration successful',
    'Пользователь не найден': 'User not found',
    'Профиль успешно обновлен': 'Profile updated',
    'Неверный старый пароль': 'The old password is incorrect',
    'Неверный текущий пароль': 'The current password is incorrect',
    'Слишком много запросов. Попробуйте через 15 минут.': 'Too many requests. Try again in 15 minutes.',

    // Восстановление пароля: ответы и письма (routes/passwordReset.js)
    'Если учётная запись с этой почтой есть, мы отправили на неё письмо со ссылкой': 'If an account with this email exists, we have sent it an email with a link',
    'Ссылка устарела или уже использована. Запросите новую': 'The link has expired or has already been used. Request a new one',
    'Пароль изменён': 'Password changed',
    'Ссылка': 'Link',
    'Восстановление пароля Takebana': 'Takebana password reset',
    'Кто-то — возможно, вы — попросил сменить пароль на Takebana для этой почты.': 'Someone, probably you, asked to reset the Takebana password for this email.',
    'Чтобы задать новый пароль, откройте ссылку. Она действует час и срабатывает один раз: {link}': 'To set a new password, open this link. It works for one hour and only once: {link}',
    'Если вы ничего не запрашивали, просто удалите письмо — пароль останется прежним.': 'If you did not ask for this, just delete this email. Your password stays the same.',
    'Для этой почты на Takebana пароля нет: вход — через Google.': 'There is no Takebana password for this email: you sign in with Google.',
    'Войти: {link}': 'Sign in: {link}',
    'Пароль успешно обновлен': 'Password updated',
    'Файл не передан': 'No file received',
    'Лимит 100 фото уже достигнут': 'The 100 photo limit has been reached',
    'Некорректное имя файла': 'Invalid file name',
    'Только изображения форматов JPEG, JPG, PNG разрешены.': 'Only JPEG, JPG and PNG images are allowed.',
    'Ошибка сервера при поиске пользователей': 'Server error while searching for users',

    // Подписки, уведомления, переписка
    'Необходимо войти в систему для подписки': 'Sign in to subscribe',
    'Необходимо войти в систему для отписки': 'Sign in to unsubscribe',
    'Вы уже подписаны на этого пользователя': 'You are already subscribed to this user',
    'Вы не подписаны на этого пользователя': 'You are not subscribed to this user',
    'Подписка успешно оформлена': 'Subscribed',
    'Отписка успешно выполнена': 'Unsubscribed',
    'Ошибка сервера при попытке подписаться': 'Server error while subscribing',
    'Ошибка сервера при попытке отписаться': 'Server error while unsubscribing',
    'Нельзя написать самому себе': 'You cannot message yourself',
    'Не указан ID получателя': 'No recipient given',
    'Диалог не найден': 'Conversation not found',
    'Выберите, кому переслать': 'Choose who to forward to',
    'Сообщение не найдено': 'Message not found',
    'Сообщение успешно отправлено и сохранено': 'Message sent',

    // Эфиры
    'Эфир не найден': 'Stream not found',
    'Стрим не найден': 'Stream not found',
    'Стрим не найден или уже завершен.': 'The stream was not found or has already ended.',
    'streamKey обязателен': 'streamKey is required',
    'Подкатегория не относится к выбранной категории': 'The subcategory does not belong to the selected category',
    'У вас уже есть эфир: завершите его, чтобы начать новый': 'You already have a stream: end it to start a new one',
    'Эфир завершён, запись сохраняется': 'The stream has ended, the recording is being saved',
    'Запись ещё сохраняется, удалить можно после': 'The recording is still being saved, you can delete it afterwards',
    'Источник': 'Source',
    'Сохранить запись': 'Save recording',
    'Стрим активирован': 'Stream activated',
    'Стрим деактивирован': 'Stream deactivated',
    'Заглавная картинка загружена.': 'Cover image uploaded.',
    'Изображение не загружено.': 'The image was not uploaded.',
    'Стрим успешно завершен и удален.': 'Stream ended and deleted.',
    'Эфир остановлен модерацией': 'The stream has been stopped by moderators',
    'Комната эфира не найдена': 'Stream room not found',
    'Сервис видео недоступен, попробуйте позже': 'The video service is unavailable, please try later',
    'Сервис видео перегружен запросами, попробуйте через несколько секунд': 'The video service is overloaded, try again in a few seconds',
    'Сервис видео не запустил трансляцию, попробуйте ещё раз': 'The video service did not start the broadcast, please try again',
    'Комната эфира не создана': 'The stream room has not been created',
    'Комната эфира — только для ведущего': 'The stream room is for the host only',

    // Заведения и адреса
    'Заведение не найдено': 'Establishment not found',
    'Заведение сейчас не показывает камеру': 'The establishment is not showing its camera right now',
    'Заявка отправлена': 'Application submitted',
    'Пожалуйста, укажите хотя бы одно поле для обновления': 'Please specify at least one field to update',
    'Нужны границы карты: bl_lat, bl_lng, tr_lat, tr_lng': 'Map bounds required: bl_lat, bl_lng, tr_lat, tr_lng',
    'Поиск адресов сейчас недоступен — поставьте метку на карте': 'Address search is unavailable right now — place the marker on the map',
    'Адрес короче трёх символов': 'The address is shorter than three characters',
    'Адрес не найден': 'Address not found',
    'Нужны координаты точки': 'Point coordinates required',
    'Адрес точки не определён': 'Could not determine the address of the point',

    // Модерация
    'Нельзя пожаловаться на себя': 'You cannot report yourself',
    'Вы уже жаловались на это': 'You have already reported this',
    'Жалоба не найдена': 'Report not found',
    'Свою роль менять нельзя': 'You cannot change your own role',
    'Нельзя ограничить модератора': 'A moderator cannot be restricted',
    'Нет прав остановить этот эфир': 'You have no rights to stop this stream',

    // Подписи полей в схемах validate
    'Адрес': 'Address',
    'Город': 'City',
    'Долгота': 'Longitude',
    'Заведение': 'Establishment',
    'Категория': 'Category',
    'Ключ трансляции': 'Stream key',
    'Комментарий': 'Comment',
    'Контент 18+': '18+ content',
    'Координаты': 'Coordinates',
    'Логин': 'Username',
    'Название': 'Name',
    'Новый пароль': 'New password',
    'Объект': 'Target',
    'Описание': 'Description',
    'Сообщения': 'Messages',
    'Кому': 'Recipients',
    'У всех': 'For everyone',
    'Оценка': 'Rating',
    'Пароль': 'Password',
    'Подкатегория': 'Subcategory',
    'Пользователь': 'User',
    'Почта': 'Email',
    'Прежняя обложка': 'Previous cover',
    'Причина': 'Reason',
    'Решение': 'Decision',
    'Роль': 'Role',
    'Собеседник': 'Recipient',
    'Сообщение': 'Message',
    'Старый пароль': 'Old password',
    'Статус': 'Status',
    'Страна': 'Country',
    'Страница': 'Page',
    'Текущий пароль': 'Current password',
    'Телефон': 'Phone',
    'Тип заведения': 'Establishment type',
    'Тип звонка': 'Call type',
    'Тип объекта': 'Target type',
    'Фотографии': 'Photos',
    'Часы по будням': 'Weekday hours',
    'Часы по выходным': 'Weekend hours',
    'Что сделано': 'Action taken',
    'Широта': 'Latitude',
    'Эфир': 'Stream',

    // Разбор полей в validate — шаблоны с подстановкой
    'ожидалась строка': 'must be a string',
    'слишком длинный адрес': 'the address is too long',
    'не похоже на адрес почты': 'does not look like an email address',
    'ожидался идентификатор': 'must be an identifier',
    'некорректный идентификатор': 'invalid identifier',
    'ожидался ключ': 'must be a key',
    'некорректный ключ': 'invalid key',
    'ожидалось целое число': 'must be a whole number',
    'ожидалось число': 'must be a number',
    'ожидалось да/нет': 'must be yes/no',
    'ожидался объект': 'must be an object',
    'ожидался список': 'must be a list',
    'не больше {max} элементов': 'no more than {max} items',
    'обязательное поле': 'required',
    'не разобрать JSON': 'invalid JSON',
    'не короче {min} символов': 'at least {min} characters',
    'не длиннее {max} символов': 'no more than {max} characters',
    'недопустимое значение': 'invalid value',
    'не меньше {min}': 'at least {min}',
    'не больше {max}': 'no more than {max}',
    'допустимо только: {values}': 'allowed values: {values}',
};

// Язык запроса. Без cookie — русский, как и сайт.
function langOf(req) {
    const m = /(?:^|;\s*)lang=(en|ru)(?:;|$)/.exec(req.headers.cookie || '');
    return m ? m[1] : 'ru';
}

// tr('en', 'не короче {min} символов', { min: 6 }) → 'at least 6 characters'
function tr(lang, text, vars) {
    const out = (lang === 'en' && EN[text]) || text;
    if (!vars) return out;
    return out.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined ? whole : vars[name]));
}

// Переводит `message` в JSON-ответах. Тело не меняется на месте, а
// копируется: лимитер входа отдаёт один и тот же объект всем запросам, и
// переведённый однажды текст достался бы потом русскому интерфейсу.
function localizeMessages(req, res, next) {
    if (langOf(req) !== 'en') return next();
    const json = res.json;
    res.json = function localizedJson(body) {
        if (body && typeof body.message === 'string' && EN[body.message]) {
            body = { ...body, message: EN[body.message] };
        }
        return json.call(this, body);
    };
    next();
}

const TK_I18N = { ru: require('../public/tk-i18n-ru'), en: require('../public/tk-i18n-en') };
const LOCALE = { ru: 'ru-RU', en: 'en-US' }; // как tkDate в браузере

// Часовой пояс посетителя — cookie `tz` из tk-i18n.js. Без неё или с чужим
// значением — пояс сервера.
function timeZoneOf(req) {
    const m = /(?:^|;\s*)tz=([\w+\-/]{1,64})(?:;|$)/.exec(req.headers.cookie || '');
    if (!m) return undefined;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: m[1] });
        return m[1];
    } catch (e) {
        return undefined; // RangeError: такого пояса нет
    }
}

// Для шаблонов: lang, t — строка словаря с разметкой (выводить `<%-`),
// ta — она же без разметки, для атрибутов и текста (`<%=`). Запасная строка
// или подстановки — как у t() в браузере:
//   t('user.photoN', { n: 2 })   ta(cat.i18n, cat.name)
// date — дата в локали и поясе посетителя, как tkDate в браузере:
//   date(user.lastSeen)   date(expiresAt, { day: '2-digit', month: '2-digit', year: 'numeric' })
function pageLocals(req, res, next) {
    const lang = langOf(req);
    const dict = TK_I18N[lang];
    const t = (key, arg) => {
        const v = dict[key];
        if (v === undefined) return typeof arg === 'string' ? arg : '';
        if (!arg || typeof arg !== 'object') return v;
        return v.replace(/\{(\w+)\}/g, (whole, name) => (arg[name] === undefined ? whole : arg[name]));
    };
    res.locals.lang = lang;
    res.locals.t = t;
    res.locals.ta = (key, arg) => t(key, arg).replace(/<[^>]*>/g, '');
    res.locals.date = (value, opts) =>
        new Date(value).toLocaleString(LOCALE[lang], { ...opts, timeZone: timeZoneOf(req) });
    // Одна и та же ссылка отдаёт разные страницы: кэш между сервером
    // и браузером (CDN) обязан различать их по cookie.
    const render = res.render;
    res.render = function renderVaryingByLang(...args) {
        this.vary('Cookie');
        return render.apply(this, args);
    };
    next();
}

module.exports = { EN, langOf, tr, localizeMessages, pageLocals };
