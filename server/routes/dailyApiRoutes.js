const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router);
const { requireAuth, requireOwner } = require('../middleware/auth'); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { validate } = require('../middleware/validate');

const axios = require('axios');
const jwt = require('jsonwebtoken'); // Добавляем для создания JWT токенов

// Daily.co API конфигурация
const DAILY_API_KEY = process.env.DAILY_API_KEY;
// Важно: домен Daily (subdomain) должен совпадать с доменом вашего аккаунта в Daily.
// Для безопасной миграции бренда НЕ хардкодим takebana.
const DAILY_DOMAIN = process.env.DAILY_DOMAIN || 'webcatravel';
// Потолок задаёт тариф Daily, а не мы: на текущем плане запрос комнаты больше
// чем на 20 участников отбивается с 'cannot be set to that value with your
// current plan', и комната не создаётся вовсе. Держим значение в окружении,
// чтобы смена тарифа была правкой .env, а не кода.
const DAILY_MAX_PARTICIPANTS = Number(process.env.DAILY_MAX_PARTICIPANTS) || 20;

// Базовые настройки для запросов к Daily.co API
const DAILY_API_BASE = 'https://api.daily.co/v1';
const dailyHeaders = {
    'Authorization': `Bearer ${DAILY_API_KEY}`,
    'Content-Type': 'application/json'
};

const Stream = require('../models/Stream');

// Создание комнаты.
// requireOwner берёт streamId из тела (см. middleware/auth.js) и пускает только
// владельца эфира: комнаты Daily платные, а раньше любой вошедший мог создать
// комнату под чужой streamId и заодно перезаписать в нём dailyRoom.
// validate стоит до requireOwner: тот ищет эфир по streamId из тела, и без
// проверки типа туда уходил объект из JSON — то есть оператор Mongo в findOne.
router.post('/create-room', requireAuth, validate({
    streamId: { type: 'objectId', required: true, label: 'Эфир' },
}), requireOwner(Stream, { param: 'streamId', field: 'userId' }), async (req, res) => {
    try {
        console.log('🏠 Создание новой комнаты Daily.co...');
        
        const { streamId } = req.body; // ID существующего стрима
        
        // Проверяем существование стрима
        const stream = await Stream.findById(streamId);
        if (!stream) {
            return res.status(404).json({
                success: false,
                message: 'Stream not found'
            });
        }
        
        // Проверяем, нет ли уже комнаты для этого стрима
        if (stream.dailyRoom && stream.dailyRoom.name) {
            console.log('⚠️ Комната уже существует для стрима:', streamId, 'Имя:', stream.dailyRoom.name);
            
            // Проверяем, активна ли эта комната в Daily.co
            try {
                const roomCheckResponse = await axios.get(`${DAILY_API_BASE}/rooms/${stream.dailyRoom.name}`, {
                    headers: dailyHeaders
                });
                
                if (roomCheckResponse.status === 200) {
                    // Комната существует, возвращаем её
                    console.log('✅ Используем существующую комнату:', stream.dailyRoom.name);
                    return res.json({
                        success: true,
                        room: {
                            name: stream.dailyRoom.name,
                            // url важен: фронт должен join'иться по реальному URL комнаты
                            url: stream.dailyRoom.url || `https://${DAILY_DOMAIN}.daily.co/${stream.dailyRoom.name}`
                        }
                    });
                }
            } catch (roomCheckError) {
                // Комната не существует в Daily.co, очищаем данные
                console.log('🧹 Комната не найдена в Daily.co, создаём новую');
            }
        }
        
        // Генерируем уникальное имя комнаты
        const roomName = `stream_${streamId}_${Date.now()}`;
        
        const roomConfig = {
            name: roomName,
            privacy: 'public',
            properties: {
                max_participants: DAILY_MAX_PARTICIPANTS,
                enable_chat: false,
                enable_knocking: false,
                enable_screenshare: false,
                enable_recording: false,
                start_video_off: false,
                start_audio_off: false,
                owner_only_broadcast: true, // Только владелец может вещать
                eject_after_elapsed: 7200, // 2 часа
                exp: Math.round(Date.now() / 1000) + (2 * 60 * 60) // Комната истекает через 2 часа
            }
        };
        
        const response = await axios.post(`${DAILY_API_BASE}/rooms`, roomConfig, {
            headers: dailyHeaders
        });
        
        const roomData = response.data;
        console.log('✅ Комната создана:', roomData.name);
        
        // Сохраняем данные комнаты в стрим
        const updatedStream = await Stream.findByIdAndUpdate(streamId, {
            dailyRoomName: roomData.name,
            streamProvider: 'web-stream',
            streamType: 'daily-stream',  // Устанавливаем тип для Daily.co стримов
            dailyRoom: {
                name: roomData.name,
                url: roomData.url
            }
        }, { new: true });
        
        console.log('✅ Данные комнаты сохранены в стрим:', streamId);

        // notify viewers to reload/reconnect (room may have changed)
        try {
            const io = req.app && req.app.get ? req.app.get('io') : null;
            if (io && updatedStream && updatedStream.streamKey) {
                io.to(`stream:${updatedStream.streamKey}`).emit('stream:update', {
                    streamKey: updatedStream.streamKey,
                    streamType: 'daily-stream',
                    streamProvider: 'web-stream',
                    isActive: !!updatedStream.isActive,
                    dailyRoomName: roomData.name
                });
            }
        } catch (_) {}
        
        res.json({
            success: true,
            room: {
                name: roomData.name,
                url: roomData.url
            }
        });
        
    } catch (error) {
        console.error('❌ Ошибка создания комнаты:', error.response?.data || error.message);
        
        // Обработка специфических ошибок Daily.co
        let errorMessage = 'Ошибка создания комнаты для стрима';
        
        if (error.response?.data?.error === 'invalid-request-error' && 
            error.response?.data?.info?.includes('duplicate')) {
            errorMessage = 'Комната с таким именем уже существует. Попробуйте обновить страницу.';
        } else if (error.response?.status === 429) {
            errorMessage = 'Превышен лимит запросов. Попробуйте через несколько секунд.';
        } else if (error.response?.status === 401) {
            errorMessage = 'Ошибка авторизации сервиса стримов. Обратитесь к администратору.';
        }
        
        res.status(500).json({
            success: false,
            message: errorMessage
        });
    }
});

