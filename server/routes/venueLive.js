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
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { requireAuth, requireOwner, requireNotBanned } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { commonDataMiddleware } = require('./streaming/shared');
const ChatMessage = require('../models/ChatMessage');
const restriction = require('../utils/restrict');
const userView = require('../utils/userView');
const daily = require('../utils/daily');
const mediamtx = require('../utils/mediamtx');
const Establishments = require('../models/Establishments');
const User = require('../models/User');
const { audit } = require('../utils/audit');
const errorLog = require('../utils/errorLog');

const OBJECT_ID = /^[a-f\d]{24}$/i;
const DAILY_MAX_PARTICIPANTS = Number(process.env.DAILY_MAX_PARTICIPANTS) || 20;

const roomName = (id) => `venue_${id}`;

// Зрителям страницы камеры (сокет-комната venue:<id>, sockets/index.js):
// камеру включили или выключили — плеер подключается или гаснет сам.
function announceState(req, id, online) {
  const io = req.app.get('io');
  if (io) io.to(`venue:${id}`).emit('venue:state', { venueId: String(id), online });
}

// Погасить камеру не кнопкой владельца: бан, удаление заведения, снятие
// одобрения в панели. Оба движка сразу — раньше гасили только Daily,
// а вещатель на своём приёме (MediaMTX) продолжал вещать, зрители — смотреть.
async function stopCamera(venueId) {
  await Establishments.updateOne({ _id: venueId }, { $set: { online: false } });
  const io = require('../utils/io').get();
  if (io) io.to(`venue:${venueId}`).emit('venue:state', { venueId: String(venueId), online: false });
  await Promise.all([
    mediamtx.kick(mediamtx.pathOf(venueId)),
    daily.configured() && daily.deleteRoom(roomName(venueId))
      .catch((err) => errorLog.external(err, 'daily.deleteRoom', { roomName: roomName(venueId), by: 'venue.stop' })),
  ]);
}

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
    announceState(req, req.params.id, true);
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
  announceState(req, req.params.id, true);
  res.json({ url: daily.roomUrl(name), token });
});

// Выключить: удаление комнаты заодно отключает всех гостей.
router.delete('/api/venues/:id/live', requireAuth, ownVenue, async (req, res) => {
  await Establishments.updateOne({ _id: req.params.id }, { $set: { online: false } });
  audit(req, 'venue.live.off', { targetType: 'venue', target: req.resource });
  announceState(req, req.params.id, false);
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
      announceState(req, req.params.id, false);
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
      announceState(req, req.params.id, false);
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

// ── Страница камеры (24.09) ──────────────────────────────────────────────────
// До неё владелец включал камеру кнопкой в «Моих заведениях» и не видел
// ничего — ни себя, ни зрителей, ни чата, а гость смотрел голое видео
// в окне поверх карты. Теперь у камеры своя страница: владельцу — пульт
// (своя картинка, включить и выключить, микрофон, смена камеры), гостю —
// плеер. У обоих — карточка заведения и чат. Где её найти — на карте:
// на витрину эфиров камера не выходит (решение 23.09), в индекс тоже.
// Параметр — venueId, не id: router.param('id') выше отвечает JSON-ом,
// а здесь кривой адрес должен вести на страницу 404.
router.get('/venue/:venueId/live', commonDataMiddleware, async (req, res, next) => {
  if (!OBJECT_ID.test(req.params.venueId)) return next();
  const venue = await Establishments.findById(req.params.venueId)
    .select('name type city address weekdayHours weekendHours photos online status owner').lean();
  const userId = req.session.userId;
  const mine = !!venue && !!userId && String(venue.owner) === String(userId);
  // Заведение на проверке видно только владельцу — как и на карте.
  if (!venue || (venue.status !== true && !mine)) return next();
  const restricted = !mine && !!userId && await restriction.isRestricted(venue.owner, userId);
  res.render('venueLive', {
    venue,
    // Пульт — владельцу без бана: ограниченному /live всё равно откажет.
    isOwner: mine && !res.locals.currentUser?.banned,
    approved: venue.status === true,
    restricted,
  });
});

// ── Чат камеры ──
// Как у эфира (routes/streaming/streamChat.js): пять сообщений за пять
// секунд с человека, автор — из сессии, история — последние сто.
const HISTORY = 100;
const chatLimiter = rateLimit({
  windowMs: 5 * 1000,
  limit: 5,
  keyGenerator: (req) => String(req.session.userId),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Слишком часто. Подождите пару секунд.' },
});

// Заведение, чат которого человек вправе видеть: одобренное (своё — любое)
// и не закрытое от него владельцем (utils/restrict.js).
async function chatVenue(id, userId) {
  const venue = await Establishments.findById(id).select('owner status online').lean();
  const own = !!venue && !!userId && String(venue.owner) === String(userId);
  if (!venue || (venue.status !== true && !own)) return { status: 404, message: 'Заведение не найдено' };
  if (!own && userId && await restriction.isRestricted(venue.owner, userId)) {
    return { status: 403, message: 'Автор ограничил вам доступ к своему каналу' };
  }
  return { venue, own };
}

router.get('/api/venues/:id/chat', async (req, res) => {
  const access = await chatVenue(req.params.id, req.session.userId);
  if (!access.venue) return res.status(access.status).json({ message: access.message });
  const query = { venueId: req.params.id };
  const since = typeof req.query.since === 'string' && req.query.since ? new Date(req.query.since) : null;
  if (since && !isNaN(since.getTime())) query.createdAt = { $gt: since };
  const list = await ChatMessage.find(query).select('userId username message createdAt')
    .sort({ createdAt: -1 }).limit(HISTORY).lean();
  res.json(list.reverse());
});

router.post('/api/venues/:id/chat', requireAuth, requireNotBanned, chatLimiter, validate({
  message: { type: 'string', required: true, min: 1, max: 500, label: 'Сообщение' },
}), async (req, res) => {
  const access = await chatVenue(req.params.id, req.session.userId);
  if (!access.venue) return res.status(access.status).json({ message: access.message });
  // Гости пишут, пока камера включена; владелец — всегда.
  if (!access.own && !access.venue.online) return res.status(409).json({ message: 'Заведение сейчас не показывает камеру' });
  const author = await User.findById(req.session.userId).select('nickname login email').lean();
  if (!author) return res.status(401).json({ message: 'Необходима авторизация' });
  const msg = await ChatMessage.create({
    venueId: req.params.id, userId: author._id, username: userView.displayName(author), message: req.body.message,
  });
  const io = req.app.get('io');
  if (io) {
    io.to(`venue:${req.params.id}`).emit('venue:chat', {
      _id: msg._id, venueId: req.params.id, userId: String(author._id), username: msg.username,
      message: msg.message, createdAt: msg.createdAt, own: access.own,
    });
  }
  res.json({ ok: true });
});

module.exports = { router, roomName, stopCamera };
