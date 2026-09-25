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
    'Не найдено': 'Not found',
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
    // Защита от подбора (utils/loginGuard.js)
    'Подтвердите, что вы не робот': 'Please confirm you are not a robot',
    'Слишком много неудачных попыток. Попробуйте через {min} мин. или восстановите пароль': 'Too many failed attempts. Try again in {min} min or reset your password',
    'Осталось две попытки, потом вход приостановится': 'Two attempts left before sign-in is paused',
    'Осталась одна попытка, потом вход приостановится': 'One attempt left before sign-in is paused',
    'Проверка': 'Verification',
    'Ответ': 'Reply',
    // Описание и ссылки профиля (utils/profileLinks.js)
    'Описание': 'Description',
    // Подпись к фото галереи (routes/watch.js)
    'Подпись': 'Caption',
    'Ссылки': 'Links',
    'Индексировать': 'Index',
    // Группы (routes/groups.js)
    'Группа не найдена': 'Group not found',
    'Это могут только администраторы группы': 'Only group admins can do this',
    'Участники': 'Members',
    'Участник': 'Member',
    'В группе не больше 100 участников': 'A group can have at most 100 members',
    'Такого участника в группе нет': 'No such member in the group',
    'Удалить администратора может только создатель группы': 'Only the group creator can remove an admin',
    'Роли назначает создатель группы': 'Only the group creator assigns roles',
    'Удалить группу может только создатель': 'Only the creator can delete the group',
    'Срок': 'Duration',
    'Ссылка не работает: её выключили или перевыпустили': 'This link no longer works: it was turned off or replaced',
    'В группах нет исчезающих сообщений': 'Disappearing messages are not available in groups',
    'Звонки в группах сейчас недоступны': 'Group calls are unavailable right now',
    'Сейчас никого из группы нет в сети': 'Nobody from the group is online right now',
    'Сайт: нужна ссылка вида https://example.com': 'Website: a link like https://example.com is required',
    'YouTube: нужен @канал или ссылка youtube.com/@канал': 'YouTube: enter @channel or a youtube.com/@channel link',
    'Instagram: нужен логин или ссылка instagram.com/логин': 'Instagram: enter a username or an instagram.com/username link',
    'TikTok: нужен @логин или ссылка tiktok.com/@логин': 'TikTok: enter @username or a tiktok.com/@username link',
    'Telegram: нужен логин, номер телефона или ссылка t.me/логин': 'Telegram: enter a username, a phone number or a t.me/username link',
    'WhatsApp: нужен номер телефона или ссылка wa.me/номер': 'WhatsApp: enter a phone number or a wa.me/number link',
    'Вход выполнен': 'Signed in',
    'Пользователь с такой почтой уже есть': 'A user with this email already exists',
    'Регистрация прошла успешно': 'Registration successful',
    'Пользователь не найден': 'User not found',
    'Профиль успешно обновлен': 'Profile updated',
    'Неверный старый пароль': 'The old password is incorrect',
    'Неверный пароль': 'Incorrect password',
    'Аккаунт входит через Google, пароля у него нет': 'This account signs in with Google and has no password',
    'Пароль другого администратора сменить нельзя': 'You cannot change another administrator\u2019s password',
    'Аккаунт администратора удаляется только из панели': 'An administrator account can only be deleted from the admin panel',
    'Неверный текущий пароль': 'The current password is incorrect',
    'Слишком много запросов. Попробуйте через 15 минут.': 'Too many requests. Try again in 15 minutes.',

    // Подписчики и ограничение доступа (routes/streaming/subscriptions.js)
    'Автор ограничил вам доступ к своему каналу': 'The author has restricted your access to their channel',
    'Себе ограничить доступ нельзя': 'You cannot restrict yourself',
    'Ограничение': 'Restriction',
    'Вы ограничили доступ этому человеку — сначала верните его': 'You have restricted this person \u2014 restore their access first',
    'Автор ограничил вам доступ — написать и позвонить нельзя': 'The author has restricted your access \u2014 you cannot message or call them',

    // Приватность (utils/privacy.js) и официальный аккаунт
    'Приватность': 'Privacy',
    'Человек принимает сообщения только от своих контактов': 'This person only accepts messages from their contacts',
    'Человек не принимает новые сообщения': 'This person does not accept new messages',
    'Человек принимает звонки только от своих контактов': 'This person only accepts calls from their contacts',
    'Человек не принимает звонки': 'This person does not accept calls',
    'Добавить в группу этого человека могут только его контакты': 'Only this person\'s contacts can add them to groups',
    'Этот человек не разрешает добавлять себя в группы': 'This person does not allow being added to groups',
    'Автор принимает комментарии только от подписчиков': 'The author only accepts comments from followers',
    'Автор закрыл комментарии': 'The author has turned off comments',
    'Официальный аккаунт ограничить нельзя': 'An official account cannot be restricted',

    // Поддержка и рассылка в панели (routes/admin/support.js)
    'Аккаунт поддержки не выбран': 'No support account chosen',
    'Аккаунтом поддержки может быть только администратор': 'Only an administrator can be the support account',
    'Напишите текст рассылки': 'Write the broadcast text',
    'Предыдущая рассылка ещё идёт': 'The previous broadcast is still running',
    'Проверку отправьте из личного аккаунта администратора: этот — аккаунт поддержки': 'Send the test from a personal administrator account: this one is the support account',
    'Аккаунт': 'Account',
    'Приветствие': 'Welcome',
    'Текст': 'Text',
    'Заготовка': 'Template',
    'Пуш': 'Push',
    'Дней': 'Days',

    // Контакты (routes/contacts.js)
    'Себя в контакты добавить нельзя': 'You cannot add yourself to contacts',
    'Контакт не найден': 'Contact not found',

    // Пуш-уведомления (routes/push.js)
    'Пуш-уведомления не настроены': 'Push notifications are not set up',
    'Негодная подписка': 'Invalid subscription',
    'Ни одно устройство не подписано': 'No device is subscribed',

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
    'Только изображения JPEG, PNG или WebP.': 'Only JPEG, PNG or WebP images.',
    'Файл слишком большой': 'The file is too large',
    'Ошибка загрузки файла': 'File upload failed',
    'Не удалось обработать изображение': 'Could not process the image',

    // Вложения переписки и сообщения с ограничением (utils/attachments.js,
    // utils/messageLimit.js)
    'Файл не пришёл': 'No file received',
    'Неверный запрос': 'Invalid request',
    'Файлы сейчас не принимаются': 'Files are not accepted right now',
    'Такие файлы не принимаем': 'This file type is not accepted',
    'Файл больше 10 МБ': 'The file is larger than 10 MB',
    'Файл больше 25 МБ': 'The file is larger than 25 MB',
    'Файл больше 50 МБ': 'The file is larger than 50 MB',
    'Файл больше 200 МБ': 'The file is larger than 200 MB',
    'Содержимое файла не совпадает с его типом': 'The file contents do not match its type',
    'Изображение не распознано': 'Could not read the image',
    'В файле нет звука': 'The file has no audio',
    'В файле нет видео': 'The file has no video',
    'Видео длиннее 10 минут': 'The video is longer than 10 minutes',
    'Голосовое не распознано': 'Could not read the voice message',
    'Голосовое слишком большое': 'The voice message is too large',
    'Голосовое длиннее 5 минут': 'The voice message is longer than 5 minutes',
    'Кружок не распознан': 'Could not read the video message',
    'Кружок слишком большой': 'The video message is too large',
    'Кружок длиннее минуты': 'The video message is longer than a minute',
    'Не удалось обработать видео': 'Could not process the video',
    'Слишком много файлов. Попробуйте через несколько минут.': 'Too many files. Try again in a few minutes.',
    'Слишком много файлов за раз': 'Too many files at once',
    'Неверное ограничение': 'Invalid limit',
    'Сообщение больше недоступно': 'The message is no longer available',
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
    'Слишком много сразу: выберите меньше сообщений или адресатов': 'Too many at once: choose fewer messages or recipients',
    'Сообщение не найдено': 'Message not found',
    'Сообщение успешно отправлено и сохранено': 'Message sent',
    'На себя подписаться нельзя': 'You cannot subscribe to yourself',
    'Слишком много сообщений. Подождите минуту.': 'Too many messages. Wait a minute.',
    'Слишком много запросов поиска. Подождите минуту.': 'Too many searches. Wait a minute.',
    'Слишком много звонков. Подождите минуту.': 'Too many calls. Wait a minute.',

    // Эфиры
    'Эфир не найден': 'Stream not found',
    'Стрим не найден': 'Stream not found',
    'Стрим не найден или уже завершен.': 'The stream was not found or has already ended.',
    'Эфир сейчас не идёт': 'The stream is not live right now',
    'Эфир для 18+: подтвердите возраст': 'This stream is 18+: confirm your age',
    'Слишком часто. Подождите пару секунд.': 'Too fast. Wait a couple of seconds.',
    'Включён медленный режим — подождите': 'Slow mode is on — please wait',
    'Пауза': 'Pause',
    'Ключ меняется, когда эфира нет: сначала завершите его': 'The key can only be changed when there is no stream: end it first',
    'streamKey обязателен': 'streamKey is required',
    'Подкатегория не относится к выбранной категории': 'The subcategory does not belong to the selected category',
    'У вас уже есть эфир: завершите его, чтобы начать новый': 'You already have a stream: end it to start a new one',
    'Эфир завершён, запись сохраняется': 'The stream has ended, the recording is being saved',
    'Слишком много комментариев. Подождите минуту.': 'Too many comments. Wait a minute.',
    'Комментарий не найден': 'Comment not found',
    'Нет прав на этот комментарий': 'You have no rights to this comment',
    'Некорректная дата': 'Invalid date',
    'Запись для 18+: подтвердите возраст': 'This recording is 18+: confirm your age',
    'Почта входа через Google меняется в аккаунте Google': 'The email of a Google sign-in is changed in your Google account',
    'Это и есть ваша почта': 'This is already your email',
    'Эта почта уже занята другим аккаунтом': 'This email is already used by another account',
    'Письмо уже отправлено. Повторить можно через минуту': 'The email has already been sent. You can repeat in a minute',
    'Письмо со ссылкой отправлено на новую почту': 'A link has been sent to the new email',
    'Подтвердите новую почту Takebana': 'Confirm your new Takebana email',
    'Чтобы сделать этот адрес почтой вашего аккаунта Takebana, откройте ссылку. Она действует сутки: {link}': 'To make this the email of your Takebana account, open the link. It is valid for 24 hours: {link}',
    'Если вы ничего не меняли, просто удалите письмо.': 'If you did not change anything, just delete this email.',
    'Смена почты Takebana': 'Takebana email change',
    'Подтвердите почту Takebana': 'Confirm your Takebana email',
    'Чтобы подтвердить почту аккаунта Takebana, откройте ссылку. Она действует сутки: {link}': 'To confirm the email of your Takebana account, open the link. It is valid for 24 hours: {link}',
    'Если вы не регистрировались на Takebana, просто удалите письмо.': 'If you did not sign up for Takebana, just delete this email.',
    'Почта уже подтверждена': 'The email is already confirmed',
    'Фото не найдено': 'Photo not found',
    'Письмо со ссылкой отправлено': 'A link has been sent',
    'В вашем аккаунте Takebana запросили смену почты на {email}. Почта сменится, только когда по ссылке из письма на новый адрес перейдут.': 'A change of your Takebana email to {email} was requested. It only takes effect once the link sent to the new address is opened.',
    'Если это не вы — смените пароль: {link}': 'If it was not you, change your password: {link}',
    'Никнейм': 'Nickname',
    'Имя': 'Name',
    'Ник: 3–20 знаков — латинские буквы, цифры и «_», первая — буква': 'Nickname: 3–20 characters — Latin letters, digits and “_”, starting with a letter',
    'Этот ник зарезервирован': 'This nickname is reserved',
    'Этот ник уже занят': 'This nickname is already taken',
    'Ник можно менять раз в 30 дней': 'The nickname can be changed once every 30 days',
    'Видео сейчас не принимаются': 'Videos are not accepted right now',
    'В галерее уже 30 видео — удалите что-нибудь': 'The gallery already has 30 videos — delete something first',
    'Видео не найдено': 'Video not found',
    // Страница загрузки (routes/streaming/upload.js)
    'Неверный кусок файла': 'Invalid file chunk',
    'Кусок пришёл не целиком': 'The file chunk arrived incomplete',
    'Видео короче секунды': 'The video is shorter than a second',
    'Имя файла': 'File name',
    'Размер': 'Size',
    'Начало': 'Start',
    'Конец': 'End',
    'Без звука': 'Without sound',
    'Кадр обложки': 'Cover frame',
    'Опубликовать': 'Publish',
    'Только видео': 'Videos only',
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
    'Ошибка не найдена': 'Error not found',
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
    'Объект жалобы не найден': 'The reported item was not found',
    'Свою роль менять нельзя': 'You cannot change your own role',
    'Нельзя ограничить модератора': 'A moderator cannot be restricted',
    'Себя удалить нельзя': 'You cannot delete yourself',
    'Администратора удалить нельзя — сначала смените роль': 'An administrator cannot be deleted — change the role first',
    'Нет прав остановить этот эфир': 'You have no rights to stop this stream',

    // Подписи полей в схемах validate
    'Адрес': 'Address',
    'Город': 'City',
    'Долгота': 'Longitude',
    'Заведение': 'Establishment',
    'Категория': 'Category',
    'Ключ трансляции': 'Stream key',
    'Вертикальная камера': 'Vertical camera',
    'Кадр': 'Frame',
    'Звонки': 'Calls',
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
    'Возврат': 'Return address',
    'Обложка': 'Cover',
    'Причина': 'Reason',
    'Решение': 'Decision',
    'Роль': 'Role',
    'Собеседник': 'Recipient',
    'Откуда': 'Source',
    'Избранное': 'Favourite',
    'Сообщение': 'Message',
    'Старый пароль': 'Old password',
    'Статус': 'Status',
    'Страна': 'Country',
    'Страница': 'Page',
    'Текущий пароль': 'Current password',
    'Телефон': 'Phone',
    'Тип заведения': 'Establishment type',
    'Тип звонка': 'Call type',
    'Свой путь': 'Own path',
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

