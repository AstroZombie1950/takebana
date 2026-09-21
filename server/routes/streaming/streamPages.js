// Страницы эфира: студия (/studio) — настройки и выход в эфир, пульт
// ведущего и страница зрителя (/stream/:id). Кому что показать, решает
// маршрут: владельцу эфира — пульт, остальным — просмотр. Пульт и студия —
// один шаблон: студия превращается в пульт, как только эфир создан.

const express = require('express');
const restriction = require('../../utils/restrict');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const Stream = require('../../models/Stream');
const Subscription = require('../../models/Subscription');
const User = require('../../models/User');
const catalog = require('../../config/catalog');
const { commonDataMiddleware } = require('./shared');
const { requireAuth } = require('../../middleware/auth');
const recording = require('../../utils/recording');
const { randomUUID } = require('crypto');
const userView = require('../../utils/userView');
const { buildObsStreamKey, getSignExpiry } = require('../../utils/rtmpAuth');

const OBJECT_ID = /^[a-f\d]{24}$/i;

// Эфир и его автор для шапки эфира. null — эфира нет или нет автора.
async function loadStream(streamId) {
  if (!OBJECT_ID.test(streamId)) return null;
  const stream = await Stream.findById(streamId).populate('userId', 'nickname login email avatar').lean();
  if (!stream || !stream.userId) return null;

  const author = stream.userId;
  const displayName = userView.displayName(author);
  const user = {
    _id: author._id,
    displayName,
    avatarStyle: userView.avatarStyle(author, displayName),
  };
  return { stream, user };
}

// Пульт и студия. stream — эфир владельца или null, если его ещё нет.
// Ключ и адрес для OBS видны уже в студии: программу настраивают до выхода
// в эфир. Вебу настраивать нечего — ему ключ не показываем.
function renderConsole(req, res, { stream, user, defaults, streamKey }) {
  res.render('streamPage', {
    stream,
    user,
    defaults,
    catalog,
    recordingEnabled: recording.enabled,
    // «Выйти в эфир» в студии перезагружает страницу пультом с ?go=1:
    // пульт подключает камеру сам.
    autostart: !!stream && req.query.go === '1',
    // Ключ вместе с подписью — то, что вставляют в OBS. Видит только владелец.
    obsStreamKey: buildObsStreamKey(streamKey),
    obsKeyExpiresAt: getSignExpiry(),
    // Приём — на том же хосте, где открыт пульт: зашитый домен вёл OBS
    // на боевой сервер с любого стенда.
    rtmpUrl: `rtmp://${req.hostname}:1935/live`,
  });
}

// Студия: кнопки «Запустить эфир» в шапке и меню. Эфир уже есть — на его
// пульт: второго эфира у одного человека не бывает.
router.get('/studio', requireAuth, commonDataMiddleware, async (req, res) => {
  const existing = await Stream.findOne({ userId: req.session.userId }).select('_id').lean();
  if (existing) return res.redirect(`/stream/${existing._id}`);

  // Ключ трансляции — ключ пользователя, постоянный. Появляется при первом
  // визите в студию: в OBS его вставляют раньше, чем эфир создан.
  const owner = await User.findById(req.session.userId).select('streamKey streamDefaults');
  if (!owner.streamKey) {
    owner.streamKey = randomUUID();
    await owner.save();
  }
  renderConsole(req, res, { stream: null, user: null, defaults: owner.streamDefaults || {}, streamKey: owner.streamKey });
});

// Гость смотрит эфир и читает чат; писать, подписаться и пожаловаться —
// после входа (streamInfo.ejs, streamChat.ejs).
router.get('/stream/:streamId', commonDataMiddleware, async (req, res) => {
  const page = await loadStream(req.params.streamId);
  if (!page) return res.status(404).render('streamNotFound');

  const isStreamer = String(page.user._id) === String(req.session.userId);
  const blocked = await restriction.isRestricted(page.user._id, req.session.userId);
  res.locals.pageOwner = { id: String(page.user._id), scope: 'content', access: blocked ? 'them' : '' };
  if (blocked) return res.status(403).render('streamNotFound', { restricted: true });

  // Гейт 18+ — до всего остального: страница помеченного эфира не должна
  // ни отдать плеер, ни записать зрителя в комнату, пока возраст не
  // подтверждён. Вещателя не спрашиваем — метку он поставил сам. Гостю
  // подтверждать нечем: возраст хранится в аккаунте, гейт зовёт войти.
  if (page.stream.isAdult && !isStreamer && !(res.locals.currentUser && res.locals.currentUser.adultConfirmedAt)) {
    return res.render('ageGate');
  }

  if (isStreamer) {
    return renderConsole(req, res, { ...page, defaults: page.stream, streamKey: page.stream.streamKey });
  }

  const isSubscribed = !!req.session.userId && !!(await Subscription.exists({
    subscriberId: req.session.userId,
    subscribedToId: page.user._id,
  }));
  res.render('streamPageViewer', { ...page, isSubscribed, streamKey: page.stream.streamKey });
});

module.exports = router;