// Получение токена для участника (self-signed JWT)
// Имя комнаты создаётся здесь же как `stream_<id>_<время>` — набор символов
// ограничен теми же, что и в ключах: имя уходит в путь запроса к Daily.
router.post('/get-token', requireAuth, validate({
    roomName: { type: 'key', required: true, label: 'Комната' },
}), async (req, res) => {
    try {
        const { roomName } = req.body;

        // Роль раньше приходила из тела запроса: любой вошедший просил
        // role: 'streamer' и получал токен владельца комнаты (o: true).
        // При owner_only_broadcast это право вещать в чужом эфире.
        // Теперь роль выводится из базы: владелец комнаты — владелец стрима.
        // create-room пишет имя в оба поля; dailyRoomName проиндексировано
        const stream = await Stream.findOne({
            $or: [{ dailyRoomName: roomName }, { 'dailyRoom.name': roomName }]
        }).select('userId').lean();
        const isOwner = Boolean(
            stream && stream.userId && stream.userId.toString() === String(req.session.userId)
        );
        const role = isOwner ? 'streamer' : 'viewer';

        console.log('🎫 Создание self-signed JWT токена для комнаты:', roomName, 'роль:', role);
        
        // Получаем domain_id (нужен для self-signed токенов)
        const domainResponse = await fetch(`${DAILY_API_BASE}/`, {
            headers: dailyHeaders
        });
        
        if (!domainResponse.ok) {
            throw new Error('Failed to get domain info');
        }
        
        const domainData = await domainResponse.json();
        const domainId = domainData.domain_id;
        
        console.log('🏠 Domain ID:', domainId);
        
        // Создаем payload для JWT токена с сокращенными названиями (для self-signed)
        const payload = {
            r: roomName,           // room_name
            o: role === 'streamer', // is_owner
            d: domainId,           // domain_id
            iat: Math.floor(Date.now() / 1000), // issued at
            exp: Math.floor(Date.now() / 1000) + (2 * 60 * 60), // expires in 2 hours
        };
        
        // Добавляем дополнительные права в зависимости от роли
        if (role === 'streamer') {
            payload.u = 'Стример';    // user_name
            payload.vo = false;       // start_video_off
            payload.ao = false;       // start_audio_off
        } else if (role === 'viewer') {
            payload.u = `Зритель_${Math.random().toString(36).substr(2, 5)}`;  // user_name
            payload.vo = true;        // start_video_off для зрителя
            payload.ao = true;        // start_audio_off для зрителя
        }
        
        console.log('🔧 JWT payload:', payload);
        
        // Создаем self-signed JWT токен
        const token = jwt.sign(payload, DAILY_API_KEY, {
            algorithm: 'HS256'
        });
        
        console.log('✅ Self-signed JWT токен создан для роли:', role);
        
        res.json({
            success: true,
            token: token
        });
        
    } catch (error) {
        console.error('❌ Ошибка создания токена:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// Удаление комнаты и очистка данных стрима
router.delete('/delete-room/:streamId', requireAuth, requireOwner(Stream, { param: 'streamId', field: 'userId' }), async (req, res) => {
    try {
        const { streamId } = req.params;
        
        // Получаем данные стрима
        const stream = await Stream.findById(streamId);
        if (!stream || !stream.dailyRoomName) {
            return res.status(404).json({
                success: false,
                message: 'Stream or Daily.co room not found'
            });
        }
        
        const roomName = stream.dailyRoomName;
        console.log('🗑️ Удаление комнаты:', roomName);
        
        try {
            await axios.delete(`${DAILY_API_BASE}/rooms/${roomName}`, {
                headers: dailyHeaders
            });
        } catch (error) {
            // Игнорируем 404 ошибку (комната уже не существует)
            if (error.response && error.response.status !== 404) {
                throw error;
            }
        }
        
        // Очищаем Daily.co данные из стрима
        await Stream.findByIdAndUpdate(streamId, {
            dailyRoomName: null
        });
        
        console.log('✅ Комната удалена и данные очищены:', roomName);
        
        res.json({
            success: true,
            message: 'Room deleted successfully'
        });
        
    } catch (error) {
        console.error('❌ Ошибка удаления комнаты:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: error.response?.data?.message || error.message
        });
    }
});

// Получение информации о комнате
router.get('/room-info/:roomName', requireAuth, async (req, res) => {
    try {
        const { roomName } = req.params;
        
        const response = await axios.get(`${DAILY_API_BASE}/rooms/${roomName}`, {
            headers: dailyHeaders
        });
        
        const roomData = response.data;
        
        res.json({
            success: true,
            room: roomData
        });
        
    } catch (error) {
        console.error('❌ Ошибка получения информации о комнате:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: error.response?.data?.message || error.message
        });
    }
});

// Получение информации о комнате стрима для зрителей
router.get('/get-stream-room/:streamId', async (req, res) => {
    try {
        const { streamId } = req.params;
        
        console.log('🔍 Поиск комнаты для стрима:', streamId);
        
        // Находим стрим в базе данных
        const stream = await Stream.findById(streamId);
        
        if (!stream) {
            return res.status(404).json({
                success: false,
                message: 'Stream not found'
            });
        }
        
        // Проверяем что стрим активен и имеет данные Daily.co
        if (!stream.isActive || !stream.dailyRoom || !stream.dailyRoom.name) {
            return res.status(400).json({
                success: false,
                message: 'Stream is not active or room not created'
            });
        }
        
        console.log('✅ Комната найдена:', stream.dailyRoom.name);
        
        res.json({
            success: true,
            roomName: stream.dailyRoom.name,
            roomUrl: stream.dailyRoom.url
        });
        
    } catch (error) {
        console.error('❌ Ошибка получения комнаты стрима:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

module.exports = router; 