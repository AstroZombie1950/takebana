// Встречи в заведениях (07.10, docs/MEETUPS.md): отметка «хочу сюда»
// и «Я тоже». Правила и список — utils/meetups.js, разметка блока —
// views/partials/venueMeetups.ejs, поведение — public/tk-meetups.js.
//
// После каждого действия страница забирает блок заново фрагментом: шаблон
// один, и список в нём всегда тот же, что увидит человек после перезагрузки.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router);

const Meetup = require('../models/Meetup');
const User = require('../models/User');
const Notification = require('../models/Notification');
const Establishments = require('../models/Establishments');
const { requireAuthApi, requireNotBanned, canModerate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { fragmentOnly } = require('../middleware/fragment');
const meetups = require('../utils/meetups');
const age = require('../utils/age');
const restriction = require('../utils/restrict');
const userView = require('../utils/userView');
const push = require('../utils/push');
const errorLog = require('../utils/errorLog');
const { audit } = require('../utils/audit');

const OBJECT_ID = /^[a-f\d]{24}$/i;
router.param('id', (req, res, next, id) => (OBJECT_ID.test(id) ? next() : res.status(404).json({ message: 'Отметка не найдена' })));

const approved = (id) => (OBJECT_ID.test(id) ? Establishments.findOne({ _id: id, status: true }).select('name tz country city').lean() : null);

// Встречи — только совершеннолетним по дате рождения. Нет даты — reason
// подсказывает странице показать поле для неё.
async function adultOr(req, res) {
  const me = await User.findById(req.session.userId).select('birthDate').lean();
  if (!me) { res.status(401).json({ message: 'Необходима авторизация' }); return null; }
  if (!me.birthDate) { res.status(400).json({ message: 'Укажите дату рождения', reason: 'birthdate' }); return null; }
  if (!age.isAdult(me)) { res.status(403).json({ message: 'Встречи — только с 18 лет' }); return null; }
  return me;
}

// Блок отметок страницы заведения — тот же, что в самой странице.
router.get('/venue/:venueId/meetups', fragmentOnly((req) => '/venue/' + encodeURIComponent(req.params.venueId)), async (req, res, next) => {
  const venue = await approved(req.params.venueId);
  if (!venue) return next();
  const viewer = req.session.userId ? await User.findById(req.session.userId).select('birthDate').lean() : null;
  res.render('partials/venueMeetups', { venue, viewer, meet: await meetups.forVenue(venue, viewer, res.locals.lang) });
});

router.post('/venue/:venueId/meetups', requireAuthApi, requireNotBanned, validate({
  day: { type: 'string', required: true, max: 10, label: 'День' },
  time: { type: 'string', max: 5, allowEmpty: true, default: '', label: 'Время' },
  note: { type: 'string', max: meetups.NOTE_MAX, allowEmpty: true, default: '', label: 'Комментарий' },
}), async (req, res) => {
  const venue = await approved(req.params.venueId);
  if (!venue) return res.status(404).json({ message: 'Заведение не найдено' });
  if (!(await adultOr(req, res))) return;
  const { day, time } = req.body;
  if (!meetups.dayOk(day, venue.tz)) return res.status(400).json({ message: 'Выберите день от сегодня и не дальше чем через 60 дней' });
  if (time && !meetups.TIME.test(time)) return res.status(400).json({ message: 'Время указано неверно' });
  const open = await Meetup.countDocuments({ user: req.session.userId, expiresAt: { $gt: new Date() } });
  if (open >= meetups.MAX_ACTIVE) return res.status(409).json({ message: 'Открытых отметок может быть не больше трёх' });

  let meetup;
  try {
    meetup = await Meetup.create({
      user: req.session.userId,
      venue: venue._id,
      country: venue.country || '',
      city: venue.city || '',
      day,
      time,
      note: req.body.note.replace(/\s+/g, ' ').trim(),
      expiresAt: meetups.expiresFor(day),
    });
  } catch (e) {
    if (e && e.code === 11000) return res.status(409).json({ message: 'Вы уже отметились здесь на этот день' });
    throw e;
  }
  audit(req, 'meetup.create', { targetType: 'meetup', targetId: meetup._id, meta: { venue: String(venue._id), day } });
  res.status(201).json({ id: meetup._id });
});

// Убрать отметку: автор — свою, модерация — любую (из панели, по жалобе).
router.delete('/meetups/:id', requireAuthApi, async (req, res) => {
  const meetup = await Meetup.findById(req.params.id).select('user venue day').lean();
  if (!meetup) return res.status(404).json({ message: 'Отметка не найдена' });
  const own = String(meetup.user) === String(req.session.userId);
  if (!own && !canModerate(await User.findById(req.session.userId).select('role').lean())) {
    return res.status(403).json({ message: 'Нет прав на эту запись' });
  }
  await Meetup.deleteOne({ _id: meetup._id });
  audit(req, 'meetup.delete', { targetType: 'meetup', targetId: meetup._id, meta: { venue: String(meetup.venue), day: meetup.day, byModeration: !own } });
  res.json({ ok: true });
});

// «Я тоже».
router.post('/meetups/:id/join', requireAuthApi, requireNotBanned, async (req, res) => {
  const me = await adultOr(req, res);
  if (!me) return;
  const meetup = await Meetup.findOne({ _id: req.params.id, expiresAt: { $gt: new Date() } }).select('user venue day').lean();
  if (!meetup) return res.status(404).json({ message: 'Отметка не найдена' });
  if (String(meetup.user) === String(me._id)) return res.status(400).json({ message: 'Это ваша отметка' });
  if (await restriction.between(me._id, meetup.user)) return res.status(404).json({ message: 'Отметка не найдена' });

  // Место и повтор — одним условием: две вкладки не впишут человека дважды,
  // а последний свободный слот не займут двое.
  const done = await Meetup.updateOne(
    { _id: meetup._id, 'members.user': { $ne: me._id }, [`members.${meetups.MAX_MEMBERS - 1}`]: { $exists: false } },
    { $push: { members: { user: me._id } } }
  );
  if (!done.modifiedCount) {
    const already = await Meetup.exists({ _id: meetup._id, 'members.user': me._id });
    if (!already) return res.status(409).json({ message: 'Мест больше нет' });
    return res.json({ ok: true });
  }
  audit(req, 'meetup.join', { targetType: 'meetup', targetId: meetup._id });
  notifyAuthor(req.app.get('io'), meetup, me._id).catch((e) => errorLog.server(e, 'meetup.notify'));
  res.json({ ok: true });
});

router.delete('/meetups/:id/join', requireAuthApi, async (req, res) => {
  await Meetup.updateOne({ _id: req.params.id }, { $pull: { members: { user: req.session.userId } } });
  res.json({ ok: true });
});

// Автору — строка в колокольчик и пуш, когда вкладки нет. Один раз на
// человека и отметку: «Я тоже — не иду — я тоже» не звонит трижды.
async function notifyAuthor(io, meetup, senderId) {
  const link = `/venue/${meetup.venue}#m-${meetup._id}`;
  const sent = { recipient: meetup.user, sender: senderId, type: 'meetup', link };
  if (await Notification.exists(sent)) return;
  const [venue, sender] = await Promise.all([
    Establishments.findById(meetup.venue).select('name').lean(),
    User.findById(senderId).select('nickname login email').lean(),
  ]);
  if (!venue || !sender) return;
  // День — «17.10»: одинаково на обоих языках.
  const content = `${venue.name}, ${meetup.day.slice(8, 10)}.${meetup.day.slice(5, 7)}`;
  await Notification.create({ ...sent, content });
  if (io) io.to(`user:${meetup.user}`).emit('notification:new', { type: 'meetup' });
  if (push.onScreen(meetup.user)) return;
  await push.send(meetup.user, {
    topic: 'meetup',
    titleKey: 'push.meetup',
    titleVars: { name: userView.displayName(sender) },
    body: content,
    tag: 'meetup-' + String(meetup._id),
    url: link,
  });
}

module.exports = router;
