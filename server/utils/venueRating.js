// Средняя оценка заведения хранится в нём самом — ratingAvg и ratingCount
// (29.09): выдача /venues показывает её в каждой карточке, и считать по
// Rating на каждую карточку незачем. Пересчёт — после любой записи в Rating:
// оценка (routes/establishmentsRouter.js), удаление оценившего
// (utils/userDelete.js). Удалённому заведению пересчитывать нечего.

const mongoose = require('mongoose');
const Rating = require('../models/Rating');
const Establishments = require('../models/Establishments');
const errorLog = require('./errorLog');

async function recount(venueIds) {
  const ids = [].concat(venueIds).map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!ids.length) return;
  const rows = await Rating.aggregate([
    { $match: { establishment: { $in: ids } } },
    { $group: { _id: '$establishment', avg: { $avg: '$rating' }, n: { $sum: 1 } } },
  ]);
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  await Establishments.bulkWrite(ids.map((id) => {
    const r = byId.get(String(id));
    return { updateOne: { filter: { _id: id }, update: { $set: {
      ratingAvg: r ? Math.round(r.avg * 100) / 100 : 0,
      ratingCount: r ? r.n : 0,
    } } } };
  }));
}

// Заведения, заведённые до 29.09, счётчиков не имеют — досчитываем при
// каждом запуске, как jobs/lowercaseEmails.js: отдельный шаг выкладки легко
// забыть. Досчитывать нечего — это один запрос.
function backfill() {
  Establishments.distinct('_id', { ratingCount: { $exists: false } })
    .then(recount)
    .catch((e) => errorLog.server(e, 'venueRating.backfill'));
}

module.exports = { recount, backfill };
