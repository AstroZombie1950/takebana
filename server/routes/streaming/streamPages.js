// Страницы эфира: зрительская и вещательская (вход с OBS).

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const User = require('../../models/User');
const Stream = require('../../models/Stream');
const ChatMessage = require('../../models/ChatMessage');
const Subscription = require('../../models/Subscription');
const { requireAuth, requireOwner } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { commonDataMiddleware, getRandomGradient } = require('./shared');
const { buildObsStreamKey, getSignExpiry } = require('../../utils/rtmpAuth');

const OBJECT_ID = /^[a-f\d]{24}$/i;

// Что значит «ведущий открыл страницу»: веб-страница переводит эфир на Daily
// и считает его ещё не начатым — он стартует с кнопки; OBS-страница переводит
// эфир на приём с пульта.
const PAGE_MODES = {
  web: { streamType: 'daily-stream', streamProvider: 'web-stream', isActive: false, startedAt: null },
  obs: { streamType: 'obs-stream', streamProvider: 'obs' },
};

router.get('/stream/:streamId', commonDataMiddleware, async (req, res) => {
  if (!req.session.userId) { // Проверка авторизации
    return res.redirect('/');
  }

  const { streamId } = req.params;

  try {
    // ВЕБ-страница стримера (Daily/WebRTC). Это отдельная страница от OBS.
    const stream = await Stream.findById(streamId).populate('userId');


    if (!stream) {
      // Рендерим кастомный шаблон для отсутствующего стрима
      return res.status(404).render('streamNotFound');
    }

    // Определяем, является ли текущий пользователь стримером
    const currentUserId = res.locals.currentUser ? res.locals.currentUser._id.toString() : null;
    const isStreamer = currentUserId && currentUserId === stream.userId._id.toString();

    // Гейт 18+. Проверка стоит до всего остального: страница помеченного эфира
    // не должна ни отдать плеер, ни записать зрителя в комнату, пока возраст
    // не подтверждён. Вещателя не спрашиваем — метку он поставил сам.
    if (stream.isAdult && !isStreamer && !(res.locals.currentUser && res.locals.currentUser.adultConfirmedAt)) {
      return res.render('ageGate');
    }

    // Ведущему страница показывает эфир таким, каким его сделает POST .../enter,
    // который она отправит сразу после загрузки. Сам GET в базу не пишет:
    // раньше писал, и эфир снимали префетч браузера, предпросмотр ссылки
    // в мессенджере и обход ссылок аудитом.
    if (isStreamer) Object.assign(stream, PAGE_MODES.web);

    // Подготавливаем данные стримера для шаблона
    const streamerUser = stream.userId;

    const displayName = streamerUser.login || (streamerUser.email ? streamerUser.email.split('@')[0] : 'Неизвестный пользователь');
    const avatarStyle = streamerUser.avatar
      ? { url: streamerUser.avatar }
      : { gradient: getRandomGradient(), initial: displayName.charAt(0).toUpperCase() };

    const user = {
      _id: streamerUser._id,
      displayName,
      avatarStyle
    };

    // Проверка подписки текущего пользователя на стримера через коллекцию subscriptions
    let isSubscribed = false;
    if (currentUserId && !isStreamer) { // Если пользователь не является стримером
      const existingSubscription = await Subscription.findOne({
        subscriberId: currentUserId,
        subscribedToId: streamerUser._id
      });

      if (existingSubscription) {
        isSubscribed = true;
      }
    }

    // streamKey для сокет-комнаты/счетчика зрителей должен быть ЕДИНЫМ для стрима
    // (иначе у стримера и у зрителей будут разные ключи и счетчик не обновится).
    // Источник истины — поле Stream.streamKey.
    let streamKey = stream.streamKey;

    // ВАЖНО: Проверяем что streamKey есть, если нет - берем из user.streamKey
    if (!streamKey || streamKey === '') {
      console.warn('[WARNING] Stream.streamKey is empty, using user.streamKey');
      streamKey = stream.userId.streamKey || streamerUser?.streamKey;
      if (!streamKey) {
        console.error('[ERROR] No streamKey found for stream:', stream._id);
      }
    }

    // На всякий случай синхронизируем user.streamKey если вдруг пустой (стрим уже создан, key есть).
    if (isStreamer && streamerUser && (!streamerUser.streamKey || streamerUser.streamKey === '')) {
      streamerUser.streamKey = stream.streamKey || streamKey;
      await streamerUser.save();
    }

    // Загрузка сообщений для данного стрима
    // Та же причина, что и выше: populate тянул сюда весь документ User.
    const chatMessages = await ChatMessage.find({ streamId })
      .select('streamId userId username message createdAt')
      .sort({ createdAt: 1 })
      .lean();

    let start_server_env = process.env.START_SERVER;
    // Рендерим шаблон с передачей всех необходимых данных
    if (isStreamer) {
      res.render('streamPage', {
        stream,
        user, // Данные о стримере
        isStreamer,
        isSubscribed, // Статус подписки
        streamKey, // Передаем streamKey ВСЕМ (и стримеру, и зрителям) для счетчика
        // Ключ вместе с подписью — то, что вставляют в OBS. Видит только владелец.
        obsStreamKey: buildObsStreamKey(streamKey),
        obsKeyExpiresAt: getSignExpiry(),
        chatMessages, // Передаем сообщения в шаблон
        start_server_env,
        obsOnly: false
      });
    } else {
      res.render('streamPageViewer', {
        stream,
        user, // Данные о стримере
        isStreamer,
        isSubscribed, // Статус подписки
        streamKey, // Передаем streamKey ВСЕМ (и стримеру, и зрителям) для счетчика
        chatMessages, // Передаем сообщения в шаблон
        start_server_env
      });
    }
  } catch (error) {
    console.error('Ошибка при получении стрима:', error);
    res.status(500).send('Ошибка сервера');
  }
});