// Язык запроса: выбор человека — cookie `lang`; без неё — по языку браузера
// (docs/seo/DECISIONS.md, 24.09): русский, если русский у него первым,
// иначе английский. Аудитория международная, английский — основной, и робот
// поиска, который приходит без cookie и чаще всего без Accept-Language,
// видит английскую версию. Первый же ответ браузер запоминает в cookie
// (public/tk-i18n.js), дальше язык не прыгает.
//
// SITE_LANG=ru|en — без cookie всегда этот язык, без угадывания. Нужен
// зондам: безголовый Chrome шлёт en-US, а ждут они русский (temp/run-probes.sh).
const SITE_LANG = /^(ru|en)$/.test(process.env.SITE_LANG || '') ? process.env.SITE_LANG : '';

function browserLang(header) {
    let best = null, bestQ = -1;
    for (const part of String(header || '').split(',')) {
        const [tag, ...params] = part.trim().toLowerCase().split(';');
        const q = params.reduce((v, p) => (/^\s*q=/.test(p) ? parseFloat(p.split('=')[1]) : v), 1);
        if (tag && tag !== '*' && q > bestQ) { best = tag; bestQ = q; }
    }
    return best && best.split('-')[0] === 'ru' ? 'ru' : 'en';
}

function langOf(req) {
    const m = /(?:^|;\s*)lang=(en|ru)(?:;|$)/.exec(req.headers.cookie || '');
    if (m) return m[1];
    return SITE_LANG || browserLang(req.headers['accept-language']);
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

// Строка словаря по языку, без запроса. Шаблонам её подаёт pageLocals ниже
// (он же t), а отдельно она нужна там, где запроса нет вовсе: текст пуша
// собирается для спящего устройства, и язык берётся из его подписки
// (utils/push.js). Запасная строка и подстановки — как у t() в браузере.
function text(lang, key, arg) {
    const v = TK_I18N[lang === 'en' ? 'en' : 'ru'][key];
    if (v === undefined) return typeof arg === 'string' ? arg : '';
    if (!arg || typeof arg !== 'object') return v;
    return v.replace(/\{(\w+)\}/g, (whole, name) => (arg[name] === undefined ? whole : arg[name]));
}

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
    const t = (key, arg) => text(lang, key, arg);
    res.locals.lang = lang;
    res.locals.t = t;
    res.locals.ta = (key, arg) => t(key, arg).replace(/<[^>]*>/g, '');
    // Число с разрядами по языку: 12 345 / 12,345.
    res.locals.num = (n) => Number(n || 0).toLocaleString(LOCALE[lang]);
    // Форма слова по числу: plural(5, 'rec.views') → ключ rec.viewsMany.
    // По-английски «few» и «many» совпадают — правила годятся обоим языкам.
    res.locals.plural = (n, base, vars) => {
        const d10 = n % 10, d100 = n % 100;
        const form = d10 === 1 && d100 !== 11 ? 'One' : d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14) ? 'Few' : 'Many';
        return { key: base + form, text: t(base + form, { n: n.toLocaleString(LOCALE[lang]), ...vars }) };
    };
    res.locals.date = (value, opts) =>
        new Date(value).toLocaleString(LOCALE[lang], { ...opts, timeZone: timeZoneOf(req) });
    // Одна и та же ссылка отдаёт разные страницы: кэш между сервером
    // и браузером (CDN) обязан различать их по cookie.
    const render = res.render;
    res.render = function renderVaryingByLang(...args) {
        this.vary('Cookie');
        this.vary('Accept-Language');
        return render.apply(this, args);
    };
    next();
}

module.exports = { EN, langOf, tr, text, localizeMessages, pageLocals };
