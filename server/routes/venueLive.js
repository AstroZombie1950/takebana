// Камера заведения на карте: владелец включает её в кабинете, гости на карте
// смотрят. Звук и видео идут в одну сторону.
//
// Два движка. Свой приём (MediaMTX, utils/mediamtx.js): заведение вещает
// по WHIP один раз, зрители забирают по WHEP, платим только за трафик.
// Запасной — комната Daily, как было до 23.09: каждый зритель считается
// участником и стоит денег, зато работает без своей установки. Что именно
// включено, решают переменные окружения MTX_PUBLIC и MTX_API; браузеру
// движок называется в ответе полем engine, и он просто идёт, куда сказали.
//
// До Daily это шло через публичный облачный сервер PeerJS напрямую между
// браузерами. Без ретранслятора такое соединение за NAT мобильного оператора
// часто не собирается — отсюда «связь через раз».

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { requireAuth, requireOwner, requireNotBanned } = require('../middleware/auth');
const daily = require('../utils/daily');
const mediamtx = require('../utils/mediamtx');
const Establishments = require('../models/Establishments');
const User = require('../models/User');
const { audit } = require('../utils/audit');
const errorLog = require('../utils/errorLog');

const OBJECT_ID = /^[a-f\d]{24}$/i;
const DAILY_MAX_PARTICIPANTS = Number(process.env.DAILY_MAX_PARTICIPANTS) || 20;

const roomName = (id) => `venue_${id}`;

// requireOwner ищет заведение по :id — кривой идентификатор ронял бы его в 500.
router.param('id', (req, res, next, id) => (
  OBJECT_ID.test(id) ? next() : res.status(404).json({ message: 'Заведение не найдено' })
));

function dailyFailure(res, err) {
  errorLog.external(err, 'daily.venueLive');
  res.status(502).json({ message: 'Сервис видео недоступен, попробуйте позже' });
}

const ownVenue = requireOwner(Establishments, { param: 'id', field: 'owner' });

// ── Свой приём: разрешения для MediaMTX ──
// Он спрашивает нас на каждое подключение: кого пускать вещать и кого
// смотреть. Вопрос приходит с петли (authHTTPAddress в ops/mediamtx/),
// поэтому и отвечаем только петле: снаружи этот адрес не нужен никому.
// Одной петли мало: за nginx с 127.0.0.1 приходит всё. Запрос через nginx
// узнаём по X-Forwarded-For — MediaMTX ходит напрямую и его не ставит.
// Снаружи адрес закрыт и в самом nginx (ops/nginx/takebana.conf).
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

router.post('/api/mtx/auth', express.json({ limit: '4kb' }), (req, res) => {
  if (!LOOPBACK.has(req.socket.remoteAddress) || req.headers['x-forwarded-for']) return res.status(401).end();
  const { path, action, query } = req.body || {};
  if (typeof path !== 'string' || typeof action !== 'string') return res.status(401).end();
  // Разрешение — одноразовый ключ, выданный маршрутами ниже.
  if (!mediamtx.allowed({ path, action, query })) return res.status(401).end();
  res.status(204).end();
});

// Сколько человек смотрит камеру — владельцу в кабинет. Тот же вопрос
// к MediaMTX отвечает и на «а идёт ли она вообще».
router.get('/api/venues/:id/viewers', requireAuth, ownVenue, async (req, res) => {
  if (!mediamtx.configured()) return res.json({ engine: 'daily', viewers: null });
  const { live, readers } = await mediamtx.state(mediamtx.pathOf(req.params.id));
  res.json({ engine: 'whip', live, viewers: readers });
});

// Включить камеру. Комната пересоздаётся на каждый запуск: у прежней мог
// выйти срок, в ней могли остаться подключения прошлого показа.
router.post('/api/venues/:id/live', requireAuth, requireNotBanned, ownVenue, async (req, res) => {
  // Свой приём: комнату поднимать не нужно — достаточно разрешения
  // на публикацию. Поток заводится в момент, когда браузер начнёт вещать.
  if (mediamtx.configured()) {
    const path = mediamtx.pathOf(req.params.id);
    // Прошлый вещатель мог остаться висеть — например, вкладку закрыли
    // в метро. Новый показ начинается с чистого листа.
    await mediamtx.kick(path);
    await Establishments.updateOne({ _id: req.params.id }, { $set: { online: true } });
    audit(req, 'venue.live.on', { targetType: 'venue', target: req.resource });
    return res.json({ engine: 'whip', url: mediamtx.url(path, 'whip', mediamtx.grant(path, 'publish', req.session.userId)) });
  }

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
  audit(req, 'venue.live.on', { targetType: 'venue', target: req.resource });
  res.json({ url: daily.roomUrl(name), token });
});

// Выключить: удаление комнаты заодно отключает всех гостей.
router.delete('/api/venues/:id/live', requireAuth, ownVenue, async (req, res) => {
  await Establishments.updateOne({ _id: req.params.id }, { $set: { online: false } });
  audit(req, 'venue.live.off', { targetType: 'venue', target: req.resource });
  // Свой приём: закрываем вещателя — зрители отваливаются вместе с ним.
  if (mediamtx.configured()) {
    await mediamtx.kick(mediamtx.pathOf(req.params.id));
    return res.json({ ok: true });
  }
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

  // Свой приём: гостю — разрешение на просмотр, владельцу после обрыва —
  // снова на публикацию. Поток не идёт (вкладка вещателя умерла, не успев
  // сказать) — снимаем отметку, как это делалось с комнатой Daily.
  if (mediamtx.configured()) {
    const path = mediamtx.pathOf(req.params.id);
    const { live, unknown } = await mediamtx.state(path);
    if (!live && !unknown && !isOwner) {
      await Establishments.updateOne({ _id: req.params.id }, { $set: { online: false } });
      return offline(res);
    }
    return res.json(isOwner
      ? { engine: 'whip', url: mediamtx.url(path, 'whip', mediamtx.grant(path, 'publish', userId)) }
      : { engine: 'whep', url: mediamtx.url(path, 'whep', mediamtx.grant(path, 'read', userId)) });
  }

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
