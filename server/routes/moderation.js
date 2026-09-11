// routes/moderation.js
//
// Жалобы и действия по ним. Разбор идёт в /panel, а вот подача жалобы —
// маршрут для всех вошедших: кнопка «пожаловаться» живёт на странице эфира
// и в профиле пользователя.
const express = require('express');
const router = express.Router();

const Report = require('../models/Report');
const User = require('../models/User');
const Stream = require('../models/Stream');
const ChatMessage = require('../models/ChatMessage');
const { validate } = require('../middleware/validate');
const daily = require('../utils/daily');

// Разрыв идущего вещания. Подключается лениво и намеренно: require('../mediaServer')
// на верхнем уровне поднимает RTMP-сервер как побочный эффект, и тогда любой
// скрипт, которому нужен только этот роутер, начинал слушать 1935.
function dropPublisher(streamKey) {
    return require('../mediaServer').dropPublisher(streamKey);
}

// Веб-эфир идёт через комнату Daily, и медиасервер о нём не знает: без этого
// «стоп-эфир» веб-эфира снова был бы пометкой в базе. Удаление комнаты
// выгоняет из неё и вещателя, и зрителей.
function dropDailyRoom(roomName) {
    if (!roomName) return;
    daily.deleteRoom(roomName).catch(err => console.error('[moderation] daily', err.message));
}
const {
    requireAuthApi,
    requireModerator,
    requireAdmin,
    requireNotBanned,
    canModerate,
    wrap
} = require('../middleware/auth');

const REASONS = ['spam', 'abuse', 'adult', 'violence', 'copyright', 'other'];
const TARGETS = ['stream', 'user', 'message'];

// ── Подача жалобы ────────────────────────────────────────────────────────────
//
// Забаненному жаловаться нельзя: иначе бан обходится через заваливание панели.
router.post('/api/reports', requireAuthApi, requireNotBanned, validate({
    targetType: { type: 'string', required: true, values: TARGETS, label: 'Тип объекта' },
    targetId: { type: 'objectId', required: true, label: 'Объект' },
    reason: { type: 'string', required: true, values: REASONS, label: 'Причина' },
    comment: { type: 'string', required: false, max: 1000, label: 'Комментарий' }
}), wrap(async (req, res) => {
    const { targetType, targetId, reason, comment } = req.body;

    // На себя не жалуются: сначала отсекаем это, иначе в панель попадают
    // пустые жалобы, а уникальный индекс их даже не задержит.
    if (targetType === 'user' && targetId === req.session.userId.toString()) {
        return res.status(400).json({ message: 'Нельзя пожаловаться на себя' });
    }

    try {
        const report = await Report.create({
            reporter: req.session.userId,
            targetType,
            targetId,
            reason,
            comment: comment || ''
        });
        return res.status(201).json({ id: report._id });
    } catch (err) {
        // Уникальный индекс reporter+target: повтор — это не ошибка сервера,
        // а вторая жалоба того же человека на тот же объект.
        if (err && err.code === 11000) {
            return res.status(409).json({ message: 'Вы уже жаловались на это' });
        }
        throw err;
    }
}));

// ── Разбор: список ───────────────────────────────────────────────────────────
// validate() разбирает только тело запроса, а здесь фильтр приходит строкой
// запроса — поэтому статус сверяется со списком прямо тут.
const STATUSES = ['new', 'resolved', 'rejected'];

router.get('/api/moderation/reports', requireModerator, wrap(async (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : 'new';

    const reports = await Report.find({ status })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate('reporter', 'login email')
        .lean();

    // Цель жалобы лежит в разных коллекциях, поэтому populate тут не работает.
    // Добираем одним запросом на тип, а не по запросу на жалобу: сотня жалоб
    // на один эфир иначе означала бы сотню одинаковых чтений.
    const ids = { user: [], stream: [], message: [] };
    for (const r of reports) ids[r.targetType].push(r.targetId);

    const [users, streams, messages] = await Promise.all([
        ids.user.length ? User.find({ _id: { $in: ids.user } }).select('login email banned').lean() : [],
        ids.stream.length ? Stream.find({ _id: { $in: ids.stream } }).select('title isActive userId stoppedByModeration').lean() : [],
        ids.message.length ? ChatMessage.find({ _id: { $in: ids.message } }).select('message userId').lean() : []
    ]);

    const byId = new Map();
    for (const u of users) byId.set(u._id.toString(), { kind: 'user', title: u.login || u.email, banned: !!u.banned });
    for (const st of streams) byId.set(st._id.toString(), { kind: 'stream', title: st.title, isActive: !!st.isActive, ownerId: st.userId, stopped: !!st.stoppedByModeration });
    for (const msg of messages) byId.set(msg._id.toString(), { kind: 'message', title: msg.message, ownerId: msg.userId });

    for (const r of reports) {
        // Цели может уже не быть: эфир закончился, сообщение удалили.
        r.target = byId.get(r.targetId.toString()) || null;
    }

    return res.json({ reports });
}));

// ── Разбор: закрыть жалобу ───────────────────────────────────────────────────
router.post('/api/moderation/reports/:id/close', requireModerator, validate({
    status: { type: 'string', required: true, values: ['resolved', 'rejected'], label: 'Решение' },
    action: { type: 'string', required: false, max: 300, label: 'Что сделано' }
}), wrap(async (req, res) => {
    const report = await Report.findByIdAndUpdate(
        req.params.id,
        {
            status: req.body.status,
            action: req.body.action || '',
            resolvedBy: req.session.userId,
            resolvedAt: new Date()
        },
        { new: true }
    );

    if (!report) return res.status(404).json({ message: 'Жалоба не найдена' });
    return res.json({ ok: true });
}));

