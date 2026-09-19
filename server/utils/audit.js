// Запись в журнал действий (models/AuditLog.js).
//
// Три правила, из которых всё остальное следует:
//
//  1. Журнал не ломает работу. Любая ошибка записи гасится здесь же:
//     человек не должен получить 500 из-за того, что не записался лог.
//  2. Журнал не замедляет ответ. Записи копятся в буфере и уходят пачкой
//     раз в секунду — иначе каждый вход и каждая правка стоили бы лишнего
//     обращения к базе в горячем пути.
//  3. Кто сделал — снимком. Логин и роль пишутся в саму запись, потому что
//     аккаунт могут переименовать, разжаловать или удалить, а журнал должен
//     остаться читаемым.
//
// Вызов: audit(req, 'auth.login') или audit(req, 'mod.ban', { target: user,
// meta: { reason } }). Ждать результат не нужно — функция ничего не возвращает.

const AuditLog = require('../models/AuditLog');
const User = require('../models/User');

// Коды действий и их названия для панели. Список здесь один на проект:
// фильтр журнала строится из него же, поэтому новое действие достаточно
// дописать в одном месте.
const ACTIONS = {
  'auth.login': 'Вход',
  'auth.login.fail': 'Неудачный вход',
  'auth.logout': 'Выход',
  'auth.register': 'Регистрация',
  'auth.google': 'Вход через Google',
  'auth.password.change': 'Смена пароля',
  'auth.password.reset.request': 'Запрос восстановления пароля',
  'auth.password.reset.done': 'Пароль изменён по ссылке',
  'auth.ratelimit': 'Сработал лимит попыток',

  'profile.update': 'Правка профиля',
  'profile.email.request': 'Запрос смены почты',
  'profile.email.change': 'Почта сменена по ссылке',
  'profile.avatar': 'Смена фото',
  'profile.avatar.delete': 'Удаление фото',
  'profile.gallery.add': 'Фото в галерею',
  'profile.gallery.delete': 'Удаление из галереи',
  'profile.gallery.video': 'Видео в галерею',
  'profile.gallery.video.delete': 'Удаление видео из галереи',
  'profile.delete': 'Удаление своего аккаунта',
  'age.confirm': 'Подтверждение 18+',

  'stream.setup': 'Настройки эфира',
  'stream.live': 'Выход в эфир',
  'stream.pause': 'Пауза эфира',
  'stream.end': 'Завершение эфира',
  'stream.thumbnail': 'Обложка эфира',
  'stream.rtmp.start': 'OBS начал вещание',
  'stream.rtmp.end': 'OBS закончил вещание',
  'stream.rtmp.reject': 'Вещание отклонено',
  'stream.cleanup': 'Эфир убран как брошенный',

  'recording.save': 'Сохранение записи',
  'recording.ready': 'Запись готова',
  'recording.fail': 'Запись не сохранилась',
  'recording.delete': 'Удаление записи',
  'recording.edit': 'Правка записи',
  'recording.comment': 'Комментарий к записи',
  'recording.uncomment': 'Удаление комментария',

  'venue.apply': 'Заявка на заведение',
  'venue.update': 'Правка заведения',
  'venue.delete': 'Удаление заведения',
  'venue.status': 'Статус заведения',
  'venue.live.on': 'Камера заведения включена',
  'venue.live.off': 'Камера заведения выключена',
  'venue.rate': 'Оценка заведения',

  'report.create': 'Жалоба подана',
  'report.close': 'Жалоба разобрана',

  'mod.ban': 'Ограничение аккаунта',
  'mod.unban': 'Снятие ограничения',
  'mod.role': 'Смена роли',
  'mod.stream.stop': 'Эфир погашен модерацией',

  'admin.view': 'Просмотр профиля',
  'admin.export': 'Выгрузка из панели',
  'admin.user.delete': 'Удаление аккаунта',
  'admin.audit.clear': 'Очистка журнала',
  'admin.session.kill': 'Сеанс завершён администратором',
  'admin.password.set': 'Пароль задан администратором',
  'admin.error.resolve': 'Ошибка отмечена разобранной',
};

