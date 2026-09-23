// Подписчикам: автор вышел в эфир. Строка в колокольчик и пуш на телефон.
//
// Почему отдельно от liveSignal.js. Тот рассылает сигналы «кто сейчас
// в эфире» — их можно слать сколько угодно, они только перерисовывают метки.
// Здесь другое: уведомление остаётся в колокольчике и будит телефон, поэтому
// цена лишнего срабатывания совсем иная.
//
// А сработать лишний раз есть от чего: эфир с OBS оживает при каждом
// переподключении вещателя, и пауза гасит и зажигает его снова. Поэтому
// отметка о рассылке живёт в базе, а не в памяти процесса: перезапуск
// сервера не должен давать подписчикам второе «эфир начался».
//
// Отметка стоит на авторе (User.liveNotifiedAt), а не на эфире. В эфире она
// и стояла до 23.09 — и не работала там, где это важнее всего: завершение
// эфира удаляет Stream целиком (routes/streaming/streams.js), поэтому
// ведущий, закончивший и начавший заново, рассылал подписчикам второе
// «в эфире» через минуту. Автор переживает любое число эфиров.
//
// Кому не шлём:
//   — самому автору;
//   — тем, у кого открыта вкладка: они увидят метку «в эфире» сами
//     (author:live), а получить и метку, и пуш — это два уведомления
//     об одном событии;
//   — на устройства, где пуши про эфиры выключены (это решает utils/push.js).

const Notification = require('../models/Notification');
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
  // дважды. Запись переживёт это только один раз. Тем же запросом берём имя
  // автора — отдельный findById здесь был лишним обращением к базе.
  const since = new Date(Date.now() - AGAIN_MS);
  const author = await User.findOneAndUpdate(
    { _id: stream.userId, $or: [{ liveNotifiedAt: null }, { liveNotifiedAt: { $lt: since } }] },
    { $set: { liveNotifiedAt: new Date() } },
    { new: false, projection: 'nickname login email' }
  ).lean();
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
    // «Имя в эфире», а под ним название: одно название с именем в заголовке
    // читалось как сообщение от человека, а не как начало эфира.
    titleKey: 'push.liveTitle',
    titleVars: { name },
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
