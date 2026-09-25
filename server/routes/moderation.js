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
const Establishments = require('../models/Establishments');
const { validate } = require('../middleware/validate');
const daily = require('../utils/daily');
const { stopCamera } = require('./venueLive');
const ChatMessage = require('../models/ChatMessage');
const Recording = require('../models/Recording');
const GalleryVideo = require('../models/GalleryVideo');
const GalleryPhoto = require('../models/GalleryPhoto');
const RecordingComment = require('../models/RecordingComment');
const liveSignal = require('../utils/liveSignal');

// Где живёт цель жалобы каждого вида: жалоба на то, чего нет, — мусор в панели.
const TARGET_MODELS = {
    stream: Stream,
    user: User,
    message: ChatMessage,
    recording: Recording,
    video: GalleryVideo,
    photo: GalleryPhoto,
    comment: RecordingComment,
};

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
    daily.deleteRoom(roomName).catch((err) => errorLog.external(err, 'daily.deleteRoom', { roomName, by: 'moderation' }));
}
// Эфир погашен модерацией: зрителям — событие, чтобы плеер показал конец
// эфира, а не замер; витрине, /authors и левой панели — «не в эфире».
function announceStopped(req, stream) {
    const io = req.app.get('io');
    if (!io) return;
    io.to(`stream:${stream.streamKey}`).emit('stream:update', {
        streamKey: stream.streamKey,
        streamType: stream.streamType,
        streamProvider: stream.streamProvider,
        isActive: false,
    });
    liveSignal.changed(io, stream.userId, false);
}
const { audit, forget } = require('../utils/audit');
const streamLog = require('../utils/streamLog');
const errorLog = require('../utils/errorLog');
const {
    requireAuthApi,
    requireModerator,
    requireAdmin,
    requireNotBanned,
    canModerate,
    wrap
} = require('../middleware/auth');

// Кривой :id доходил до findById и падал 500 со строкой в журнале ошибок.
router.param('id', (req, res, next, id) => (
    /^[a-f\d]{24}$/i.test(id) ? next() : res.status(404).json({ message: 'Не найдено' })
));

const REASONS = ['spam', 'abuse', 'adult', 'violence', 'copyright', 'other'];
const TARGETS = ['stream', 'user', 'message', 'recording', 'video', 'photo', 'comment'];

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
    if (!(await TARGET_MODELS[targetType].exists({ _id: targetId }))) {
        return res.status(404).json({ message: 'Объект жалобы не найден' });
    }

    try {
        const report = await Report.create({
            reporter: req.session.userId,
            targetType,
            targetId,
            reason,
            comment: comment || ''
        });
        audit(req, 'report.create', { targetType, targetId, meta: { reason } });
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
        { returnDocument: 'after' }
    );

    if (!report) return res.status(404).json({ message: 'Жалоба не найдена' });

    audit(req, 'report.close', {
        targetType: 'report',
        target: report,
        targetLabel: report.reason,
        meta: { status: req.body.status, action: req.body.action || '', about: report.targetType },
    });
    return res.json({ ok: true });
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

    // Роль в подписи журнала кэшируется на пять минут — после её смены кэш
    // надо сбросить, иначе следующие записи подпишут человека прежней ролью.
    forget(req.params.id);
    // findByIdAndUpdate без new возвращает документ до правки — из него и
    // берётся прежняя роль.
    audit(req, 'mod.role', { targetType: 'user', target: updated, meta: { was: updated.role, now: req.body.role } });

    return res.json({ ok: true });
}));

// ── Бан и снятие бана ────────────────────────────────────────────────────────
router.post('/api/moderation/users/:id/ban', requireModerator, validate({
    reason: { type: 'string', required: true, min: 3, max: 300, label: 'Причина' }
}), wrap(async (req, res) => {
    // Модератора и администратора банить нельзя: это единственный способ
    // не дать разобрать панель изнутри одним неверным нажатием.
    const target = await User.findById(req.params.id).select('role banned nickname login email');
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
        .select('userId streamKey streamType streamProvider dailyRoomName')
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
            await streamLog.close(s.streamKey, { endedBy: 'moderation', reason: req.body.reason, by: req.session.userId });
            announceStopped(req, s);
        }
    }

    // Камера заведения — тоже вещание: без этого гости смотрели бы её
    // и после бана владельца.
    const venues = await Establishments.find({ owner: req.params.id, online: true }).select('_id').lean();
    await Promise.all(venues.map((v) => stopCamera(v._id)));

    audit(req, 'mod.ban', {
        targetType: 'user',
        target,
        targetLabel: target.nickname || target.login || target.email || '',
        meta: { reason: req.body.reason, streamsStopped: live.length, venuesStopped: venues.length },
    });
    return res.json({ ok: true, streamsStopped: live.length, venuesStopped: venues.length });
}));

router.post('/api/moderation/users/:id/unban', requireModerator, wrap(async (req, res) => {
    const updated = await User.findByIdAndUpdate(req.params.id, {
        banned: false,
        banReason: '',
        bannedAt: null,
        bannedBy: null
    });

    if (!updated) return res.status(404).json({ message: 'Пользователь не найден' });

    // updated — документ до снятия ограничения, поэтому в нём ещё видна причина.
    audit(req, 'mod.unban', { targetType: 'user', target: updated, meta: { was: updated.banReason || '' } });
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
    announceStopped(req, stream);

    // Отрезок эфира закрывается в обоих случаях, но с разной причиной:
    // в журнале должно быть видно, сам ведущий ушёл или его погасили.
    await streamLog.close(stream.streamKey, {
        endedBy: isOwner ? 'owner' : 'moderation',
        reason: isOwner ? '' : (req.body.reason || ''),
        by: isOwner ? null : req.session.userId,
        streamId: stream._id,
    });
    audit(req, isOwner ? 'stream.pause' : 'mod.stream.stop', {
        targetType: 'stream',
        target: stream,
        meta: { reason: req.body.reason || '', wasLive },
    });

    return res.json({ ok: true, byModeration: !isOwner, wasLive });
}));

// ── Гейт 18+: самодекларация ─────────────────────────────────────────────────
//
// Спрашиваем один раз и запоминаем. Повторное подтверждение дату не сдвигает:
// важно, когда человек подтвердил впервые.
router.post('/api/age/confirm', requireAuthApi, wrap(async (req, res) => {
    const done = await User.updateOne(
        { _id: req.session.userId, adultConfirmedAt: null },
        { adultConfirmedAt: new Date() }
    );
    // Только первое подтверждение: повтор даты не сдвигает и записи не стоит.
    if (done.modifiedCount) audit(req, 'age.confirm');
    return res.json({ ok: true });
}));

module.exports = router;