// ── Поиск людей ──────────────────────────────────────────────────────────────
//
// Модератору он нужен не меньше администратора: ограничить можно и того,
// на кого жалобы ещё не написали.
router.get('/api/moderation/users', requireModerator, wrap(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    // Экранируем ввод: строка идёт в регулярное выражение, и «(» без этого
    // роняет запрос ошибкой разбора, а не пустым результатом.
    const needle = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const filter = needle ? { $or: [{ login: needle }, { email: needle }] } : {};

    const users = await User.find(filter)
        .select('login email role banned banReason bannedAt')
        .sort({ banned: -1, login: 1 })
        .limit(50)
        .lean();

    return res.json({ users });
}));

// ── Смена роли ───────────────────────────────────────────────────────────────
router.post('/api/moderation/users/:id/role', requireAdmin, validate({
    role: { type: 'string', required: true, values: ['user', 'moderator', 'admin'], label: 'Роль' }
}), wrap(async (req, res) => {
    // Свою роль не меняем: единственный администратор, понизивший сам себя,
    // закрывает панель для всех, и вернуть её можно только через seed-admin.
    if (req.params.id === req.session.userId.toString()) {
        return res.status(400).json({ message: 'Свою роль менять нельзя' });
    }

    const updated = await User.findByIdAndUpdate(req.params.id, { role: req.body.role });
    if (!updated) return res.status(404).json({ message: 'Пользователь не найден' });

    return res.json({ ok: true });
}));

// ── Бан и снятие бана ────────────────────────────────────────────────────────
router.post('/api/moderation/users/:id/ban', requireModerator, validate({
    reason: { type: 'string', required: true, min: 3, max: 300, label: 'Причина' }
}), wrap(async (req, res) => {
    // Модератора и администратора банить нельзя: это единственный способ
    // не дать разобрать панель изнутри одним неверным нажатием.
    const target = await User.findById(req.params.id).select('role banned');
    if (!target) return res.status(404).json({ message: 'Пользователь не найден' });
    if (canModerate(target)) {
        return res.status(403).json({ message: 'Нельзя ограничить модератора' });
    }

    await User.findByIdAndUpdate(req.params.id, {
        banned: true,
        banReason: req.body.reason,
        bannedAt: new Date(),
        bannedBy: req.session.userId
    });

    // Ограничение запрещает начать вещание, но идущий эфир само по себе
    // не гасит: OBS уже подключён к 1935 и продолжает лить. Гасим явно —
    // и в базе, и на медиасервере.
    const live = await Stream.find({ userId: req.params.id, isActive: true })
        .select('streamKey dailyRoomName')
        .lean();

    if (live.length) {
        await Stream.updateMany(
            { userId: req.params.id, isActive: true },
            {
                isActive: false,
                stoppedByModeration: true,
                stopReason: req.body.reason,
                stoppedAt: new Date(),
                stoppedBy: req.session.userId,
                updatedAt: new Date()
            }
        );
        for (const s of live) {
            dropPublisher(s.streamKey);
            dropDailyRoom(s.dailyRoomName);
        }
    }

    return res.json({ ok: true, streamsStopped: live.length });
}));

router.post('/api/moderation/users/:id/unban', requireModerator, wrap(async (req, res) => {
    const updated = await User.findByIdAndUpdate(req.params.id, {
        banned: false,
        banReason: '',
        bannedAt: null,
        bannedBy: null
    });

    if (!updated) return res.status(404).json({ message: 'Пользователь не найден' });
    return res.json({ ok: true });
}));

// ── Стоп-эфир ────────────────────────────────────────────────────────────────
//
// Гасить может модератор и владелец эфира. Владельцу отдельный маршрут не нужен:
// проверка одна и та же, разводится по факту владения.
router.post('/api/moderation/streams/:id/stop', requireAuthApi, validate({
    reason: { type: 'string', required: false, max: 300, label: 'Причина' }
}), wrap(async (req, res) => {
    const stream = await Stream.findById(req.params.id);
    if (!stream) return res.status(404).json({ message: 'Эфир не найден' });

    const isOwner = stream.userId.toString() === req.session.userId.toString();
    if (!isOwner) {
        const me = await User.findById(req.session.userId).select('role');
        if (!canModerate(me)) {
            return res.status(403).json({ message: 'Нет прав остановить этот эфир' });
        }
    }

    stream.isActive = false;
    stream.updatedAt = new Date();
    // Флаг модерации ставится только чужим решением: владелец, погасивший
    // свой эфир, должен иметь возможность включить его снова.
    if (!isOwner) {
        stream.stoppedByModeration = true;
        stream.stopReason = req.body.reason || '';
        stream.stoppedAt = new Date();
        stream.stoppedBy = req.session.userId;
    }
    await stream.save();

    // Пометка в базе поток не останавливает: OBS продолжает лить, HLS писать
    // сегменты, зритель их получать. Рвём вещание на медиасервере.
    const wasLive = dropPublisher(stream.streamKey);
    dropDailyRoom(stream.dailyRoomName);

    return res.json({ ok: true, byModeration: !isOwner, wasLive });
}));

// ── Гейт 18+: самодекларация ─────────────────────────────────────────────────
//
// Спрашиваем один раз и запоминаем. Повторное подтверждение дату не сдвигает:
// важно, когда человек подтвердил впервые.
router.post('/api/age/confirm', requireAuthApi, wrap(async (req, res) => {
    await User.updateOne(
        { _id: req.session.userId, adultConfirmedAt: null },
        { adultConfirmedAt: new Date() }
    );
    return res.json({ ok: true });
}));

module.exports = router;
