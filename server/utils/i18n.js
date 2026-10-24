// Язык страниц и ответов сервера.
//
// Язык запроса — адрес публичной страницы, иначе выбор и cookie (langOf ниже).
//
// Страницы. Словарь интерфейса один — public/tk-i18n-<код>.js, сервер
// подключает те же файлы, что и браузер. Шаблоны берут строки через
// `t` и отдают страницу сразу на нужном языке; ключи `data-i18n` в разметке
// остаются для переключения без перезагрузки.
//
// Сообщения — «Эфир не найден», «Неверная почта или пароль», разбор полей
// из middleware/validate.js, письма. Ключ здесь — сам русский текст, как он
// написан в маршруте: код остаётся читаемым, а строка без перевода
// показывается по-английски, а нет английской — по-русски, но не пустой.
// Английские — ниже (EN), других языков — utils/i18n-<код>.js. Полноту
// проверяет temp/probe-i18n.mjs: каждая русская строка в message/label
// маршрутов обязана быть в EN, а строки EN — в картах других языков.
//
// Языки — список в utils/langs.js.

const { LANGS, LANG_CODES, BASE_LANG, FALLBACK_LANG, SITE_LANG, isLang, toLang, localeOf } = require('./langs');
const { PUBLIC, langPath, langUrl, localizeHtml, localizeUrls } = require('./langUrl');
const { itemLang, profileLang, venueLang } = require('./contentLang');

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
    // Дата рождения и встречи в заведениях (07.10)
    'Дата рождения': 'Date of birth',
    'Дата рождения указана неверно': 'The date of birth is invalid',
    'Дата рождения уже указана': 'The date of birth is already set',
    'По дате рождения вам меньше 18 лет': 'According to your date of birth, you are under 18',
    'Укажите дату рождения': 'Please enter your date of birth',
    'Встречи — только с 18 лет': 'Meetups are 18+ only',
    'День': 'Day',
    'Время': 'Time',
    'Время указано неверно': 'The time is invalid',
    'Выберите день от сегодня и не дальше чем через 60 дней': 'Choose a day from today up to 60 days ahead',
    'Открытых отметок может быть не больше трёх': 'You can have up to three open meetups',
    'Вы уже отметились здесь на этот день': 'You have already posted here for this day',
    'Отметка не найдена': 'Meetup not found',
    'Это ваша отметка': 'This is your meetup',
    'Мест больше нет': 'No places left',
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
    // Тема оформления (routes/userRoutes.js)
    'Тема': 'Theme',
    'Индексировать': 'Index',
    // Посты (routes/posts.js, 09.10), выбор из библиотеки в переписке
    // (routes/messages.js), тема эфира (routes/streams.js)
    'Слишком много постов подряд — попробуйте через час': 'Too many posts in a row — try again in an hour',
    'Видео': 'Video',
    'Порядок': 'Order',
    'Группа': 'Group',
    'Вид': 'Type',
    'Фото или видео не найдено — возможно, его удалили': 'Photo or video not found — it may have been deleted',
    'Тема не относится к выбранному разделу': 'The topic does not belong to the selected section',
    // Группы (routes/groups.js)
    'Группа не найдена': 'Group not found',
    'Это могут только администраторы группы': 'Only group admins can do this',
    // Панель диалога (17.10, routes/chatInfo.js)
    'Это сообщение нельзя закрепить': 'This message cannot be pinned',
    'Неверный срок': 'Invalid duration',
    'Слишком много поисков. Подождите минуту.': 'Too many searches. Please wait a minute.',
    'Поиск занял слишком много времени — уточните запрос': 'The search took too long — try a more specific query',
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
    'Вы ограничили доступ этому пользователю — сначала верните его': 'You have restricted this user \u2014 restore their access first',
    'Автор ограничил вам доступ — написать и позвонить нельзя': 'The author has restricted your access \u2014 you cannot message or call them',

    // Приватность (utils/privacy.js) и официальный аккаунт
    'Приватность': 'Privacy',
    'Пользователь принимает сообщения только от своих контактов': 'This user only accepts messages from their contacts',
    'Пользователь не принимает новые сообщения': 'This user does not accept new messages',
    'Пользователь принимает звонки только от своих контактов': 'This user only accepts calls from their contacts',
    'Пользователь не принимает звонки': 'This user does not accept calls',
    'Добавить в группу этого пользователя могут только его контакты': 'Only this user\'s contacts can add them to groups',
    'Этот пользователь не разрешает добавлять себя в группы': 'This user does not allow being added to groups',
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
    'В галерее уже предельное число фото — удалите что-нибудь': 'The gallery already has the maximum number of photos — delete something first',
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
    'Видео длиннее, чем можно отправить': 'The video is longer than allowed',
    'Голосовое не распознано': 'Could not read the voice message',
    'Голосовое слишком большое': 'The voice message is too large',
    'Голосовое длиннее, чем можно записать': 'The voice message is longer than allowed',
    'Кружок не распознан': 'Could not read the video message',
    'Кружок слишком большой': 'The video message is too large',
    'Кружок длиннее, чем можно записать': 'The video message is longer than allowed',
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
    'Выберите, кому отправить': 'Choose who to send to',
    'Публикация не найдена': 'Post not found',
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
    'Эфир только для подписчиков': 'This stream is for subscribers only',
    'Только для подписчиков': 'Subscribers only',
    'Правки на проверке нет': 'There are no changes awaiting review',
    'Неизвестное действие': 'Unknown action',
    'Ничего не выбрано': 'Nothing selected',
    'Слишком часто. Подождите пару секунд.': 'Too fast. Wait a couple of seconds.',
    'Слишком часто. Подождите минуту.': 'Too many requests. Wait a minute.',
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
    'Ссылки в описании — только на людей Takebana: @ник': 'Links in a description can only point to people on Takebana: @nickname',
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
    'В галерее уже предельное число видео — удалите что-нибудь': 'The gallery already has the maximum number of videos — delete something first',
    'Видео больше, чем можно загрузить': 'The video is larger than the upload limit',
    'Дождитесь, пока загрузятся начатые видео, или удалите черновик': 'Wait for the videos you started to finish uploading, or delete a draft',
    // Мало места на диске (utils/diskGuard.js)
    'Сервер временно не принимает видео и файлы — попробуйте позже': 'The server is not accepting videos and files right now — try again later',
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
    'Связь с видеосервисом прервалась — проверьте интернет и нажмите ещё раз': 'The connection to the video service dropped — check your internet and press again',
    'Комната эфира не создана': 'The stream room has not been created',
    'Нет такого эфира': 'No such stream',
    'Нет такого звонка': 'No such call',
    'Нет такого заведения': 'No such venue',
    'У эфира нет комнаты Daily — OBS или эфир до 2 октября': 'The stream has no Daily room — OBS or a stream before October 2',
    'Daily не ответил': 'Daily did not respond',
    'Нет такого режима': 'No such mode',
    'Комната эфира — только для ведущего': 'The stream room is for the host only',

    // Заведения и адреса
    'Заведение не найдено': 'Establishment not found',
    'Заявка уже на проверке: следующую можно подать после решения по ней': 'An application is already under review: you can submit the next one once it is decided',
    'Достигнут предел заведений на одного человека': 'You have reached the limit of venues per person',
    // Тип, страна, город — справочник или своё (utils/places.js, 30.09)
    'Укажите тип заведения': 'Specify the type of establishment',
    'Укажите страну': 'Specify the country',
    'Укажите город': 'Specify the city',
    'Своё заведение оценить нельзя': 'You cannot rate your own establishment',
    'Своего значения у заведения нет': 'The establishment has no custom value',
    'Сначала добавьте в список страну': 'Add the country to the list first',
    'Видео-меню': 'Video menu',
    'Вести эфир можно только от своего одобренного заведения': 'You can only stream on behalf of your own approved venue',
    'Загружать можно только от своего одобренного заведения': 'You can only upload on behalf of your own approved venue',
    // Видео-меню (routes/venueMenu.js)
    'Меню заводится у одобренного заведения': 'The menu is available once the venue is approved',
    'В меню уже 100 позиций': 'The menu already has 100 items',
    'Позиция не найдена': 'Menu item not found',
    'Прежний ролик ещё обрабатывается': 'The previous clip is still being processed',
    'Раздел': 'Section',
    'Цена': 'Price',
    'Куда': 'Direction',
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
    'Что': 'Item',
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