// Кто действует — из сессии. Роль в сессии не хранится, а брать её из базы
// на каждую запись незачем: она меняется раз в жизни аккаунта. Держим
// пять минут, этого хватает, чтобы пачка записей одного человека обошлась
// одним чтением.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

async function actorInfo(userId, sessionLogin) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;

  let info = { login: sessionLogin || '', role: '', at: Date.now() };
  try {
    const user = await User.findById(userId).select('nickname login email role').lean();
    if (user) {
      info = { login: user.nickname || user.login || user.email || '', role: user.role || 'user', at: Date.now() };
    }
  } catch (_) {
    // Не достали — пишем то, что знает сессия. Журнал важнее точности подписи.
  }
  cache.set(userId, info);
  return info;
}

// Буфер и его сброс. unref: таймер не держит процесс при остановке.
const BUFFER_LIMIT = 50;
const FLUSH_MS = 1000;
let buffer = [];
let timer = null;

function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!buffer.length) return Promise.resolve();
  const batch = buffer;
  buffer = [];
  // ordered: false — одна негодная запись не должна отменить остальные.
  return AuditLog.insertMany(batch, { ordered: false })
    .catch((e) => console.error('[audit] запись не удалась:', e.message));
}

function schedule() {
  if (buffer.length >= BUFFER_LIMIT) return flush();
  if (!timer) timer = setTimeout(flush, FLUSH_MS).unref();
}

// Адрес клиента. За nginx настоящий приходит в X-Forwarded-For, и req.ip
// его уже учитывает — trust proxy включается в app.js в режиме prod.
function clientIp(req) {
  const ip = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '';
  // ::ffff:1.2.3.4 — тот же адрес IPv4, записанный как IPv6.
  return String(ip).replace(/^::ffff:/, '').slice(0, 45);
}

function label(target) {
  if (!target) return '';
  return String(target.title || target.name || target.nickname || target.login || target.email || '').slice(0, 200);
}

// Основная функция. req может быть null — тогда действие записывается как
// системное (уборщик эфиров, склейка записи, хуки медиасервера).
function audit(req, action, opts = {}) {
  const entry = {
    at: new Date(),
    action,
    result: opts.result || 'ok',
    targetType: opts.targetType || '',
    targetId: opts.target ? opts.target._id || opts.target : opts.targetId || null,
    targetLabel: opts.targetLabel || label(opts.target),
    meta: opts.meta || null,
    ip: req ? clientIp(req) : '',
    ua: req ? String(req.get('user-agent') || '').slice(0, 200) : '',
  };

  const actorId = opts.actor
    ? String(opts.actor._id || opts.actor)
    : (req && req.session && req.session.userId ? String(req.session.userId) : null);

  if (!actorId) {
    // Аноним: неудачный вход, регистрация до создания сессии, системное
    // действие. Подпись берём из opts, если её передали (почта при входе).
    entry.actorLogin = opts.actorLogin || '';
    buffer.push(entry);
    schedule();
    return;
  }

  entry.actor = actorId;
  // Подпись досталась асинхронно — но запись уходит в буфер уже с ней,
  // а не отдельным обновлением.
  actorInfo(actorId, req && req.session ? req.session.login : '')
    .then((info) => {
      entry.actorLogin = opts.actorLogin || info.login;
      entry.actorRole = info.role;
      buffer.push(entry);
      schedule();
    })
    .catch(() => {
      buffer.push(entry);
      schedule();
    });
}

// Роль в кэше устарела сразу после её смены: панель зовёт это после
// назначения, иначе следующие пять минут журнал подписывал бы человека
// прежней ролью.
function forget(userId) {
  cache.delete(String(userId));
}

module.exports = { audit, flush, forget, ACTIONS, clientIp };