// OBS-страница стримера (отдельная от WEB/Daily)
router.get('/stream-obs/:streamId', commonDataMiddleware, async (req, res) => {
  if (!req.session.userId) return res.redirect('/');

  const { streamId } = req.params;
  try {
    const stream = await Stream.findById(streamId).populate('userId');
    if (!stream) return res.status(404).render('streamNotFound');

    const currentUserId = res.locals.currentUser ? res.locals.currentUser._id.toString() : null;
    const isStreamer = currentUserId && currentUserId === stream.userId._id.toString();
    if (!isStreamer) {
      // зритель всегда на обычной странице просмотра
      return res.redirect(`/stream/${streamId}`);
    }

    // Как и у веб-страницы: показываем, а пишет в базу POST .../enter.
    Object.assign(stream, PAGE_MODES.obs);

    const streamerUser = stream.userId;
    const displayName = streamerUser.login || (streamerUser.email ? streamerUser.email.split('@')[0] : 'Неизвестный пользователь');
    const avatarStyle = streamerUser.avatar
      ? { url: streamerUser.avatar }
      : { gradient: getRandomGradient(), initial: displayName.charAt(0).toUpperCase() };

    const user = { _id: streamerUser._id, displayName, avatarStyle };

    // streamKey
    let streamKey = stream.streamKey || streamerUser?.streamKey;
    let start_server_env = process.env.START_SERVER;

    res.render('streamPage', {
      stream,
      user,
      isStreamer: true,
      isSubscribed: false,
      streamKey,
      obsStreamKey: buildObsStreamKey(streamKey),
      obsKeyExpiresAt: getSignExpiry(),
      chatMessages: [],
      start_server_env,
      obsOnly: true
    });
  } catch (e) {
    console.error('Ошибка при открытии OBS страницы:', e);
    res.status(500).send('Ошибка сервера');
  }
});

// Ведущий открыл страницу эфира — веб или OBS. Отдельным POST, а не внутри
// GET страницы: GET обязан быть безопасным, его делают префетч браузера,
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

// crypto.randomUUID() встроен в Node и даёт тот же формат, что uuid v4.
// Пакет uuid убран: использовался только ради v4, а его advisory
// (буфер в v3/v5/v6) тянулся в аудит на пустом месте.

module.exports = router;