// Язык запроса (docs/seo/LANGUAGES.md, §5.3):
//   1. публичная страница — язык её адреса (req.urlLang, middleware/langPrefix.js);
//   2. запрос скрипта — язык страницы, с которой он пришёл (X-TK-Lang, tk-net.js);
//   3. cookie `lang_choice` — выбор в меню языка;
//   4. cookie `lang` — язык последней публичной страницы (public/tk-i18n.js):
//      по нему закрытые страницы (переписка, вход, студия) продолжают язык,
//      на котором человек ходил по сайту;
//   5. SITE_LANG, иначе первый язык браузера, если он есть у сайта, иначе
//      основной. Робот поиска приходит без cookie и Accept-Language.

// Первый по весу язык Accept-Language, если он есть у сайта, иначе основной.
function browserLang(header) {
    let best = null, bestQ = -1;
    for (const part of String(header || '').split(',')) {
        const [tag, ...params] = part.trim().toLowerCase().split(';');
        const q = params.reduce((v, p) => (/^\s*q=/.test(p) ? parseFloat(p.split('=')[1]) : v), 1);
        if (tag && tag !== '*' && q > bestQ) { best = tag; bestQ = q; }
    }
    return toLang(best && best.split('-')[0]);
}

const cookieRx = (name) => new RegExp('(?:^|;\\s*)' + name + '=(' + LANG_CODES.join('|') + ')(?:;|$)');
const CHOICE_COOKIE = cookieRx('lang_choice');
const LAST_COOKIE = cookieRx('lang');

