// Вкладка «Заведения». Раньше жила в routes/adminRouter.js: список приходил
// по POST, без общего числа и с размером страницы прямо из запроса.
//
// Правка заведения из панели обязана попадать в те же закрытые списки, что
// и заявка владельца, иначе заведение выпадает из фильтров карты — схемы
// полей общие, utils/venueFields.js.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const Establishments = require('../../models/Establishments');
const Rating = require('../../models/Rating');
const { validate } = require('../../middleware/validate');
const { audit } = require('../../utils/audit');
const { HOURS, LOCATION, CITY, TYPE } = require('../../utils/venueFields');
const { removeVenue } = require('../../utils/userDelete');
const { requireAdmin, paging, list, needle, namesFor, csvRoute, nameOf } = require('./shared');

const OBJECT_ID = /^[a-f\d]{24}$/i;
const byId = (req, res, next) => (OBJECT_ID.test(req.params.id) ? next() : res.status(404).json({ message: 'Заведение не найдено' }));

async function loadVenues(req) {
  const p = paging(req);
  const filter = {};

  if (req.query.status === 'active') filter.status = true;
  else if (req.query.status === 'inactive') filter.status = { $ne: true };
  if (req.query.online === '1') filter.online = true;
  if (req.query.city) filter.city = String(req.query.city).slice(0, 50);
  if (req.query.type) filter.type = String(req.query.type).slice(0, 50);
  if (req.query.owner && OBJECT_ID.test(req.query.owner)) filter.owner = req.query.owner;

  const q = needle(req.query.q);
  if (q) filter.$or = [{ name: q }, { address: q }, { email: q }];

  const [venues, total] = await Promise.all([
    Establishments.find(filter).sort({ _id: -1 }).skip(p.skip).limit(p.perPage).lean(),
    Establishments.countDocuments(filter),
  ]);

  // Оценки — одним запросом на страницу, а не по запросу на карточку.
  const [names, ratings] = await Promise.all([
    namesFor(venues.map((v) => v.owner)),
    Rating.aggregate([
      { $match: { establishment: { $in: venues.map((v) => v._id) } } },
      { $group: { _id: '$establishment', avg: { $avg: '$rating' }, n: { $sum: 1 } } },
    ]),
  ]);
  const rating = new Map(ratings.map((r) => [String(r._id), { avg: Math.round(r.avg * 10) / 10, count: r.n }]));

  return list(venues.map((v) => ({
    id: String(v._id),
    name: v.name || '',
    type: v.type || '',
    country: v.country || '',
    city: v.city || '',
    address: v.address || '',
    email: v.email || '',
    phone: v.phone || '',
    status: !!v.status,
    online: !!v.online,
    weekdayHours: v.weekdayHours || null,
    weekendHours: v.weekendHours || null,
    location: v.location && v.location.lat != null ? { lat: v.location.lat, lng: v.location.lng } : null,
    photos: (v.photos || []).length,
    photo: (v.photos || [])[0] || '',
    rating: rating.get(String(v._id)) || { avg: 0, count: 0 },
    owner: names.get(String(v.owner)) || null,
  })), total, p);
}

router.get('/venues', requireAdmin, async (req, res) => res.json(await loadVenues(req)));
csvRoute(router, '/venues', requireAdmin, 'venues', loadVenues, [
  ['Название', (v) => v.name],
  ['Тип', (v) => v.type],
  ['Страна', (v) => v.country],
  ['Город', (v) => v.city],
  ['Адрес', (v) => v.address],
  ['Почта', (v) => v.email],
  ['Телефон', (v) => v.phone],
  ['Активно', (v) => (v.status ? 'да' : 'нет')],
  ['Камера', (v) => (v.online ? 'включена' : '')],
  ['Широта', (v) => (v.location ? v.location.lat : '')],
  ['Долгота', (v) => (v.location ? v.location.lng : '')],
  ['Оценка', (v) => (v.rating.count ? v.rating.avg : '')],
  ['Оценок', (v) => v.rating.count],
  ['Фото', (v) => v.photos],
  ['Владелец', (v) => nameOf(v.owner)],
]);

// Город и тип — списками каталога: правка свободной строкой выводила
// заведение из фильтров карты, а типа панель не знала вовсе.
router.put('/venues/:id', requireAdmin, byId, validate({
  name: { type: 'string', max: 200, label: 'Название' },
  type: TYPE,
  country: { type: 'string', max: 100, label: 'Страна' },
  city: CITY,
  address: { type: 'string', max: 300, label: 'Адрес' },
  email: { type: 'email', label: 'Почта' },
  phone: { type: 'string', max: 32, label: 'Телефон' },
  weekdayHours: { ...HOURS, label: 'Часы по будням' },
  weekendHours: { ...HOURS, label: 'Часы по выходным' },
  location: LOCATION,
}), async (req, res) => {
  // После валидации в теле остаются только заполненные поля: незаполненное
  // не трогается, а не затирается. Статус меняет отдельный маршрут — иначе
  // правка карточки гасила заведение, хотя переключатель оставался включённым.
  const fields = { ...req.body };

  // Точка обновляется целиком: половина координаты бессмысленна, а пустой
  // объект дошёл бы до базы как «стереть координаты».
  const { lat, lng } = fields.location || {};
  if (lat === undefined || lng === undefined) delete fields.location;

  if (!Object.keys(fields).length) {
    return res.status(400).json({ message: 'Пожалуйста, укажите хотя бы одно поле для обновления' });
  }

  const venue = await Establishments.findByIdAndUpdate(req.params.id, fields, { returnDocument: 'after' });
  if (!venue) return res.status(404).json({ message: 'Заведение не найдено' });

  audit(req, 'venue.update', { targetType: 'venue', target: venue, meta: { fields: Object.keys(fields), byAdmin: true } });
  res.json({ ok: true });
});

router.put('/venues/:id/status', requireAdmin, byId, validate({
  status: { type: 'bool', required: true, label: 'Статус' },
}), async (req, res) => {
  const venue = await Establishments.findByIdAndUpdate(req.params.id, { status: req.body.status }, { returnDocument: 'after' });
  if (!venue) return res.status(404).json({ message: 'Заведение не найдено' });

  audit(req, 'venue.status', { targetType: 'venue', target: venue, meta: { status: !!req.body.status } });
  res.json({ ok: true, status: !!venue.status });
});

router.delete('/venues/:id', requireAdmin, byId, async (req, res) => {
  const venue = await Establishments.findById(req.params.id);
  if (!venue) return res.status(404).json({ message: 'Заведение не найдено' });

  // Тем же порядком, что у владельца: без этого камера, оценки и фото
  // переживали удаление из панели.
  await removeVenue(venue);

  audit(req, 'venue.delete', { targetType: 'venue', target: venue, meta: { byAdmin: true } });
  res.json({ ok: true });
});

module.exports = router;
