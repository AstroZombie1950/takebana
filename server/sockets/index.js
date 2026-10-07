// Socket.IO: присутствие, комнаты эфиров, звонки, доставка сообщений.
//
// Состояние держится в памяти процесса, поэтому pm2 запускает приложение
// в одном экземпляре (ops/ecosystem.config.js). Второй процесс не увидит ни
// счётчика зрителей, ни звонков — для этого нужен Redis-адаптер, он в списке
// работ за рамками текущего объёма.

const User = require('../models/User');
const Message = require('../models/Message');
const Stream = require('../models/Stream');
const Establishments = require('../models/Establishments');
const streamLog = require('../utils/streamLog');
const daily = require('../utils/daily');
const callLog = require('../utils/callLog');
const groupPush = require('../utils/groupPush');
const errorLog = require('../utils/errorLog');
const turn = require('../utils/turn');
const venueCam = require('../utils/venueCam');
const ioHolder = require('../utils/io');
const userView = require('../utils/userView');
const restriction = require('../utils/restrict');
const privacy = require('../utils/privacy');
const { LIVE_ROOM } = require('../utils/liveSignal');
const socketLimit = require('../utils/socketLimit');

// Список подписок приходит от клиента, поэтому и формат, и длина проверяются.
const OBJECT_ID = /^[a-f\d]{24}$/i;
// Ключ трансляции — как в middleware/validate.js.
const STREAM_KEY = /^[\w-]{1,128}$/;
const PRESENCE_SUBSCRIBE_LIMIT = 200;

// Сколько ждать возвращения человека, прежде чем считать обрыв сокета концом
// звонка. Звук и видео идут не через сокет (Daily или свой путь): смена сети на
// телефоне рвёт сокет на секунды, а разговор при этом продолжается. Раньше
// любой такой обрыв завершал звонок у обоих. 20 секунд — столько же Daily
// сам ждёт восстановления своей сигнализации, прежде чем выкинуть участника.
const CALL_GRACE_MS = 20000;

// Сколько ждать, прежде чем объявить человека вне сети. Сайт — многостраничный:
// каждый переход по ссылке закрывает сокет старой страницы и открывает новый.
// Без отсрочки человек на каждом клике на миг уходил в офлайн, а запись
// «в сети» от новой страницы могла проиграть в базе записи «вне сети» от
// старой — и он оставался офлайн, сидя на сайте (жалоба заказчика 21.09).
// Минута (решение 21.09.2026): телефон на секунды теряет сеть в лифте
// и метро, и мигать «вне сети» из-за этого незачем. Смотреть видео или
// печатать — это открытая вкладка, то есть «в сети» и без отсрочки.
// Та же минута — после того как человек свернул приложение (02.10).
const PRESENCE_GRACE_MS = 60000;

// Сигналы своего пути (SDP, кандидаты) — объект от браузера. SDP звонка —
// единицы килобайт; больше — не сигнал.
const SIGNAL_MAX = 32000;

// Потолок группового звонка (решение заказчика 23.09.2026). Разговор идёт
// сеткой: каждый держит соединение с каждым, и на четверых это три
// исходящих потока — предел мобильного канала. Больше — только через SFU,
// это отдельная работа.
const GROUP_MAX = 4;

// Сколько ждём ответа приглашённого в идущий разговор — как и обычного
// звонка (routes/calls.js).
const INVITE_MS = 30000;

// Потолок нашего TURN (решение 25.09.2026): порты реле не расширяли —
// звонков своим путём мало, трафик в основном идёт через Daily. Зато упор
// должен быть виден заранее: с этой доли занятых портов — запись в журнал
// ошибок. Сам отказ coturn (508) сообщает браузер (public/tk-peer.js).
const TURN_WARN_SHARE = 0.8;

