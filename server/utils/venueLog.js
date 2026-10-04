// Хронология камеры заведения (models/VenueSession.js) — серверная сторона
// того, что браузер пишет в попытки venue.host и venue.view (docs/TELEMETRY.md).
//
// Сеанс открывает «включить» (routes/venueLive.js), закрывает любой из
// выходов: кнопка, модерация, пропавший владелец. Между ними — что делал
// сервер: попросил камеру у владельца и снял просьбу (utils/venueCam.js),
// MediaMTX сказал о начале и конце публикации, ffmpeg стартовал, выдал
// плейлист, вышел (utils/hls.js). Как и журнал эфиров, ничего здесь не
// имеет права помешать камере: всё гасится и пишется в журнал ошибок.
const VenueSession = require('../models/VenueSession');
const errorLog = require('./errorLog');

const EVENTS_MAX = 200;
const quiet = (p, what) => p.catch((e) => errorLog.server(e, 'venueLog.' + what));
const item = (e, d) => ({ at: new Date(), e, ...(d ? { d } : {}) });

// Прежний сеанс мог остаться открытым — перезапуск процесса, вкладка
// владельца умерла молча. Новое включение его закрывает.
function open(venueId, owner, d) {
  return quiet(VenueSession.updateMany({ venue: venueId, endedAt: null }, { $set: { endedAt: new Date(), endedBy: 'restart' } })
    .then(() => VenueSession.create({ venue: venueId, owner: owner || null, events: [item('cam.on', d)] })), 'open');
}

function close(venueId, endedBy) {
  return quiet(VenueSession.updateMany({ venue: venueId, endedAt: null }, {
    $set: { endedAt: new Date(), endedBy },
    $push: { events: { $each: [item('cam.off', { by: endedBy })], $slice: -EVENTS_MAX } },
  }), 'close');
}

// Сеанса нет (камеру включили до 4 октября) — событие некуда писать, и не надо.
function event(venueId, e, d) {
  if (!venueId) return;
  quiet(VenueSession.updateOne({ venue: venueId, endedAt: null },
    { $push: { events: { $each: [item(e, d)], $slice: -EVENTS_MAX } } }), 'event');
}

function viewers(venueId, n) {
  if (n > 0) quiet(VenueSession.updateOne({ venue: venueId, endedAt: null }, { $max: { peakViewers: n } }), 'viewers');
}

module.exports = { open, close, event, viewers };
