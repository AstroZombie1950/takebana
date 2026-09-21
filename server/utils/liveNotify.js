// Подписчикам: автор вышел в эфир. Строка в колокольчик и пуш на телефон.
//
// Почему отдельно от liveSignal.js. Тот рассылает сигналы «кто сейчас
// в эфире» — их можно слать сколько угодно, они только перерисовывают метки.
// Здесь другое: уведомление остаётся в колокольчике и будит телефон, поэтому
// цена лишнего срабатывания совсем иная.
//
// А сработать лишний раз есть от чего: эфир с OBS оживает при каждом
// переподключении вещателя, и пауза гасит и зажигает его снова. Поэтому
// отметка о рассылке живёт в самом эфире (Stream.liveNotifiedAt), а не
// в памяти процесса: перезапуск сервера не должен давать подписчикам
// второе «эфир начался».
//
// Кому не шлём:
//   — самому автору;
//   — тем, у кого открыта вкладка: они увидят метку «в эфире» сами
//     (author:live), а получить и метку, и пуш — это два уведомления
//     об одном событии;
//   — на устройства, где пуши про эфиры выключены (это решает utils/push.js).

const Notification = require('../models/Notification');
const Stream = require('../models/Stream');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const errorLog = require('./errorLog');
const push = require('./push');
const userView = require('./userView');

// Не раньше чем через два часа на тот же эфир. Два часа — это «другой вечер»,
// а не «вещатель уронил интернет и вернулся».
const AGAIN_MS = 2 * 3600 * 1000;

// Эфир начался. Зовётся из тех двух мест, где это правда: приход потока
// на RTMP (mediaServer.js) и включение веб-эфира (routes/streaming/streams.js).
// Ничего не ждёт и ничего не роняет: рассылка не важнее самого эфира.
async function started(io, stream) {
  if (!stream || !stream._id || !stream.userId) return { sent: 0, notified: 0 };

  // Отметку ставим условием запроса, а не после проверки: два потока (OBS
  // и кнопка на сайте) могут прийти в одну секунду, и тогда рассылка уйдёт
  // дважды. Запись переживёт это только один раз.
  const since = new Date(Date.now() - AGAIN_MS);
  const claimed = await Stream.findOneAndUpdate(
    { _id: stream._id, $or: [{ liveNotifiedAt: null }, { liveNotifiedAt: { $lt: since } }] },
    { $set: { liveNotifiedAt: new Date() } },
    { new: false }
  ).lean();
  if (!claimed) return { sent: 0, notified: 0 };

  const author = await User.findById(stream.userId).select('nickname login email').lean();
  if (!author) return { sent: 0, notified: 0 };
  const name = userView.displayName(author);

  const subs = await Subscription.find({ subscribedToId: stream.userId }).select('subscriberId').lean();
  const ids = subs.map((s) => s.subscriberId).filter((id) => String(id) !== String(stream.userId));
  if (!ids.length) return { sent: 0, notified: 0 };

  const link = '/stream/' + String(stream._id);

  // Колокольчик — всем: он для того и есть, чтобы увидеть пропущенное потом.
  await Notification.insertMany(ids.map((id) => ({
    recipient: id,
    sender: stream.userId,
    type: 'live',
    content: stream.title || '',
    link,
  })), { ordered: false });

  const offline = [];
  for (const id of ids) {
    if (io) io.to(`user:${id}`).emit('notification:new');
    if (!push.online(id)) offline.push(id);
  }

  const out = await push.sendMany(offline, {
    topic: 'live',
    title: name,
    bodyKey: 'push.live',
    // Название эфира — не личная переписка: его видно на витрине любому,
    // поэтому оно уходит всем, а не только тем, кто разрешил показывать
    // текст (body, а не preview — см. bodyFor в utils/push.js).
    body: stream.title || '',
    tag: 'live-' + String(stream.userId),
    url: link,
  });

  return { sent: out.sent, notified: ids.length };
}

// Обёртка для тех, кто зовёт из горячего пути: ошибка рассылки не должна
// мешать эфиру начаться.
function quiet(io, stream) {
  Promise.resolve()
    .then(() => started(io, stream))
    .catch((e) => errorLog.server(e, 'liveNotify.started', { stream: String(stream && stream._id) }));
}

module.exports = { started, quiet, AGAIN_MS };
