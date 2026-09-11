// Камера заведения на карте: владелец включает её в кабинете, гости на карте
// смотрят. Звук и видео идут в одну сторону.
//
// Раньше это шло через публичный облачный сервер PeerJS напрямую между
// браузерами. Без ретранслятора такое соединение за NAT мобильного оператора
// часто не собирается — отсюда «связь через раз». Теперь заведение вещает
// в закрытую комнату Daily, а гость входит со своим токеном и без права
// отправлять что-либо.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { requireAuth, requireOwner, requireNotBanned } = require('../middleware/auth');
const daily = require('../utils/daily');
const Establishments = require('../models/Establishments');
const User = require('../models/User');

const OBJECT_ID = /^[a-f\d]{24}$/i;
const DAILY_MAX_PARTICIPANTS = Number(process.env.DAILY_MAX_PARTICIPANTS) || 20;

const roomName = (id) => `venue_${id}`;

// requireOwner ищет заведение по :id — кривой идентификатор ронял бы его в 500.
router.param('id', (req, res, next, id) => (
  OBJECT_ID.test(id) ? next() : res.status(404).json({ message: 'Заведение не найдено' })
));

function dailyFailure(res, err) {
  console.error('[venue-live]', err.message);
  res.status(502).json({ message: 'Сервис видео недоступен, попробуйте позже' });
}

const ownVenue = requireOwner(Establishments, { param: 'id', field: 'owner' });

// Включить камеру. Комната пересоздаётся на каждый запуск: у прежней мог
// выйти срок, в ней могли остаться подключения прошлого показа.
router.post('/api/venues/:id/live', requireAuth, requireNotBanned, ownVenue, async (req, res) => {
  const name = roomName(req.params.id);
  let token;
  try {
    await daily.deleteRoom(name);
    await daily.createRoom(name, { max_participants: DAILY_MAX_PARTICIPANTS });
    token = await daily.meetingToken({ room: name, userId: req.session.userId, owner: true, canSend: true });
  } catch (err) {
    return dailyFailure(res, err);
  }
  await Establishments.updateOne({ _id: req.params.id }, { $set: { online: true } });
  res.json({ url: daily.roomUrl(name), token });
});

// Выключить: удаление комнаты заодно отключает всех гостей.
router.delete('/api/venues/:id/live', requireAuth, ownVenue, async (req, res) => {
  await Establishments.updateOne({ _id: req.params.id }, { $set: { online: false } });
  try {
    await daily.deleteRoom(roomName(req.params.id));
  } catch (err) {
    return dailyFailure(res, err);
  }
  res.json({ ok: true });
});

const offline = (res) => res.status(409).json({ message: 'Заведение сейчас не показывает камеру' });

// Гость: токен только на просмотр, в списке участников его нет.
// Владелец приходит сюда же после обрыва и получает право вещать: вернуться
// через /live значило бы пересоздать комнату и выкинуть всех гостей.
// Ограниченному владельцу права вещать нет и здесь: /live закрыт
// requireNotBanned, а повторный вход — вторая дверь в ту же комнату.
router.post('/api/venues/:id/watch', requireAuth, async (req, res) => {
  const venue = await Establishments.findById(req.params.id).select('online status owner').lean();
  if (!venue || venue.status === false) return res.status(404).json({ message: 'Заведение не найдено' });
  if (!venue.online) return offline(res);
  const name = roomName(req.params.id);
  const userId = req.session.userId;
  const isOwner = String(venue.owner) === String(userId)
    && !(await User.exists({ _id: userId, banned: true }));
  try {
    // online в базе без комнаты в Daily: вкладка владельца умерла, не успев
    // отправить sendBeacon. Без проверки гость получал токен в пустоту,
    // а заведение висело на карте «в эфире» до следующего включения.
    if (!(await daily.roomExists(name))) {
      await Establishments.updateOne({ _id: req.params.id }, { $set: { online: false } });
      return offline(res);
    }
    const token = await daily.meetingToken(isOwner
      ? { room: name, userId, owner: true, canSend: true }
      : { room: name, userId, presence: false });
    res.json({ url: daily.roomUrl(name), token });
  } catch (err) {
    dailyFailure(res, err);
  }
});

module.exports = { router, roomName };