// Выбор в меню языка (cookie `lang_choice`) или ''.
const langChoice = (req) => (CHOICE_COOKIE.exec(req.headers.cookie || '') || [])[1] || '';

function langOf(req) {
    if (req.urlLang) return req.urlLang;
    const header = req.headers['x-tk-lang'];
    if (isLang(header)) return header;
    const cookie = req.headers.cookie || '';
    const m = CHOICE_COOKIE.exec(cookie) || LAST_COOKIE.exec(cookie);
    if (m) return m[1];
    return SITE_LANG || browserLang(req.headers['accept-language']);
}

// Подстановки {имя}. Строки словаря с разметкой выводятся как есть (`<%-`),
// поэтому в шаблоны значения идут экранированными (wrap = escapeHtml):
// в них бывают имена и названия (аудит 14.10, S7).
const fill = (s, vars, wrap = String) =>
    s.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined ? whole : wrap(vars[name])));
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Карты сообщений по языкам, ключ — русский текст: английская — здесь,
// остальные — utils/i18n-<код>.js. Нет строки — английская (не «основного
// языка»: у зондов основной — русский, SITE_LANG).
const KEY_LANG = 'ru';
const MESSAGES = Object.fromEntries(LANG_CODES.filter((l) => l !== KEY_LANG)
    .map((l) => [l, l === 'en' ? EN : require('./i18n-' + l)]));

// tr('en', 'не короче {min} символов', { min: 6 }) → 'at least 6 characters'
function tr(lang, text, vars) {
    const out = lang === KEY_LANG ? text : (MESSAGES[lang] || {})[text] || EN[text] || text;
    return vars ? fill(out, vars) : out;
}

// Переводит `message` в JSON-ответах. Тело не меняется на месте, а
// копируется: лимитер входа отдаёт один и тот же объект всем запросам, и
// переведённый однажды текст достался бы потом русскому интерфейсу.
function localizeMessages(req, res, next) {
    const lang = langOf(req);
    if (lang === KEY_LANG) return next();
    const json = res.json;
    res.json = function localizedJson(body) {
        if (body && typeof body.message === 'string') {
            const message = tr(lang, body.message);
            if (message !== body.message) body = { ...body, message };
        }
        return json.call(this, body);
    };
    next();
}

const TK_I18N = Object.fromEntries(LANG_CODES.map((l) => [l, require('../public/tk-i18n-' + l)]));
const { meaningful } = require('./snippet');

// Строка словаря: своя, нет её — запасного языка.
function lookup(lang, key) {
    const v = TK_I18N[toLang(lang)][key];
    return v === undefined ? TK_I18N[FALLBACK_LANG][key] : v;
}

// Строка словаря по языку, без запроса. Шаблонам её подаёт pageLocals ниже
// (он же t), а отдельно она нужна там, где запроса нет вовсе: текст пуша
// собирается для спящего устройства, и язык берётся из его подписки
// (utils/push.js). Запасная строка и подстановки — как у t() в браузере.
function text(lang, key, arg, wrap) {
    const v = lookup(lang, key);
    if (v === undefined) return typeof arg === 'string' ? arg : '';
    return arg && typeof arg === 'object' ? fill(v, arg, wrap) : v;
}

