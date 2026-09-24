// Socket.IO: присутствие, комнаты эфиров, звонки, доставка сообщений.
//
// Состояние держится в памяти процесса, поэтому pm2 запускает приложение
// в одном экземпляре (ops/ecosystem.config.js). Второй процесс не увидит ни
// счётчика зрителей, ни звонков — для этого нужен Redis-адаптер, он в списке
// работ за рамками текущего объёма.

const User = require('../models/User');
const Message = require('../models/Message');
const Stream = require('../models/Stream');
const streamLog = require('../utils/streamLog');
const daily = require('../utils/daily');
const callLog = require('../utils/callLog');
const errorLog = require('../utils/errorLog');
const turn = require('../utils/turn');
const userView = require('../utils/userView');
const restriction = require('../utils/restrict');
const privacy = require('../utils/privacy');
const { LIVE_ROOM } = require('../utils/liveSignal');

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

// Возвращает общие хранилища, чтобы app.js положил их в app.set(...):
// маршрут /api/calls/create достаёт их оттуда.
function registerSockets(io) {
  const userConnections = new Map(); // userId -> count
  const userRooms = new Map(); // userId -> Set(socketIds)
  const pendingCalls = new Map(); // callId -> {callerId, calleeId, type, createdAt}
  // callId -> {callerId, calleeId, type, engine: 'daily'|'own', roomName,
  //            startedAt, members: Map(userId -> {joinedAt}),
  //            invited: Map(userId -> время приглашения)}
  const activeCalls = new Map();
  const offlineTimers = new Map(); // userId -> таймер отсрочки офлайна
  const presenceWrites = new Map(); // userId -> последняя запись присутствия в очереди

  // Присутствие в базу — по очереди на человека и всегда то, что есть в эту
  // секунду, а не то, что было, когда запись ставили в очередь. Две записи
  // одного человека по разным соединениям пула приходят в базу в любом
  // порядке; очередь и чтение состояния в момент записи это исключают.
  function syncPresence(userId) {
    const prev = presenceWrites.get(userId) || Promise.resolve();
    const next = prev.then(async () => {
      const isOnline = userConnections.has(userId) || offlineTimers.has(userId);
      const set = isOnline ? { isOnline } : { isOnline, lastSeen: new Date() };
      const before = await User.findOneAndUpdate({ _id: userId }, { $set: set }, { projection: { isOnline: 1 } }).lean();
      if (before && !!before.isOnline === isOnline) return; // ничего не поменялось — и звать некого
      io.to(`presence:${userId}`).emit('presence:update', { userId, isOnline, lastSeen: set.lastSeen });
    }).catch((e) => errorLog.server(e, 'socket.presence'));
    presenceWrites.set(userId, next);
    next.then(() => { if (presenceWrites.get(userId) === next) presenceWrites.delete(userId); });
  }

  // После перезапуска в базе остаются «в сети» те, кто был подключён к прошлому
  // процессу. Кто жив — переподключится за секунды и вернёт себе отметку.
  User.updateMany({ isOnline: true }, { $set: { isOnline: false, lastSeen: new Date() } })
    .then(() => { for (const userId of userConnections.keys()) syncPresence(userId); })
    .catch((e) => errorLog.server(e, 'socket.presenceReset'));

  // Зрители эфира — люди в его комнате, а не сокеты: вошедший считается
  // один раз, сколько бы вкладок ни открыл; вкладки самого ведущего не
  // считаются вовсе. Гостя узнать не по чему, кроме адреса, — с одного
  // адреса считаем не больше GUESTS_PER_ADDRESS: сотня сокетов из скрипта
  // больше не поднимает эфир на витрине (сортировка по viewers), а бар
  // с десятком телефонов за одним роутером всё ещё считается.
  const GUESTS_PER_ADDRESS = 10;
  function viewersIn(roomName, streamKey) {
    const room = io.sockets.adapter.rooms.get(roomName);
    if (!room) return 0;
    const users = new Set();
    const guests = new Map();
    for (const id of room) {
      const s = io.sockets.sockets.get(id);
      if (!s || s.data.ownStreamKey === streamKey) continue;
      if (s.data.userId) users.add(s.data.userId);
      else guests.set(s.data.ip, Math.min((guests.get(s.data.ip) || 0) + 1, GUESTS_PER_ADDRESS));
    }
    let n = users.size;
    for (const k of guests.values()) n += k;
    return n;
  }

  // Счётчик уходит всей комнате, и слать его на каждый вход и выход нельзя:
  // тысяча входов на эфир с тысячей зрителей — миллион сообщений. Не чаще
  // раза в COUNT_MS на комнату, с последним числом.
  const COUNT_MS = 2000;
  const countTimers = new Map();
  function announceViewers(streamKey) {
    if (countTimers.has(streamKey)) return;
    countTimers.set(streamKey, setTimeout(() => {
      countTimers.delete(streamKey);
      const roomName = `stream:${streamKey}`;
      io.to(roomName).emit('viewers-count-updated', { streamKey, count: viewersIn(roomName, streamKey) });
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
  function ownAccess(call, userId) {
    const mine = call.members.get(userId);
    const peers = [];
    for (const [id, m] of call.members) {
      if (id === userId) continue;
      peers.push({ userId: id, offerer: m.joinedAt > mine.joinedAt });
    }
    return { type: call.type, engine: 'own', group: call.members.size > 2, ice: turn.iceServers(userId), peers };
  }

  function goOwn(callId, call, event) {
    call.engine = 'own';
    for (const userId of call.members.keys()) {
      io.to(`user:${userId}`).emit(event, { callId, ...ownAccess(call, userId) });
    }
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
    // Места кончились, пока звонило (звонок группе зовёт всех, кто в сети).
    if (call.members.size >= GROUP_MAX) return socket.emit('call:full', { callId });
    call.members.set(userId, { joinedAt: Date.now() });
    callLog.joined(callId, userId);

    const cards = new Map();
    for (const id of call.members.keys()) cards.set(id, await peerCard(id));
    if (!activeCalls.has(callId)) return; // разговор кончился, пока собирали карточки

    // Новичку — весь состав разом, остальным — только он.
    socket.emit('call:accepted', {
      callId,
      ...ownAccess(call, userId),
      cards: [...cards.values()].filter((c) => c.userId !== userId),
    });
    // roster — весь состав: у двоих, что говорили до этого, имени друг
    // друга на плитке иначе не взять, они знали его только из окна звонка.
    const roster = [...cards.values()];
    for (const id of call.members.keys()) {
      if (id === userId) continue;
      io.to(`user:${id}`).emit('call:peer:join', {
        callId, peer: cards.get(userId), roster, offerer: true, ice: turn.iceServers(id),
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
    const active = {
      callerId: call.callerId, calleeId: me, type: call.type, groupId: call.groupId,
      engine: 'own', roomName: null, startedAt: now,
      members: new Map([[call.callerId, { joinedAt: now }], [me, { joinedAt: now + 1 }]]),
      invited,
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

    // Presence connect (только для аутентифицированных)
    try {
      const userId = socket.data.userId;
      if (userId) {
        socket.join(`user:${userId}`);
        const set = userRooms.get(userId) || new Set();
        set.add(socket.id);
        userRooms.set(userId, set);
        const count = (userConnections.get(userId) || 0) + 1;
        userConnections.set(userId, count);
        if (count === 1) {
          // Вернулся в пределах отсрочки (обычный переход по ссылке) — для всех
          // он и не уходил: ни записи, ни события.
          if (offlineTimers.has(userId)) {
            clearTimeout(offlineTimers.get(userId));
            offlineTimers.delete(userId);
          } else {
            // Без await: обработчики ниже обязаны встать в момент подключения.
            syncPresence(userId);
          }
          markDelivered(userId).catch((e) => errorLog.server(e, 'socket.delivered'));
        }
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
    socket.on('presence:subscribe', async (ids) => {
      if (!Array.isArray(ids)) return;
      // Потолок на всякий случай: список приходит от клиента, а комнаты стоят памяти.
      const wanted = ids.slice(0, PRESENCE_SUBSCRIBE_LIMIT).filter((id) => typeof id === 'string' && OBJECT_ID.test(id));
      if (!wanted.length) return;
      try {
        for (const id of await privacy.presenceVisible(socket.data.userId, wanted)) socket.join(`presence:${id}`);
      } catch (e) {
        errorLog.server(e, 'socket.presenceSubscribe');
      }
    });

    // Страница со списком идущих эфиров (витрина, /authors) просит сообщать
    // ей, когда состав эфиров меняется: кто-то вышел или ушёл. Открыто всем,
    // включая гостей, — витрина и так открыта без входа, а в комнату уходит
    // только «состав изменился», без единого названия и ключа.
    socket.on('live:watch', () => socket.join(LIVE_ROOM));
    socket.on('live:unwatch', () => socket.leave(LIVE_ROOM));

    // «Ты живой?» от вернувшейся вкладки (public/tk-app.js, wake). Телефон
    // замораживает страницу вместе с соединением, и браузер об этом не знает:
    // сокет числится подключённым, а на деле не доставит уже ничего. Само
    // соединение заметит разрыв только по таймауту пинга — до двадцати секунд
    // молчания, за которые человек успеет решить, что сайт не работает.
    socket.on('tk:alive', (ack) => { if (typeof ack === 'function') ack(); });

    socket.on('presence:unsubscribe', (ids) => {
      if (!Array.isArray(ids)) return;
      for (const id of ids.slice(0, PRESENCE_SUBSCRIBE_LIMIT)) {
        if (typeof id === 'string' && OBJECT_ID.test(id)) socket.leave(`presence:${id}`);
      }
    });

    let currentStreamKey = null;

    // Вход в комнату эфира: чат, счётчик зрителей, смена типа эфира.
    // Ключ приходит от клиента — только строка формата ключа и только
    // существующего эфира: раньше годилась любая строка любой длины, и один
    // сокет вступал в тысячи мусорных комнат. Комната у сокета одна —
    // прежняя покидается.
    socket.on('join-stream-room', async (streamKey, callback) => {
      const done = typeof callback === 'function' ? callback : () => {};
      if (typeof streamKey !== 'string' || !STREAM_KEY.test(streamKey)) {
        return done({ error: 'Invalid streamKey' });
      }
      try {
        if (!(await Stream.exists({ streamKey }))) return done({ error: 'Unknown stream' });
        // Ключ эфира — ключ пользователя: вкладку ведущего узнаём по нему.
        socket.data.ownStreamKey = socket.data.userId && await User.exists({ _id: socket.data.userId, streamKey })
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
      done({ success: true, count: viewersIn(roomName, streamKey) });
    });

    socket.on('disconnect', async () => {
      // Сокет уже вышел из комнат — счётчик пересчитается без него.
      if (currentStreamKey) announceViewers(currentStreamKey);

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

          const cur = (userConnections.get(userId) || 1) - 1;
          if (cur <= 0) {
            userConnections.delete(userId);
            clearTimeout(offlineTimers.get(userId));
            offlineTimers.set(userId, setTimeout(() => {
              offlineTimers.delete(userId);
              if (!userConnections.has(userId)) syncPresence(userId);
            }, PRESENCE_GRACE_MS).unref());
          } else {
            userConnections.set(userId, cur);
          }
        }
      } catch (e) {
        errorLog.server(e, 'socket.disconnect');
      }

    });

    // Звонки. Каждое действие проверяет, кто его совершает: раньше принять,
    // отклонить или завершить чужой звонок мог любой сокет, знающий callId.

    // own — браузер принявшего помнит, что Daily у него не соединялся.
    // Хоть у одного из двоих так — звонок сразу идёт через свой сервер.
    socket.on('call:accept', async ({ callId, own } = {}) => {
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

    socket.on('call:decline', ({ callId } = {}) => {
      // Отказ от приглашения в идущий разговор: сам разговор продолжается,
      // пригласившему — только строка «не берёт трубку».
      const running = activeCalls.get(callId);
      if (running && running.invited && running.invited.has(socket.data.userId)) {
        const { by, quiet } = running.invited.get(socket.data.userId);
        running.invited.delete(socket.data.userId);
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
        socket.to(`user:${socket.data.userId}`).emit('call:canceled', { callId });
        if (!ringing.calleeIds.size) {
          pendingCalls.delete(callId);
          io.to(`user:${ringing.callerId}`).emit('call:declined', { callId });
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

    socket.on('call:cancel', ({ callId } = {}) => {
      const call = pendingCalls.get(callId);
      if (!call || call.callerId !== socket.data.userId) return;
      pendingCalls.delete(callId);
      callLog.ended(io, callId, 'canceled');
      io.to(call.calleeIds ? [...call.calleeIds].map((id) => `user:${id}`) : `user:${call.calleeId}`).emit('call:canceled', { callId });
    });

    // «Завершить» у себя: вдвоём это конец звонка, в группе — уход одного.
    socket.on('call:end', ({ callId } = {}) => {
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
    socket.on('call:invite', async ({ callId, userId: guestId } = {}) => {
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

    // Повторный вход после обрыва: Daily выкинул участника, а звонок жив.
    // Токен выдаётся заново, только участнику и только пока звонок активен.
    socket.on('call:token', async ({ callId } = {}, ack) => {
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
    socket.on('call:fallback', ({ callId, reason } = {}) => {
      const call = activeCalls.get(callId);
      if (!isParty(call, socket.data.userId) || call.engine !== 'daily' || !turn.configured()) return;
      const room = call.roomName;
      call.roomName = null;
      callLog.switched(callId, String(reason || '').slice(0, 200));
      goOwn(callId, call, 'call:switch');
      if (room) daily.deleteRoom(room).catch((e) => errorLog.external(e, 'daily.deleteRoom', { call: callId }));
    });

    // Сигналы своего пути — адресату как есть. Сервер их не разбирает:
    // проверяет только, что шлёт участник звонка, идущего этим путём, и что
    // адресат — тоже участник. В разговоре на двоих адресата можно не
    // называть: он один.
    socket.on('call:signal', ({ callId, to, data } = {}) => {
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

  return { userConnections, userRooms, pendingCalls, activeCalls };
}

module.exports = { registerSockets };
