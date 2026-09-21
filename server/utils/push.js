// Пуш-уведомления: единственное место, откуда они уходят.
//
// Зачем они есть. Сокет говорит только с открытой вкладкой: закрыл её —
// и о сообщении человек не узнает. Пуш будит service worker на устройстве,
// даже когда браузер не запущен.
//
// Как это работает. Своего канала до телефона у нас нет и быть не может:
// браузер подписывается у пуш-сервиса своего производителя (у Chrome —
// Google, у Safari — Apple) и отдаёт странице адрес и два ключа шифрования;
// мы их храним (models/PushSubscription.js) и шлём по этому адресу
// зашифрованное сообщение, подписанное нашей парой VAPID. Содержимое
// пуш-сервис прочитать не может — ключи у устройства.
//
// Без VAPID_PUBLIC / VAPID_PRIVATE / VAPID_SUBJECT пуши просто выключены:
// сайт работает как раньше, ошибок нет, подписаться нельзя.
//
// Правило «человек на связи — не шлём» живёт НЕ здесь, а в тех, кто зовёт:
// проверка «Прислать тестовый пуш» в настройках приходит на то же устройство,
// с которого её нажали, и молчать в ответ ей нельзя.

const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');
const errorLog = require('./errorLog');
const io = require('./io');
const { text } = require('./i18n');

const PUBLIC = process.env.VAPID_PUBLIC || '';
const PRIVATE = process.env.VAPID_PRIVATE || '';
const SUBJECT = process.env.VAPID_SUBJECT || '';
const pushConfigured = Boolean(PUBLIC && PRIVATE && SUBJECT);

if (pushConfigured) webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);
else console.warn('Пуши выключены: нет VAPID_PUBLIC / VAPID_PRIVATE / VAPID_SUBJECT.');

// Сколько пуш-сервис держит сообщение, пока устройство офлайн. Сообщению
// и пропущенному звонку сутки ни к чему, но и минуты мало: телефон в кармане
// в метро вернётся через час. Эфир — дело короткое: пришедшее через час
// «началось» ведёт на уже кончившееся.
const TTL = { message: 4 * 3600, call: 4 * 3600, follow: 24 * 3600, live: 30 * 60 };

// Полезная нагрузка ограничена примерно четырьмя килобайтами, и длинный
// текст на экране всё равно обрежет система. 120 знаков — то же правило,
// по которому показывает уведомление открытая вкладка (public/tk-notify.js):
// одно поведение и одна строка кода на оба случая.
const MAX_PREVIEW = 120;

function short(s) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > MAX_PREVIEW ? one.slice(0, MAX_PREVIEW - 1) + '…' : one;
}