// Возвращает общие хранилища, чтобы app.js положил их в app.set(...):
// маршрут /api/calls/create достаёт их оттуда.
function registerSockets(io) {
  const userRooms = new Map(); // userId -> Set(socketIds)
  const pendingCalls = new Map(); // callId -> {callerId, calleeId, type, createdAt}
  // callId -> {callerId, calleeId, type, engine: 'daily'|'own', roomName,
  //            startedAt, members: Map(userId -> {joinedAt}),
  //            invited: Map(userId -> время приглашения)}
  const activeCalls = new Map();
  const offlineTimers = new Map(); // userId -> таймер отсрочки офлайна
  const shownOnline = new Set(); // кого показываем «в сети»
  const leftAt = new Map(); // userId -> когда ушёл с экрана: это его lastSeen
  const presenceWrites = new Map(); // userId -> последняя запись присутствия в очереди

  // Присутствие в базу — по очереди на человека и всегда то, что есть в эту
  // секунду, а не то, что было, когда запись ставили в очередь. Две записи
  // одного человека по разным соединениям пула приходят в базу в любом
  // порядке; очередь и чтение состояния в момент записи это исключают.
  function syncPresence(userId) {
    const prev = presenceWrites.get(userId) || Promise.resolve();
    const next = prev.then(async () => {
      const isOnline = shownOnline.has(userId);
      const set = isOnline ? { isOnline } : { isOnline, lastSeen: leftAt.get(userId) || new Date() };
      const before = await User.findOneAndUpdate({ _id: userId }, { $set: set }, { projection: { isOnline: 1 } }).lean();
      if (!isOnline) leftAt.delete(userId);
      if (before && !!before.isOnline === isOnline) return; // ничего не поменялось — и звать некого
      // Кому время визита скрыто (utils/privacy.js, lastSeenRule), те
      // сидят ещё и в nolast:<id> — им то же событие без времени.
      io.to(`presence:${userId}`).except(`nolast:${userId}`).emit('presence:update', { userId, isOnline, lastSeen: set.lastSeen });
      io.to(`nolast:${userId}`).emit('presence:update', { userId, isOnline, lastSeen: null });
    }).catch((e) => errorLog.server(e, 'socket.presence'));
    presenceWrites.set(userId, next);
    next.then(() => { if (presenceWrites.get(userId) === next) presenceWrites.delete(userId); });
  }

  // После перезапуска в базе остаются «в сети» те, кто был подключён к прошлому
  // процессу. Кто жив — переподключится за секунды и вернёт себе отметку.
  User.updateMany({ isOnline: true }, { $set: { isOnline: false, lastSeen: new Date() } })
    .then(() => { for (const userId of shownOnline) syncPresence(userId); })
    .catch((e) => errorLog.server(e, 'socket.presenceReset'));

  // «В сети» — вкладка на экране, а не живой сокет (02.10). Android держит
  // соединение свёрнутого приложения с иконки долго, компьютер — у фоновой
  // вкладки бесконечно, и человек часами висел «в сети» (жалоба заказчика
  // 01.10). Свернул, спрятал, заблокировал экран (tk:away, public/tk-app.js)
  // или закрыл — через минуту отсрочки «не в сети» с временем ухода.
  function anyOnScreen(userId) {
    for (const id of userRooms.get(userId) || []) {
      const s = io.sockets.sockets.get(id);
      if (s && !s.data.away) return true;
    }
    return false;
  }

  // Зовётся на подключении, отключении и tk:away. Вернулся в пределах
  // отсрочки (переход по ссылке, лифт) — для всех он и не уходил.
  function updatePresence(userId) {
    if (anyOnScreen(userId)) {
      clearTimeout(offlineTimers.get(userId));
      offlineTimers.delete(userId);
      if (shownOnline.has(userId)) return;
      shownOnline.add(userId);
      syncPresence(userId);
    } else if (shownOnline.has(userId) && !offlineTimers.has(userId)) {
      const since = new Date();
      offlineTimers.set(userId, setTimeout(() => {
        offlineTimers.delete(userId);
        shownOnline.delete(userId);
        leftAt.set(userId, since);
        syncPresence(userId);
      }, PRESENCE_GRACE_MS).unref());
    }
  }

  // Зрители эфира — люди в его комнате (utils/io.js, viewers); вкладки
  // самого ведущего не считаются.
  const viewersIn = (roomName, streamKey) =>
    ioHolder.viewers(io, roomName, (s) => s.data.ownStreamKey === streamKey);

  // Счётчик уходит всей комнате, и слать его на каждый вход и выход нельзя:
  // тысяча входов на эфир с тысячей зрителей — миллион сообщений. Не чаще
  // раза в COUNT_MS на комнату, с последним числом. Это же число отдаём
  // входящему (join-stream-room) и по нему включаем медленный режим.
  const COUNT_MS = 2000;
  const countTimers = new Map();
  function announceViewers(streamKey) {
    if (countTimers.has(streamKey)) return;
    countTimers.set(streamKey, setTimeout(() => {
      countTimers.delete(streamKey);
      const roomName = `stream:${streamKey}`;
      const count = viewersIn(roomName, streamKey);
      const wasSlow = ioHolder.autoSlow(streamKey);
      ioHolder.setCount(streamKey, count);
      io.to(roomName).emit('viewers-count-updated', { streamKey, count });
      if (ioHolder.autoSlow(streamKey) === wasSlow) return;
      // Эфир перешёл порог большого — подсказка над полем у всех меняется сразу.
      Stream.findOne({ streamKey }).select('streamKey slowMode').lean()
        .then((s) => { if (s) io.to(roomName).emit('chat:slow', { streamKey, seconds: ioHolder.slowFor(s), manual: s.slowMode || 0 }); })
        .catch((e) => errorLog.server(e, 'socket.autoSlow', { streamKey }));
    }, COUNT_MS).unref());
  }

  // Камера заведения (страница /venue/:id/live, с 24.09): в комнате
  // venue:<id> все, кто открыл страницу, — чат и смена состояния камеры
  // приходят туда. Счёт зрителей — utils/venueCam.js: по нему же камера
  // вещает, только пока её смотрят. Рассылка — не чаще раза в COUNT_MS.
  function announceVenue(venueId) {
    const key = 'venue:' + venueId;
    if (countTimers.has(key)) return;
    countTimers.set(key, setTimeout(() => {
      countTimers.delete(key);
      const count = venueCam.count(venueId);
      io.to(key).emit('venue:viewers', { venueId, count });
      venueCam.viewers(venueId, count).catch((e) => errorLog.server(e, 'venueCam.viewers', { venueId }));
    }, COUNT_MS).unref());
  }

  // Разговор — это участники, а не пара: у идущего звонка есть members
  // (userId → когда вошёл), и на двоих в нём просто две записи. Поля
  // callerId и calleeId остаются: по ним пишется журнал и работает Daily,
  // который в группах не участвует.
  const everyone = (call) => {
    let to = io;
    for (const id of call.members.keys()) to = to.to(`user:${id}`);
    return to;
  };
  const isParty = (call, userId) => !!call && (call.members
    ? call.members.has(userId)
    : userId === call.callerId || userId === call.calleeId);

  // Карточка человека для окна звонка: имя и аватар. Плиткам сетки нужно
  // подписывать, кто на них, а по одному userId этого не скажешь.
  async function peerCard(userId) {
    const user = await User.findById(userId).select('nickname login email avatar').lean();
    if (!user) return { userId: String(userId), displayName: '' };
    return { userId: String(userId), displayName: userView.displayName(user), avatarUrl: user.avatar || null };
  }

  // Звонок через свой сервер (public/tk-peer.js): браузеры соединяются между
  // собой, сокет только передаёт сигналы. Каждому — свои ключи TURN.
  //
  // Кто кому делает предложение: тот, кто вошёл в разговор раньше. На двоих
  // это звонящий, в группе — все, кто уже разговаривал, навстречу новичку.
  // Правило одно на всех, поэтому гонок «оба предложили» не бывает.
  function ownAccess(callId, call, userId) {
    const mine = call.members.get(userId);
    const peers = [];
    for (const [id, m] of call.members) {
      if (id === userId) continue;
      peers.push({ userId: id, offerer: m.joinedAt > mine.joinedAt });
    }
    return { type: call.type, engine: 'own', group: call.members.size > 2, ice: turn.iceServers(userId, { callId }), peers };
  }

  // suspect — тот, у кого Daily не работает: его браузер запомнит свой путь
  // (public/tk-app.js, OWN_KEY), у второго Daily, возможно, в порядке.
  function goOwn(callId, call, event, suspect) {
    call.engine = 'own';
    for (const userId of call.members.keys()) {
      io.to(`user:${userId}`).emit(event, { callId, ...ownAccess(callId, call, userId), remember: userId === suspect });
    }
    turnLoad();
  }

  // Оценка занятых портов TURN по идущим разговорам своим путём (utils/turn.js).
  // Пишем, когда перешли порог, и снова — только когда нагрузка спадала
  // ниже половины: иначе каждый звонок около порога давал бы запись.
  let turnWarned = false;
  function turnLoad() {
    let ports = 0, calls = 0;
    for (const call of activeCalls.values()) {
      if (call.engine !== 'own') continue;
      calls++;
      ports += turn.portsFor(call.members.size);
    }
    if (ports < turn.PORTS / 2) turnWarned = false;
    if (turnWarned || ports < turn.PORTS * TURN_WARN_SHARE) return;
    turnWarned = true;
    errorLog.media(new Error(`TURN близко к потолку: занято ~${ports} портов реле из ${turn.PORTS} (разговоров своим путём: ${calls})`),
      'turn.capacity', { ports, of: turn.PORTS, calls });
  }

  // Комнату звонка удаляем сразу: иначе она жила бы до своего exp,
  // и в неё можно было бы вернуться с ещё действующим токеном.
  function finishCall(callId, event = 'call:ended') {
    const call = pendingCalls.get(callId) || activeCalls.get(callId);
    if (!call) return;
    // До ответа — отмена (у получателя это пропущенный), после — конец разговора.
    callLog.ended(io, callId, event === 'call:failed' ? 'failed' : 'canceled');
    pendingCalls.delete(callId);
    activeCalls.delete(callId);
    // Звонок группе кончился раньше, чем отзвонило: кто не дошёл — «вам звонили».
    groupPush.missedCall(io, call);
    if (call.members) everyone(call).emit(event, { callId });
    else io.to([`user:${call.callerId}`, ...[...(call.calleeIds || [call.calleeId])].map((id) => `user:${id}`)]).emit(event, { callId });
    // Приглашённый, который не успел ответить, тоже гасит своё окно.
    if (call.invited) for (const id of call.invited.keys()) io.to(`user:${id}`).emit('call:canceled', { callId });
    if (call.roomName) {
      daily.deleteRoom(call.roomName).catch((e) => errorLog.external(e, 'daily.deleteRoom', { call: callId }));
    }
  }

  // Человек вышел из разговора. Вдвоём это конец звонка, втроём и больше —
  // остальные продолжают, у них просто гаснет его плитка.
  function leaveCall(callId, userId) {
    const call = activeCalls.get(callId);
    if (!call || !call.members.has(userId)) return;
    if (call.members.size <= 2) return finishCall(callId);
    call.members.delete(userId);
    callLog.left(callId, userId);
    everyone(call).emit('call:peer:left', { callId, userId });
    io.to(`user:${userId}`).emit('call:ended', { callId });
  }

  // Приглашённый взял трубку: он входит в разговор последним, поэтому
  // предложения соединения делают ему остальные, а он только отвечает.
  async function joinGroup(socket, callId, call) {
    const userId = socket.data.userId;
    call.invited.delete(userId);
    // Взял трубку — звонок до него дошёл, даже если места уже нет.
    if (call.missed) call.missed.delete(userId);
    // Места кончились, пока звонило (звонок группе зовёт всех, кто в сети).
    if (call.members.size >= GROUP_MAX) return socket.emit('call:full', { callId });
    call.members.set(userId, { joinedAt: Date.now() });
    callLog.joined(callId, userId);
    turnLoad();

    const cards = new Map();
    for (const id of call.members.keys()) cards.set(id, await peerCard(id));
    if (!activeCalls.has(callId)) return; // разговор кончился, пока собирали карточки

    // Новичку — весь состав разом, остальным — только он.
    socket.emit('call:accepted', {
      callId,
      ...ownAccess(callId, call, userId),
      cards: [...cards.values()].filter((c) => c.userId !== userId),
    });
    // roster — весь состав: у двоих, что говорили до этого, имени друг
    // друга на плитке иначе не взять, они знали его только из окна звонка.
    const roster = [...cards.values()];
    for (const id of call.members.keys()) {
      if (id === userId) continue;
      io.to(`user:${id}`).emit('call:peer:join', {
        callId, peer: cards.get(userId), roster, offerer: true, ice: turn.iceServers(id, { callId }),
      });
    }
    // Остальные вкладки вошедшего перестают звонить.
    socket.to(`user:${userId}`).emit('call:canceled', { callId });
  }

  // Звонок группе (routes/groups.js): ответивший первым — собеседник для
  // журнала; остальные, кому звонило, — приглашённые: их окно продолжает
  // звонить, и кто ответит, войдёт через joinGroup, пока есть место.
  // Сразу своим путём — в группе нужна сетка, Daily в ней не участвует.
  function startChatCall(socket, callId, call) {
    const me = socket.data.userId;
    const now = Date.now();
    const invited = new Map([...call.calleeIds].filter((id) => id !== me)
      .map((id) => [id, { by: call.callerId, at: call.createdAt, quiet: true }]));
    call.missed.delete(me);
    const active = {
      callerId: call.callerId, calleeId: me, type: call.type, groupId: call.groupId,
      engine: 'own', roomName: null, startedAt: now,
      members: new Map([[call.callerId, { joinedAt: now }], [me, { joinedAt: now + 1 }]]),
      invited,
      missed: call.missed,
    };
    activeCalls.set(callId, active);
    callLog.created(callId, { callerId: call.callerId, calleeId: me, type: call.type, chat: call.groupId });
    callLog.answered(callId, 'own');
    socket.to(`user:${me}`).emit('call:canceled', { callId });
    goOwn(callId, active, 'call:accepted');
    // Кому звонило и кто так и не ответил за полминуты с начала — гаснет.
    setTimeout(() => {
      const live = activeCalls.get(callId);
      if (!live) return;
      for (const [id, inv] of live.invited) {
        if (!inv.quiet) continue;
        live.invited.delete(id);
        io.to(`user:${id}`).emit('call:canceled', { callId });
      }
      groupPush.missedCall(io, live);
    }, Math.max(0, 30000 - (now - call.createdAt))).unref();
  }

  function finishCallsOf(userId) {
    for (const [id, c] of pendingCalls) if (isParty(c, userId)) finishCall(id);
    for (const [id, c] of activeCalls) {
      if (!isParty(c, userId)) continue;
      if (c.members.size > 2) leaveCall(id, userId); else finishCall(id);
    }
  }

  // Человек вышел на связь: всё, что ему написали, пока его не было, дошло.
  // Отправители получают вторую галочку.
  async function markDelivered(userId) {
    const pending = await Message.find({ recipient: userId, deliveredAt: null }).select('_id sender').lean();
    if (!pending.length) return;
    const at = new Date();
    await Message.updateMany({ _id: { $in: pending.map((m) => m._id) } }, { $set: { deliveredAt: at } });
    const bySender = new Map();
    for (const m of pending) {
      const key = String(m.sender);
      if (!bySender.has(key)) bySender.set(key, []);
      bySender.get(key).push(String(m._id));
    }
    for (const [sender, ids] of bySender) io.to(`user:${sender}`).emit('message:delivered', { ids, at });
  }

  io.on('connection', (socket) => {
    // Адрес — для счёта гостей-зрителей (viewersIn). За nginx настоящий —
    // последний в X-Forwarded-For: его дописал сам nginx, а начало цепочки
    // присылает клиент и подделывает как угодно.
    const forwarded = String(socket.handshake.headers['x-forwarded-for'] || '').split(',').pop().trim();
    socket.data.ip = forwarded || socket.handshake.address;
    // Частота событий с соединения — до любых обработчиков (utils/socketLimit.js).
    socket.use(socketLimit(socket));

    // Все обработчики — через on(). Socket.IO зовёт их без перехвата, и
    // исключение уходило в uncaughtException, где процесс выходит: одним
    // пакетом 42["call:decline",null] гость ронял сервер со всеми эфирами.
    // Здесь и синхронная ошибка, и отказ промиса только пишутся в журнал.
    const on = (event, fn) => socket.on(event, (...args) => {
      try {
        const r = fn(...args);
        if (r && typeof r.catch === 'function') r.catch((e) => errorLog.server(e, 'socket.' + event));
      } catch (e) {
        errorLog.server(e, 'socket.' + event);
      }
    });
    // У звонков аргумент — объект; null, строка, число, массив — пустой.
    const onCall = (event, fn) => on(event, (d, ...rest) => fn(d && typeof d === 'object' && !Array.isArray(d) ? d : {}, ...rest));

    // Вкладка ушла с экрана или вернулась (public/tk-app.js). Пуши
    // (utils/push.js, onScreen) и «в сети» смотрят на это, а не на живой
    // сокет: свёрнутое приложение держит соединение ещё долго, а человек уже
    // не смотрит. Первое значение — из рукопожатия: страница может
    // подключиться, будучи в фоне.
    socket.data.away = !!(socket.handshake.auth && socket.handshake.auth.away === true);

    // Presence connect (только для аутентифицированных)
    try {
      const userId = socket.data.userId;
      if (userId) {
        socket.join(`user:${userId}`);
        const set = userRooms.get(userId) || new Set();
        set.add(socket.id);
        userRooms.set(userId, set);
        // Без await: обработчики ниже обязаны встать в момент подключения.
        updatePresence(userId);
        if (set.size === 1) markDelivered(userId).catch((e) => errorLog.server(e, 'socket.delivered'));
      }
    } catch (e) {
      errorLog.server(e, 'socket.presence');
    }

    // Подписка на присутствие. Раньше presence:update уходил через io.emit —
    // то есть каждому подключённому браузеру про каждого пользователя, кем бы он
    // ему ни приходился. Теперь клиент называет тех, чьи точки у него на экране
    // (шапка собирает их из [data-presence-user]), и получает только их.
    // Кто скрыл «в сети» от этого человека (utils/privacy.js), в комнату
    // не попадает: его событий тот не получит вовсе.
    on('presence:subscribe', async (ids) => {
      if (!Array.isArray(ids)) return;
      // Потолок на всякий случай: список приходит от клиента, а комнаты стоят памяти.
      const wanted = ids.slice(0, PRESENCE_SUBSCRIBE_LIMIT).filter((id) => typeof id === 'string' && OBJECT_ID.test(id));
      if (!wanted.length) return;
      try {
        for (const v of await privacy.presenceVisible(socket.data.userId, wanted)) {
          socket.join(`presence:${v.id}`);
          if (v.time) socket.leave(`nolast:${v.id}`);
          else socket.join(`nolast:${v.id}`);
        }
      } catch (e) {
        errorLog.server(e, 'socket.presenceSubscribe');
      }
    });

    // Страница со списком идущих эфиров (витрина, /authors) просит сообщать
    // ей, когда состав эфиров меняется: кто-то вышел или ушёл. Открыто всем,
    // включая гостей, — витрина и так открыта без входа, а в комнату уходит
    // только «состав изменился», без единого названия и ключа.
    on('live:watch', () => socket.join(LIVE_ROOM));
    on('live:unwatch', () => socket.leave(LIVE_ROOM));

    // «Ты живой?» от вернувшейся вкладки (public/tk-app.js, wake). Телефон
    // замораживает страницу вместе с соединением, и браузер об этом не знает:
    // сокет числится подключённым, а на деле не доставит уже ничего. Само
    // соединение заметит разрыв только по таймауту пинга — до двадцати секунд
    // молчания, за которые человек успеет решить, что сайт не работает.
    on('tk:alive', (ack) => { if (typeof ack === 'function') ack(); });

    on('tk:away', (away) => {
      socket.data.away = away === true;
      if (socket.data.userId) updatePresence(socket.data.userId);
    });

    on('presence:unsubscribe', (ids) => {
      if (!Array.isArray(ids)) return;
      for (const id of ids.slice(0, PRESENCE_SUBSCRIBE_LIMIT)) {
        if (typeof id === 'string' && OBJECT_ID.test(id)) { socket.leave(`presence:${id}`); socket.leave(`nolast:${id}`); }
      }
    });

    let currentStreamKey = null;
    let currentVenue = null;

    // Страница камеры заведения. Комната у сокета одна, как и у эфира.
    on('venue:join', async (venueId, callback) => {
      const done = typeof callback === 'function' ? callback : () => {};
      if (typeof venueId !== 'string' || !OBJECT_ID.test(venueId)) return done({ error: 'Invalid venue' });
      let venue;
      try {
        venue = await Establishments.findById(venueId).select('owner status online').lean();
      } catch (e) {
        errorLog.server(e, 'socket.venueJoin');
        return done({ error: 'Server error' });
      }
      if (!venue) return done({ error: 'Unknown venue' });
      socket.data.venueOwn = socket.data.userId && String(venue.owner) === String(socket.data.userId) ? venueId : null;
      if (currentVenue && currentVenue !== venueId) {
        socket.leave(`venue:${currentVenue}`);
        announceVenue(currentVenue);
      }
      currentVenue = venueId;
      socket.join(`venue:${venueId}`);
      announceVenue(venueId);
      // Владельцу — просят ли камеру прямо сейчас (venue:demand). Всем —
      // включена ли она: события venue:state, пришедшие, пока сокета не
      // было (свёрнутый айфон, смена сети), страница пропустила, и без
      // этого пульт так и показывал «Ждём зрителей» у снятой сервером
      // камеры (правки 29.09). lapsed — сняли потому, что владелец пропал.
      done({
        success: true, count: venueCam.count(venueId), online: !!venue.online,
        demand: venueCam.wanted(venueId),
        ...(socket.data.venueOwn ? { lapsed: venueCam.wasLapsed(venueId) } : {}),
      });
    });

    // Плеер смотрит эфир запасным путём /lf/ (tk-viewer.js) — с нашего канала,
    // а не через Bunny. Только счёт для «Нагрузки» (utils/loadStats.js).
    on('stream:route', (route) => { socket.data.lf = route === 'fallback'; });

    // Вход в комнату эфира: чат, счётчик зрителей, смена типа эфира.
    // Ключ приходит от клиента — только строка формата ключа и только
    // существующего эфира: раньше годилась любая строка любой длины, и один
    // сокет вступал в тысячи мусорных комнат. Комната у сокета одна —
    // прежняя покидается.
    on('join-stream-room', async (streamKey, callback) => {
      const done = typeof callback === 'function' ? callback : () => {};
      if (typeof streamKey !== 'string' || !STREAM_KEY.test(streamKey)) {
        return done({ error: 'Invalid streamKey' });
      }
      let stream;
      try {
        stream = await Stream.findOne({ streamKey }).select('userId isAdult subscribersOnly slowMode streamKey').lean();
        if (!stream) return done({ error: 'Unknown stream' });
        // Те же ворота, что у чата по HTTP (streamChat.js, chatStream):
        // ограниченный автором и не подтвердивший 18+ читали чат сокетом.
        const me = socket.data.userId;
        if (String(stream.userId) !== String(me)) {
          if (me && await restriction.isRestricted(stream.userId, me)) return done({ error: 'Restricted' });
          if (stream.isAdult && !(me && await User.exists({ _id: me, adultConfirmedAt: { $ne: null } }))) return done({ error: 'Adult' });
          if (!(await restriction.canWatch(stream, me))) return done({ error: 'Subscribers' });
        }
        // Ключ эфира — ключ пользователя: вкладку ведущего узнаём по нему.
        socket.data.ownStreamKey = me && await User.exists({ _id: me, streamKey })
          ? streamKey : null;
      } catch (e) {
        errorLog.server(e, 'socket.joinStream');
        return done({ error: 'Server error' });
      }

      if (currentStreamKey && currentStreamKey !== streamKey) {
        socket.leave(`stream:${currentStreamKey}`);
        announceViewers(currentStreamKey);
      }
      currentStreamKey = streamKey;
      const roomName = `stream:${streamKey}`;
      socket.join(roomName);
      announceViewers(streamKey);
      // Большая комната — последнее разосланное число (не старше COUNT_MS):
      // пересчёт на каждый вход растёт с квадратом зрителей. Малую считаем
      // сразу, иначе первый зритель две секунды видел бы ноль.
      const count = io.sockets.adapter.rooms.get(roomName).size > 500
        ? ioHolder.count(streamKey) : viewersIn(roomName, streamKey);
      done({ success: true, count, slow: ioHolder.slowFor(stream) });
    });

    on('disconnect', async () => {
      // Сокет уже вышел из комнат — счётчик пересчитается без него.
      if (currentStreamKey) announceViewers(currentStreamKey);
      if (currentVenue) announceVenue(currentVenue);
      if (socket.data.venueOwn) venueCam.ownerLeft(socket.data.venueOwn);

      try {
        const userId = socket.data.userId;
        if (userId) {
          const set = userRooms.get(userId) || new Set();
          if (set.has(socket.id)) set.delete(socket.id);
          if (set.size === 0) userRooms.delete(userId); else userRooms.set(userId, set);

          // Звонки завершаем, только если человек не вернулся ни одной вкладкой.
          if (set.size === 0) {
            setTimeout(() => {
              if (!userRooms.has(userId)) finishCallsOf(userId);
            }, CALL_GRACE_MS).unref();
          }

          updatePresence(userId);
        }
      } catch (e) {
        errorLog.server(e, 'socket.disconnect');
      }

    });

    // Звонки. Каждое действие проверяет, кто его совершает: раньше принять,
    // отклонить или завершить чужой звонок мог любой сокет, знающий callId.

    // own — браузер принявшего помнит, что Daily у него не соединялся.
    // Хоть у одного из двоих так — звонок сразу идёт через свой сервер.
    onCall('call:accept', async ({ callId, own }) => {
      // Приглашение в идущий разговор: звонок уже активен, человек в нём
      // числится приглашённым (call:invite ниже).
      const running = activeCalls.get(callId);
      if (running && running.invited && running.invited.has(socket.data.userId)) return joinGroup(socket, callId, running);

      const call = pendingCalls.get(callId);
      if (!call || !(call.calleeId === socket.data.userId || (call.calleeIds && call.calleeIds.has(socket.data.userId)))) return;
      pendingCalls.delete(callId);
      if (call.calleeIds) return startChatCall(socket, callId, call);

      const ownPath = turn.configured() && (call.own || own === true);
      // В активные — до запроса к Daily, чтобы отмена или обрыв во время
      // создания комнаты нашли звонок и завершили его.
      const roomName = `call_${callId}`;
      const now = Date.now();
      const active = {
        ...call,
        engine: ownPath ? 'own' : 'daily',
        roomName: ownPath ? null : roomName,
        startedAt: now,
        // Звонящий вошёл первым — он и делает предложение соединения.
        members: new Map([[call.callerId, { joinedAt: now }], [call.calleeId, { joinedAt: now + 1 }]]),
        invited: new Map(),
      };
      activeCalls.set(callId, active);
      callLog.answered(callId, active.engine);

      // Остальные вкладки того, кому звонят, перестают звонить: разговор
      // идёт в той, где приняли. Иначе в комнату на двоих ломились бы все.
      socket.to(`user:${call.calleeId}`).emit('call:canceled', { callId });

      if (ownPath) return goOwn(callId, active, 'call:accepted');

      try {
        if (!daily.configured()) throw new Error('DAILY_API_KEY или DAILY_DOMAIN не заданы');
        await daily.createRoom(roomName, { max_participants: 2 });
        // Звонок кончился или ушёл на свой сервер, пока создавалась комната.
        if (!activeCalls.has(callId) || active.engine !== 'daily') {
          await daily.deleteRoom(roomName);
          return;
        }
        const url = daily.roomUrl(roomName);
        const [callerToken, calleeToken] = await Promise.all([
          daily.meetingToken({ room: roomName, userId: call.callerId, canSend: true }),
          daily.meetingToken({ room: roomName, userId: call.calleeId, canSend: true }),
        ]);
        io.to(`user:${call.callerId}`).emit('call:accepted', { callId, type: call.type, url, token: callerToken });
        socket.emit('call:accepted', { callId, type: call.type, url, token: calleeToken });
      } catch (e) {
        errorLog.external(e, 'daily.callRoom');
        finishCall(callId, 'call:failed');
      }
    });

    onCall('call:decline', ({ callId }) => {
      // Отказ от приглашения в идущий разговор: сам разговор продолжается,
      // пригласившему — только строка «не берёт трубку».
      const running = activeCalls.get(callId);
      if (running && running.invited && running.invited.has(socket.data.userId)) {
        const { by, quiet } = running.invited.get(socket.data.userId);
        running.invited.delete(socket.data.userId);
        // Отклонил сам — «вам звонили» ему незачем.
        if (running.missed) running.missed.delete(socket.data.userId);
        // Звонок группе: отказы участников звонящему не показываем — их
        // было бы по одному на каждого, кому звонило.
        if (!quiet) io.to(`user:${by}`).emit('call:invite:declined', { callId, userId: socket.data.userId });
        socket.to(`user:${socket.data.userId}`).emit('call:canceled', { callId });
        return;
      }

      // Звонок группе, никто ещё не ответил: отказался один — звонит
      // остальным; отказались все — звонящему «отклонено».
      const ringing = pendingCalls.get(callId);
      if (ringing && ringing.calleeIds && ringing.calleeIds.has(socket.data.userId)) {
        ringing.calleeIds.delete(socket.data.userId);
        ringing.missed.delete(socket.data.userId);
        socket.to(`user:${socket.data.userId}`).emit('call:canceled', { callId });
        if (!ringing.calleeIds.size) {
          pendingCalls.delete(callId);
          io.to(`user:${ringing.callerId}`).emit('call:declined', { callId });
          // Кто был не в сети, звонок пропустил и так.
          groupPush.missedCall(io, ringing);
        }
        return;
      }

      const call = pendingCalls.get(callId);
      if (!call || call.calleeId !== socket.data.userId) return;
      pendingCalls.delete(callId);
      callLog.ended(io, callId, 'declined');
      io.to(`user:${call.callerId}`).emit('call:declined', { callId });
      socket.to(`user:${call.calleeId}`).emit('call:canceled', { callId });
    });

    onCall('call:cancel', ({ callId }) => {
      const call = pendingCalls.get(callId);
      if (!call || call.callerId !== socket.data.userId) return;
      pendingCalls.delete(callId);
      callLog.ended(io, callId, 'canceled');
      io.to(call.calleeIds ? [...call.calleeIds].map((id) => `user:${id}`) : `user:${call.calleeId}`).emit('call:canceled', { callId });
      groupPush.missedCall(io, call);
    });

    // «Завершить» у себя: вдвоём это конец звонка, в группе — уход одного.
    onCall('call:end', ({ callId }) => {
      const userId = socket.data.userId;
      const active = activeCalls.get(callId);
      if (active && active.members.size > 2 && active.members.has(userId)) return leaveCall(callId, userId);
      if (isParty(pendingCalls.get(callId) || active, userId)) finishCall(callId);
    });

    // ── Групповой звонок ──
    // Позвать можно из идущего разговора, до четверых вместе с собой.
    // Приглашает любой участник, но приглашённый видит, кто уже говорит,
    // до того как взять трубку: «меня втащили к незнакомым» не бывает.
    //
    // Daily в группах не участвует: разговор сначала переходит на свой путь
    // (сетка на нашем TURN), и только потом входит третий.
    onCall('call:invite', async ({ callId, userId: guestId }) => {
      const me = socket.data.userId;
      const call = activeCalls.get(callId);
      if (!call || !call.members.has(me)) return;
      if (typeof guestId !== 'string' || !OBJECT_ID.test(guestId)) return;
      const no = (reason) => socket.emit('call:invite:failed', { callId, reason });
      if (!turn.configured()) return no('unavailable');
      if (call.members.has(guestId) || call.invited.has(guestId)) return;
      // Звонок группе держит приглашёнными всех, кому звонило (quiet), — они
      // места не занимают, пока не ответят.
      const asked = [...call.invited.values()].filter((v) => !v.quiet).length;
      if (call.members.size + asked >= GROUP_MAX) return no('full');

      // Ограничение доступа (utils/restrict.js) — с каждым, кто уже в
      // разговоре, и в обе стороны: затащить человека к тому, кто его
      // ограничил, нельзя.
      for (const id of call.members.keys()) {
        if (await restriction.between(id, guestId)) return no('restricted');
      }
      // Звонки гостя закрыты для приглашающего (utils/privacy.js).
      if (!(await privacy.decide('calls', guestId, me)).ok) return no('privacy');
      if (!activeCalls.has(callId) || !call.members.has(me)) return; // разговор кончился, пока спрашивали базу

      if (call.engine === 'daily') {
        const room = call.roomName;
        call.roomName = null;
        callLog.switched(callId, 'групповой звонок');
        goOwn(callId, call, 'call:switch');
        if (room) daily.deleteRoom(room).catch((e) => errorLog.external(e, 'daily.deleteRoom', { call: callId }));
      }

      call.invited.set(guestId, { by: me, at: Date.now() });
      const [from, ...inside] = await Promise.all([peerCard(me), ...[...call.members.keys()].map(peerCard)]);
      io.to(`user:${guestId}`).emit('incoming_call', { callId, type: call.type, group: true, from, peers: inside });
      socket.emit('call:invite:sent', { callId, userId: guestId });

      setTimeout(() => {
        const live = activeCalls.get(callId);
        if (!live || !live.invited.has(guestId)) return;
        live.invited.delete(guestId);
        io.to(`user:${guestId}`).emit('call:canceled', { callId });
        io.to(`user:${me}`).emit('call:invite:declined', { callId, userId: guestId, timeout: true });
      }, INVITE_MS).unref();
    });

    // Сокет вернулся посреди звонка (public/tk-app.js, connect). Всё, что
    // сервер слал в мёртвый сокет, пропало — «принят» и «переходим на свой
    // путь» тоже. 07.10 заказчик позвонил с телефона, у которого сокет уже
    // молчал: звонок создался запросом, Иван принял, а «принят» до звонящего
    // не дошёл — Иван ждал в пустой комнате, заказчик смотрел на «Звоним…».
    // Ответ — то же, что пришло бы событием, или ended: звонка больше нет.
    onCall('call:sync', async ({ callId }, ack) => {
      if (typeof ack !== 'function') return;
      const userId = socket.data.userId;
      if (isParty(pendingCalls.get(callId), userId)) return ack({ ringing: true });
      const call = activeCalls.get(callId);
      if (!isParty(call, userId)) return ack({ ended: true });
      if (call.engine === 'own') return ack({ callId, ...ownAccess(callId, call, userId) });
      try {
        const token = await daily.meetingToken({ room: call.roomName, userId, canSend: true });
        ack({ callId, type: call.type, url: daily.roomUrl(call.roomName), token });
      } catch (e) {
        errorLog.external(e, 'daily.callToken');
        ack({ error: 'token_failed' });
      }
    });

    // Повторный вход после обрыва: Daily выкинул участника, а звонок жив.
    // Токен выдаётся заново, только участнику и только пока звонок активен.
    onCall('call:token', async ({ callId }, ack) => {
      if (typeof ack !== 'function') return;
      const call = activeCalls.get(callId);
      const userId = socket.data.userId;
      if (!isParty(call, userId) || call.engine !== 'daily') return ack({ error: 'not_found' });
      try {
        const token = await daily.meetingToken({ room: call.roomName, userId, canSend: true });
        ack({ url: daily.roomUrl(call.roomName), token });
      } catch (e) {
        errorLog.external(e, 'daily.callToken');
        ack({ error: 'token_failed' });
      }
    });

    // Daily у одного из двоих не соединился (tk-daily.js, onStuck): оба
    // переходят на свой сервер. Повтор от второго участника не нужен —
    // звонок уже там. Без TURN переходить некуда: Daily пробует дальше.
    //
    // peer — от собеседника в комнате Daily не пришло ни звука, ни видео:
    // не работает Daily у него, а не у того, кто заметил. 07.10 так было
    // у заказчика (Россия, Android): запоминал свой путь айфон Ивана,
    // у которого Daily в порядке, а телефон заказчика — нет.
    onCall('call:fallback', ({ callId, reason, peer }) => {
      const call = activeCalls.get(callId);
      const userId = socket.data.userId;
      if (!isParty(call, userId) || call.engine !== 'daily' || !turn.configured()) return;
      const room = call.roomName;
      call.roomName = null;
      callLog.switched(callId, String(reason || '').slice(0, 200));
      const suspect = peer === true ? [...call.members.keys()].find((id) => id !== userId) : userId;
      goOwn(callId, call, 'call:switch', suspect);
      if (room) daily.deleteRoom(room).catch((e) => errorLog.external(e, 'daily.deleteRoom', { call: callId }));
    });

    // Сигналы своего пути — адресату как есть. Сервер их не разбирает:
    // проверяет только, что шлёт участник звонка, идущего этим путём, и что
    // адресат — тоже участник. В разговоре на двоих адресата можно не
    // называть: он один.
    onCall('call:signal', ({ callId, to, data }) => {
      const call = activeCalls.get(callId);
      const userId = socket.data.userId;
      if (!isParty(call, userId) || call.engine !== 'own' || !data || typeof data !== 'object') return;
      if (JSON.stringify(data).length > SIGNAL_MAX) return;
      let target = typeof to === 'string' && OBJECT_ID.test(to) ? to : null;
      if (!target && call.members.size === 2) {
        for (const id of call.members.keys()) if (id !== userId) target = id;
      }
      if (!target || !call.members.has(target)) return;
      io.to(`user:${target}`).emit('call:signal', { callId, from: userId, data });
    });
  });

  // ── Сэмплер зрителей ───────────────────────────────────────────────────────
  //
  // Счёт зрителей живёт только в памяти этого процесса и уходит в браузер
  // событием. В базу его не писал никто: Stream.viewers всегда оставался
  // нулём, хотя витрина и поиск по нему сортируют, а после эфира число
  // зрителей пропадало вместе с самим эфиром.
  //
  // Раз в полминуты снимаем счёт по всем идущим эфирам сразу: одна запись
  // в базу на все эфиры, а не на каждый вход и выход зрителя.
  const SAMPLE_MS = 30000;

  setInterval(() => {
    const samples = [];
    for (const room of io.sockets.adapter.rooms.keys()) {
      if (!room.startsWith('stream:')) continue;
      const streamKey = room.slice('stream:'.length);
      samples.push({ streamKey, viewers: viewersIn(room, streamKey) });
    }
    if (!samples.length) return;

    Stream.bulkWrite(
      samples.map(({ streamKey, viewers }) => ({
        updateOne: { filter: { streamKey, isActive: true }, update: { $set: { viewers } } },
      })),
      { ordered: false }
    ).catch((e) => errorLog.server(e, 'socket.viewers'));

    streamLog.sample(samples, SAMPLE_MS / 1000);
  }, SAMPLE_MS).unref();

  return { userRooms, pendingCalls, activeCalls };
}

module.exports = { registerSockets };
