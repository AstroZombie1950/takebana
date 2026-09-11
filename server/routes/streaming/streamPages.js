// Страницы эфира: пульт ведущего — с камеры (/stream/:id) или с OBS
// (/stream-obs/:id) — и страница зрителя. Кому что показать, решает маршрут:
// владельцу эфира — пульт, остальным — просмотр.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const Stream = require('../../models/Stream');
const Subscription = require('../../models/Subscription');
const { requireAuth, requireOwner } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { commonDataMiddleware, getRandomGradient } = require('./shared');
const { buildObsStreamKey, getSignExpiry } = require('../../utils/rtmpAuth');

const OBJECT_ID = /^[a-f\d]{24}$/i;

// Что значит «ведущий открыл пульт»: веб-пульт переводит эфир на Daily
// и считает его ещё не начатым — он стартует с кнопки; OBS-пульт переводит
// эфир на приём с программы.
const PAGE_MODES = {
  web: { streamType: 'daily-stream', streamProvider: 'web-stream', isActive: false, startedAt: null },
  obs: { streamType: 'obs-stream', streamProvider: 'obs' },
};

// Эфир и его автор для шапки эфира. null — эфира нет или нет автора.
async function loadStream(streamId) {
  if (!OBJECT_ID.test(streamId)) return null;
  const stream = await Stream.findById(streamId).populate('userId', 'login email avatar').lean();
  if (!stream || !stream.userId) return null;

  const author = stream.userId;
  const displayName = author.login || (author.email ? author.email.split('@')[0] : 'Неизвестный пользователь');
  const user = {
    _id: author._id,
    displayName,
    avatarStyle: author.avatar
      ? { url: author.avatar }
      : { gradient: getRandomGradient(), initial: displayName.charAt(0).toUpperCase() },
  };
  return { stream, user };
}

// Пульт показывает эфир таким, каким его сделает POST .../enter, который он
// отправит сразу после загрузки. Сам GET в базу не пишет: раньше писал, и
// эфир снимали префетч браузера, предпросмотр ссылки в мессенджере и обход
// ссылок аудитом.
function renderConsole(req, res, { stream, user }, mode) {
  Object.assign(stream, PAGE_MODES[mode]);
  res.render('streamPage', {
    stream,
    user,
    obsOnly: mode === 'obs',
    streamKey: stream.streamKey,
    // Ключ вместе с подписью — то, что вставляют в OBS. Видит только владелец.
    obsStreamKey: buildObsStreamKey(stream.streamKey),
    obsKeyExpiresAt: getSignExpiry(),
    // Приём — на том же хосте, где открыт пульт: зашитый домен вёл OBS
    // на боевой сервер с любого стенда.
    rtmpUrl: `rtmp://${req.hostname}:1935/live`,
  });
}

router.get('/stream/:streamId', commonDataMiddleware, async (req, res) => {
  if (!req.session.userId) return res.redirect('/');

  const page = await loadStream(req.params.streamId);
  if (!page) return res.status(404).render('streamNotFound');

  const isStreamer = String(page.user._id) === String(req.session.userId);

  // Гейт 18+ — до всего остального: страница помеченного эфира не должна
  // ни отдать плеер, ни записать зрителя в комнату, пока возраст не
  // подтверждён. Вещателя не спрашиваем — метку он поставил сам.
  if (page.stream.isAdult && !isStreamer && !(res.locals.currentUser && res.locals.currentUser.adultConfirmedAt)) {
    return res.render('ageGate');
  }

  if (isStreamer) return renderConsole(req, res, page, 'web');

  const isSubscribed = !!(await Subscription.exists({
    subscriberId: req.session.userId,
    subscribedToId: page.user._id,
  }));
  res.render('streamPageViewer', { ...page, isSubscribed, streamKey: page.stream.streamKey });
});

router.get('/stream-obs/:streamId', commonDataMiddleware, async (req, res) => {
  if (!req.session.userId) return res.redirect('/');

  const page = await loadStream(req.params.streamId);
  if (!page) return res.status(404).render('streamNotFound');

  // Зритель всегда на обычной странице просмотра.
  if (String(page.user._id) !== String(req.session.userId)) {
    return res.redirect(`/stream/${req.params.streamId}`);
  }
  renderConsole(req, res, page, 'obs');
});

// Ведущий открыл пульт — веб или OBS. Отдельным POST, а не внутри GET
// страницы: GET обязан быть безопасным, его делают префетч браузера,
// предпросмотр ссылок в мессенджерах и краулеры. Зрители получают
// stream:update и перезагружают плеер под новый тип эфира.
router.post('/stream/:streamId/enter', requireAuth,
  // requireOwner ищет эфир по :streamId, и кривой идентификатор ронял бы его в 500.
  (req, res, next) => (OBJECT_ID.test(req.params.streamId) ? next() : res.status(404).json({ message: 'Эфир не найден' })),
  validate({ mode: { type: 'string', required: true, values: Object.keys(PAGE_MODES), label: 'Страница' } }),
  requireOwner(Stream, { param: 'streamId', field: 'userId' }), async (req, res) => {
  const stream = await Stream.findByIdAndUpdate(req.params.streamId,
    { $set: { ...PAGE_MODES[req.body.mode], updatedAt: Date.now() } },
    { new: true }).select('streamKey streamType streamProvider isActive').lean();

  const io = req.app.get('io');
  if (io && stream.streamKey) {
    io.to(`stream:${stream.streamKey}`).emit('stream:update', {
      streamKey: stream.streamKey,
      streamType: stream.streamType,
      streamProvider: stream.streamProvider,
      isActive: !!stream.isActive
    });
  }
  res.json({ ok: true });
});

module.exports = router;
