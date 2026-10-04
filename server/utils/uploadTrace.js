// Серверная часть попытки загрузки (docs/TELEMETRY.md): что было с файлом
// после того, как он доехал, — ожидание в очереди пережатия, пережатие,
// выгрузка в хранилище, исход. Пишется в ту же запись, что завёл браузер,
// полем server:
//   upload     — видео галереи (public/tk-upload.js), цель — id черновика;
//   chat.media — видео и кружок в переписке (public/chats.js), цель — ref
//                заглушки отправителя.
// Записи нет (телеметрия не дошла) — ничего не делаем. Ошибка здесь не
// должна мешать самой обработке.
const Trace = require('../models/Trace');
const errorLog = require('./errorLog');

function done(kind, target, server) {
  if (!target) return;
  Trace.updateOne({ kind, target: String(target) }, { $set: { server } })
    .catch((e) => errorLog.server(e, 'uploadTrace'));
}

module.exports = { done };