// Форма слова по числу: суффикс ключа One / Few / Many. Правила языка —
// из Intl (у английского и испанского «21» — уже Many, у русского — One);
// «other» и всё, чего в словаре нет, — Many.
const PLURAL = new Map(LANG_CODES.map((l) => [l, new Intl.PluralRules(LANGS[l].plural || LANGS[l].locale)]));
const FORM = { one: 'One', few: 'Few', many: 'Many' };
const pluralForm = (lang, n) => FORM[PLURAL.get(toLang(lang)).select(n)] || 'Many';

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
    const locale = localeOf(lang);
    const t = (key, arg) => text(lang, key, arg, escapeHtml);
    res.locals.lang = lang;
    res.locals.langInfo = LANGS[lang];
    res.locals.siteLangs = LANGS;
    // Публичная страница: её версии на всех языках — для меню языка
    // (с метками адреса) и <head> (без них). Закрытая — null.
    res.locals.urlLang = req.urlLang || null;
    res.locals.langAlt = req.urlLang
        ? Object.fromEntries(LANG_CODES.map((l) => [l, langPath(l, req.path + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''))]))
        : null;
    res.locals.baseLang = BASE_LANG;
    res.locals.publicRx = PUBLIC.source;
    res.locals.langPath = langPath;
    res.locals.langUrl = langUrl;
    res.locals.localizeUrls = localizeUrls;
    // Язык содержимого людей для seo.lang (utils/contentLang.js).
    res.locals.itemLang = itemLang;
    res.locals.profileLang = profileLang;
    res.locals.venueLang = venueLang;
    res.locals.t = t;
    // Без разметки: подстановки сырые, экранирует сам вывод `<%=`.
    res.locals.ta = (key, arg) => text(lang, key, arg).replace(/<[^>]*>/g, '');
    // Число с разрядами по языку: 12 345 / 12,345.
    res.locals.num = (n) => Number(n || 0).toLocaleString(locale);
    // Форма слова по числу: plural(5, 'rec.views') → ключ rec.viewsMany.
    res.locals.plural = (n, base, vars) => {
        const key = base + pluralForm(lang, n);
        return { key, text: t(key, { n: n.toLocaleString(locale), ...vars }) };
    };
    res.locals.date = (value, opts) =>
        new Date(value).toLocaleString(locale, { ...opts, timeZone: timeZoneOf(req) });
    // Название записи или видео для h1, <title>, alt и разметки: своё, если
    // оно что-то говорит, иначе «Запись эфира {ник} от {даты}» / «Видео {ник}
    // от {даты}». «.», «)» и пустое — одинаково безымянные (docs/seo, 04.10).
    res.locals.mediaTitle = (title, kind, name, at) => meaningful(title) ? String(title).trim()
        : res.locals.ta(kind === 'recording' ? 'rec.untitledBy' : 'video.untitledBy',
            { name, date: res.locals.date(at, { day: 'numeric', month: 'long', year: 'numeric' }) });
    // Как грузить картинку содержимого (обложку, снимок, аватар профиля):
    // первые две на странице — то, что человек видит сразу (LCP), браузер
    // берёт их сразу и первыми; остальные — по мере прокрутки. Шаблоны
    // вызывают по порядку разметки: <img … <%- imgLoad() %>>. Во фрагментах
    // (подгрузка ленты, смена фильтра) всё ниже экрана (docs/seo, задача 32).
    let lead = req.headers['x-tk-fragment'] === '1' ? 0 : 2;
    res.locals.imgLoad = () => lead-- > 0 ? 'fetchpriority="high"' : 'loading="lazy"';
    // Одна и та же ссылка отдаёт разные страницы: кэш между сервером
    // и браузером (CDN) обязан различать их по cookie.
    // Ссылки на публичные страницы в готовой разметке — на язык страницы
    // (utils/langUrl.js, localizeHtml): /@anna на русской — /ru/@anna.
    const render = res.render;
    res.render = function renderInLang(view, opts, done) {
        if (typeof opts === 'function') { done = opts; opts = undefined; }
        this.vary('Cookie');
        // Язык страницы с приставкой задан адресом; корень langPrefix
        // помечает сам, когда угадывает по браузеру.
        if (!req.urlLang) this.vary('Accept-Language');
        // Страница ошибки («нет такого эфира»): её версий на других языках
        // тоже нет — меню языка переводит её на месте, а не ссылками на 404.
        if (this.statusCode >= 400) this.locals.langAlt = null;
        const send = done || ((err, html) => (err ? req.next(err) : this.send(html)));
        return render.call(this, view, opts, (err, html) => send(err, err ? html : localizeHtml(html, lang)));
    };
    next();
}

module.exports = { EN, langOf, langChoice, browserLang, tr, text, pluralForm, localizeMessages, pageLocals };