// Подписка устройства. Адрес принадлежит устройству, а не человеку: на том же
// телефоне вошли другим аккаунтом — запись переписывается на него, иначе
// уведомления первого поедут второму.
async function subscribe(userId, sub, { ua = '', lang = 'ru', preview, live } = {}) {
  const keys = (sub && sub.keys) || {};
  if (!sub || !sub.endpoint || !keys.p256dh || !keys.auth) throw new Error('Подписка без адреса или ключей');
  const set = {
    user: userId,
    endpoint: sub.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    ua: String(ua).slice(0, 300),
    lang: lang === 'en' ? 'en' : 'ru',
    lastOkAt: new Date(),
  };
  // preview и live приходят, только когда их меняют: при обычном обновлении
  // подписки выбор человека остаётся прежним.
  if (typeof preview === 'boolean') set.preview = preview;
  if (typeof live === 'boolean') set.live = live;
  return PushSubscription.findOneAndUpdate(
    { endpoint: sub.endpoint },
    { $set: set, $setOnInsert: { createdAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
}

function unsubscribe(endpoint) {
  return PushSubscription.deleteOne({ endpoint });
}

// Выбор человека для этого устройства: показывать ли текст, слать ли про эфиры.
function setPrefs(userId, endpoint, patch) {
  const set = {};
  if (typeof patch.preview === 'boolean') set.preview = patch.preview;
  if (typeof patch.live === 'boolean') set.live = patch.live;
  if (!Object.keys(set).length) return null;
  return PushSubscription.findOneAndUpdate({ endpoint, user: userId }, { $set: set }, { new: true }).lean();
}

// Есть ли у человека хоть одна открытая вкладка. Комнаты user:<id> ведут
// сокеты (sockets/index.js); спрашиваем адаптер напрямую, а не userRooms
// из app.set: журнал звонков и начало эфира случаются там, где запроса нет.
function online(userId) {
  const server = io.get();
  return !!(server && server.sockets.adapter.rooms.has('user:' + String(userId)));
}

// Заголовок: имя человека как есть или строка словаря с ним внутри
// («{name} в эфире») — на языке устройства.
function titleFor(sub, note) {
  return note.titleKey ? text(sub.lang, note.titleKey, note.titleVars) : note.title;
}

// Что видно на экране. title — имя человека, его не переводим; bodyKey —
// строка словаря («Новое сообщение»), собирается на языке устройства.
//
// Дальше — про текст, и он бывает двух родов. preview и previewKey — личное:
// текст сообщения и его замена словарём, когда текста нет («Фото»,
// «Голосовое»); уходит только на устройства, где показывать текст разрешили.
// body — не личное: название эфира видно на витрине любому, скрывать его
// от заблокированного экрана незачем.
function bodyFor(sub, note) {
  if (sub.preview) {
    if (note.preview) return short(note.preview);
    if (note.previewKey) return text(sub.lang, note.previewKey);
  }
  if (note.body) return short(note.body);
  return text(sub.lang, note.bodyKey, note.bodyVars);
}

// Отправка на все устройства человека. Ничего не ждёт и ничего не роняет:
// пуш не важнее самого сообщения, ради которого он посылается.
// Возвращает промис — он нужен зондам, в горячем пути его не ждут.
function send(userId, note) {
  return sendMany([userId], note);
}

// Тем же одним запросом — многим: у эфира подписчиков могут быть сотни,
// и спрашивать базу о каждом по очереди значит сделать сотню запросов там,
// где хватает одного.
async function sendMany(userIds, note) {
  if (!pushConfigured || !userIds.length) return { sent: 0, gone: 0 };
  const topic = note.topic || 'message';
  const query = { user: { $in: userIds } };
  // Про эфиры — только тем устройствам, где это не выключили.
  if (topic === 'live') query.live = true;

  let subs;
  try {
    subs = await PushSubscription.find(query).lean();
  } catch (e) {
    errorLog.external(e, 'push.find');
    return { sent: 0, gone: 0 };
  }
  if (!subs.length) return { sent: 0, gone: 0 };

  const results = await Promise.all(subs.map(async (sub) => {
    const payload = JSON.stringify({
      title: titleFor(sub, note),
      body: bodyFor(sub, note),
      tag: note.tag || topic,
      url: note.url || '/',
      renotify: !!note.renotify,
    });
    try {
      // urgency: high у всех. Пониженная срочность разрешает пуш-сервису
      // придержать сообщение, пока телефон дремлет, — и эфир, и сообщение
      // приходили бы «когда-нибудь потом». Насколько сообщение вообще имеет
      // смысл доставлять, мы говорим сроком хранения (TTL), а не срочностью.
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        payload,
        { TTL: TTL[topic] || TTL.message, urgency: 'high' }
      );
      PushSubscription.updateOne({ _id: sub._id }, { $set: { lastOkAt: new Date() } }).catch(() => {});
      return 'sent';
    } catch (e) {
      // 404 и 410 от пуш-сервиса — «устройство больше не подписано»: чистим
      // сразу, иначе таблица растёт мусором, а мы каждый раз стучимся в никуда.
      if (e.statusCode === 404 || e.statusCode === 410) {
        // Ждём удаления, а не бросаем вдогонку: отправка и так идёт мимо
        // горячего пути, зато «ушло — и запись пропала» становится фактом,
        // который можно проверить, а не надеждой.
        await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
        return 'gone';
      }
      errorLog.external(e, 'push.send', { status: e.statusCode, ua: sub.ua });
      return 'failed';
    }
  }));

  return {
    sent: results.filter((r) => r === 'sent').length,
    gone: results.filter((r) => r === 'gone').length,
  };
}

module.exports = { pushConfigured, publicKey: PUBLIC, subscribe, unsubscribe, setPrefs, send, sendMany, online, short };
