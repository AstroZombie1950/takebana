// Daily для веб-эфира: комната под эфир и токены входа в неё.
// Запросы к Daily и подпись токенов — в utils/daily.js.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { requireAuth, requireOwner, requireNotBanned } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const daily = require('../utils/daily');
const Stream = require('../models/Stream');
const User = require('../models/User');

// Потолок задаёт тариф Daily, а не мы: на текущем плане запрос комнаты больше
// чем на 20 участников отбивается с 'cannot be set to that value with your
// current plan', и комната не создаётся вовсе. Держим значение в окружении,
// чтобы смена тарифа была правкой .env, а не кода.
const DAILY_MAX_PARTICIPANTS = Number(process.env.DAILY_MAX_PARTICIPANTS) || 20;

const OBJECT_ID = /^[a-f\d]{24}$/i;
const streamIdSchema = { streamId: { type: 'objectId', required: true, label: 'Эфир' } };

// requireOwner ищет эфир по :streamId, и кривой идентификатор ронял бы
// findById в 500 вместо ответа «не найден».
router.param('streamId', (req, res, next, id) => (
    OBJECT_ID.test(id) ? next() : res.status(404).json({ success: false, message: 'Эфир не найден' })
));

// Подробности — в лог: ни тело ответа Daily, ни текст исключения наружу не уходят.
function dailyFailure(res, err) {
    console.error('[daily]', err.message);
    const message = err.status === 429
        ? 'Сервис видео перегружен запросами, попробуйте через несколько секунд'
        : 'Сервис видео недоступен, попробуйте позже';
    res.status(502).json({ success: false, message });
}

// Комната под эфир. Каждый запуск — новая комната, прежняя удаляется: у неё
// мог выйти срок, и в ней могли остаться подключения прошлого запуска.
// requireOwner берёт streamId из тела и пускает только владельца: комнаты
// платные. validate стоит до него — иначе в findOne уходил объект из JSON,
// то есть оператор Mongo. Токен вещателя приходит тем же ответом.
router.post('/create-room', requireAuth, requireNotBanned, validate(streamIdSchema),
    requireOwner(Stream, { param: 'streamId', field: 'userId' }), async (req, res) => {
    const stream = await Stream.findById(req.body.streamId)
        .select('streamKey isActive stoppedByModeration dailyRoomName').lean();
    if (!stream) return res.status(404).json({ success: false, message: 'Эфир не найден' });
    if (stream.stoppedByModeration) {
        return res.status(403).json({ success: false, message: 'Эфир остановлен модерацией' });
    }

    let room, token;
    try {
        if (stream.dailyRoomName) await daily.deleteRoom(stream.dailyRoomName);
        room = await daily.createRoom(`stream_${stream._id}_${Date.now()}`, {
            max_participants: DAILY_MAX_PARTICIPANTS,
        });
        token = await daily.meetingToken({
            room: room.name, userId: req.session.userId, owner: true, canSend: true,
        });
    } catch (err) {
        return dailyFailure(res, err);
    }

    await Stream.updateOne({ _id: stream._id }, {
        $set: {
            dailyRoomName: room.name,
            dailyRoom: { name: room.name, url: room.url },
            streamProvider: 'web-stream',
            streamType: 'daily-stream',
        },
    });

    // Зрители переподключаются к новой комнате по этому событию.
    const io = req.app.get('io');
    if (io && stream.streamKey) {
        io.to(`stream:${stream.streamKey}`).emit('stream:update', {
            streamKey: stream.streamKey,
            streamType: 'daily-stream',
            streamProvider: 'web-stream',
            isActive: !!stream.isActive,
            dailyRoomName: room.name,
        });
    }

    res.json({ success: true, url: room.url, token });
});

// Токен входа в комнату эфира. Роль выводится из базы, а не из запроса:
// раньше роль приходила в теле, и любой вошедший просил 'streamer'. Имя
// комнаты клиент не называет — сервер берёт текущую комнату эфира, так что
// токен в чужую или посторонюю комнату не выписать.
// Зритель только смотрит, и в списке участников его нет (hp: false): сотне
// зрителей незачем рассылать друг другу события о входе и выходе.
router.post('/get-token', requireAuth, validate(streamIdSchema), async (req, res) => {
    const stream = await Stream.findById(req.body.streamId)
        .select('userId isActive isAdult stoppedByModeration dailyRoomName').lean();
    if (!stream || !stream.dailyRoomName) {
        return res.status(404).json({ success: false, message: 'Комната эфира не найдена' });
    }

    const userId = String(req.session.userId);
    const isOwner = String(stream.userId) === userId;
    if (!isOwner) {
        if (!stream.isActive || stream.stoppedByModeration) {
            return res.status(409).json({ success: false, message: 'Эфир не идёт' });
        }
        // Гейт 18+ стоит на странице, но токен — отдельная дверь в ту же комнату.
        if (stream.isAdult) {
            const user = await User.findById(userId).select('adultConfirmedAt').lean();
            if (!user || !user.adultConfirmedAt) {
                return res.status(403).json({ success: false, message: 'Нужно подтвердить возраст' });
            }
        }
    }

    try {
        const token = await daily.meetingToken(isOwner
            ? { room: stream.dailyRoomName, userId, owner: true, canSend: true }
            : { room: stream.dailyRoomName, userId, presence: false });
        res.json({ success: true, url: daily.roomUrl(stream.dailyRoomName), token });
    } catch (err) {
        dailyFailure(res, err);
    }
});

// Удаление комнаты выгоняет из неё всех: и вещателя, и зрителей.
router.delete('/delete-room/:streamId', requireAuth,
    requireOwner(Stream, { param: 'streamId', field: 'userId' }), async (req, res) => {
    const stream = await Stream.findById(req.params.streamId).select('dailyRoomName').lean();
    if (stream && stream.dailyRoomName) {
        try {
            await daily.deleteRoom(stream.dailyRoomName);
        } catch (err) {
            return dailyFailure(res, err);
        }
    }
    // Раньше очищалось только dailyRoomName, а dailyRoom.name оставался,
    // и поиск по любому из двух полей находил удалённую комнату.
    await Stream.updateOne({ _id: req.params.streamId }, {
        $set: { dailyRoomName: null }, $unset: { dailyRoom: 1 },
    });
    res.json({ success: true });
});

module.exports = router;
