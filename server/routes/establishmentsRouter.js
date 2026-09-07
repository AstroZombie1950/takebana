const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const Establishments = require('../models/Establishments');
const Rating = require('../models/Rating');
const multer = require('multer');
const path = require('path');

// Фото заведений кладём туда же, где аватары, галерея и обложки, —
// в public/uploads. Раньше путь был 'uploads/' относительно рабочего каталога
// процесса: папка оказывалась вне public (то есть не раздавалась статикой
// напрямую), не попадала в .gitignore и уезжала, если сервер запускали не из
// server/. В базе не было ни одного заведения с фото, переносить нечего.
const fs = require('fs');

const ESTABLISHMENT_UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'establishments');

const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    try {
      if (!fs.existsSync(ESTABLISHMENT_UPLOAD_DIR)) {
        fs.mkdirSync(ESTABLISHMENT_UPLOAD_DIR, { recursive: true });
      }
      cb(null, ESTABLISHMENT_UPLOAD_DIR);
    } catch (e) {
      cb(e);
    }
  },
  filename: function(req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname)) // сохраняем оригинальное расширение файла
  }
})

const { requireAuth, requireOwner, wrap } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

// Часы работы и координаты повторяются в двух маршрутах — держим схемы рядом.
// `json: true` нужен из-за multipart: там всё приходит строками.
const HOURS = { type: 'object', json: true, schema: {
    open: { type: 'string', max: 5 },
    close: { type: 'string', max: 5 },
} };
const LOCATION = { type: 'object', json: true, label: 'Координаты', schema: {
    lat: { type: 'number', min: -90, max: 90 },
    lng: { type: 'number', min: -180, max: 180 },
} };

const upload = multer({ storage: storage });




// Видимо создание заведения хз пока 

router.post('/register-establishment', requireAuth, validate({
    name: { type: 'string', required: true, max: 200, label: 'Название' },
    country: { type: 'string', required: true, max: 100, label: 'Страна' },
    city: { type: 'string', required: true, max: 100, label: 'Город' },
    address: { type: 'string', required: true, max: 300, label: 'Адрес' },
    email: { type: 'email', required: true, label: 'Почта' },
    phone: { type: 'string', required: true, max: 32, label: 'Телефон' },
    weekdayHours: { ...HOURS, required: true, label: 'Часы по будням' },
    weekendHours: { ...HOURS, required: true, label: 'Часы по выходным' },
    lat: { type: 'number', min: -90, max: 90, label: 'Широта' },
    lng: { type: 'number', min: -180, max: 180, label: 'Долгота' },
}), wrap(async (req, res) => {
    const { name, country, city, address, email, phone, weekdayHours, weekendHours, lat, lng } = req.body;

    const establishment = new Establishments({
        name,
        country,
        city,
        address,
        email,
        phone,
        status: false, 
        weekdayHours,
        weekendHours,
        location: {
            lat,
            lng
        },
        owner: req.session.userId // добавляем владельца
    });

    try {
        const savedEstablishment = await establishment.save();
        res.json({ message: 'Establishment successfully registered!', establishment: savedEstablishment });
    } catch (err) {
        res.status(500).json({ message: 'Server error: ' + err.message });
    }
}));


router.get('/establishmentsLocation', wrap(async (req, res) => {
    const { bl_lat, bl_lng, tr_lat, tr_lng } = req.query;

    // Преобразуйте координаты в числа
    const [bottomLeftLat, bottomLeftLng, topRightLat, topRightLng] = [bl_lat, bl_lng, tr_lat, tr_lng].map(Number);

    // Найдите все заведения внутри заданных границ
    const establishments = await Establishments.find({
        'location.lat': { $gte: bottomLeftLat, $lte: topRightLat },
        'location.lng': { $gte: bottomLeftLng, $lte: topRightLng },
        'status': true  // Добавьте это условие, чтобы выбрать только заведения со статусом true
    });

    res.json(establishments);
}));



router.get('/getEstablishments/:id', wrap(async (req, res) => {
    const id = req.params.id;

    // Найдите заведение с заданным идентификатором
    const establishment = await Establishments.findById(id);

    if (establishment) {
        res.json(establishment);
    } else {
        res.status(404).send('Establishment not found');
    }
}));


router.get('/searchEstablishments/:name', wrap(async (req, res) => {
    const name = req.params.name;

    // Спецсимволы экранируются: строка вроде `(a+)+$` собирала регулярное
    // выражение с катастрофическим откатом и вешала процесс на одном запросе.
    var regex = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    // Найдите все заведения, имена которых соответствуют регулярному выражению
    const establishments = await Establishments.find({ name: regex });

    if (establishments) {
        res.json(establishments);
    } else {
        res.status(404).send('No establishments found');
    }
}));




router.get('/user-establishments', requireAuth, wrap(async (req, res) => {
    const userId = req.session.userId;

    // Используйте ваш контроллер для получения заведений пользователя
    const establishments = await Establishments.find({ owner: userId });

    if (establishments) {
        res.json(establishments);
    } else {
        res.status(404).send('No establishments found');
    }
}));

// validate стоит после multer: до разбора multipart тела ещё нет.
router.put('/updateEstablishment/:id', requireAuth, requireOwner(Establishments), upload.array('newPhotos'), validate({
    name: { type: 'string', max: 200, label: 'Название' },
    country: { type: 'string', max: 100, label: 'Страна' },
    city: { type: 'string', max: 100, label: 'Город' },
    address: { type: 'string', max: 300, label: 'Адрес' },
    email: { type: 'email', label: 'Почта' },
    phone: { type: 'string', max: 32, label: 'Телефон' },
    weekdayHours: { ...HOURS, label: 'Часы по будням' },
    weekendHours: { ...HOURS, label: 'Часы по выходным' },
    location: LOCATION,
    // Список уже загруженных фотографий, который присылает форма. Столько же,
    // сколько принимает загрузка новых, — иначе лимит в 6 обходится этим полем.
    uploadedPhotos: { type: 'array', json: true, max: 6, default: [],
        of: { type: 'string', max: 300 }, label: 'Фотографии' },
}), wrap(async (req, res) => {
    
    if (req.files.length > 6) {
        req.files = req.files.slice(0, 6);
    }

    const { name, country, city, address, email, phone, weekdayHours, weekendHours, location, uploadedPhotos } = req.body;
    const { lat, lng } = location || {};

    // Пустое тело после разбора и означает «обновлять нечего». Три JSON.parse
    // отсюда убраны: их делает схема, и кривая строка теперь даёт 400, а не 500.
    if (!Object.keys(req.body).length) {
        return res.status(400).json({ message: 'Please specify at least one field to update' });
    }

    const establishment = {
        name,
        country,
        city,
        address,
        email,
        phone,
        status: false, 
        weekdayHours,
        weekendHours,
        location: lat !== undefined && lng !== undefined ? { lat, lng } : undefined,
        // Абсолютный URL от корня сайта. file.path раньше давал относительный
        // 'uploads/имя.jpg', и на вложенных страницах вида /userPage/:id браузер
        // искал его по /userPage/uploads/... — картинка не находилась.
        photos: uploadedPhotos.concat(req.files.map(file => `/uploads/establishments/${file.filename}`))
    };

    try {
        const updatedEstablishment = await Establishments.findByIdAndUpdate(req.params.id, establishment, { new: true });
        res.json(updatedEstablishment);
    } catch (err) {
        console.error(err); // Логируем ошибку
        res.status(500).json({ message: 'An error occurred while updating the establishment.' }); // Change this line
    }
}));


// Владелец берётся из сессии, а не из тела запроса. Раньше userId приходил
// от клиента: вошедший подставлял чужой идентификатор и разом переписывал
// online и peerId у всех заведений другого пользователя. Воспроизводилось.
router.post('/updateEstablishmentsOnlineStatus', requireAuth, validate({
    online: { type: 'bool', required: true, label: 'Статус' },
    peerId: { type: 'string', max: 128, default: '', label: 'PeerId' },
}), function(req, res) {
    const { online, peerId } = req.body;
    const userId = req.session.userId;

    Establishments.updateMany({ owner: userId }, { online: online, peerId: peerId })
        .then(result => {
            res.send(result);
        })
        .catch(err => {
            res.send(err);
        });
});

// Здесь проверка владельца была бутафорской: establishment.owner сверялся
// с userId из того же тела запроса, поэтому достаточно было прислать
// идентификатор настоящего владельца. Сверяем с сессией.
router.post('/updateEstablishmentOnlineStatus', requireAuth, validate({
    establishmentId: { type: 'objectId', required: true, label: 'Заведение' },
    online: { type: 'bool', required: true, label: 'Статус' },
    peerId: { type: 'string', max: 128, default: '', label: 'PeerId' },
}), function(req, res) {
    const { establishmentId, online, peerId } = req.body;
    const userId = req.session.userId;

    // Найдите заведение по идентификатору
    Establishments.findById(establishmentId)
        .then(establishment => {
            if (!establishment) {
                throw new Error('Заведение не найдено');
            }
            // Проверьте, принадлежит ли заведение пользователю
            if (establishment.owner && establishment.owner.toString() === userId) {
                // Обновите статус онлайн и peerId заведения
                establishment.online = online;
                establishment.peerId = peerId; // обновите peerId здесь
                return establishment.save();
            } else {
                throw new Error('Вы не являетесь владельцем этого заведения');
            }
        })
        .then(updatedEstablishment => {
            res.send(updatedEstablishment);
        })
        .catch(err => {
            res.status(400).send(err.message);
        });
});



router.post('/rateEstablishment', requireAuth, validate({
    establishmentId: { type: 'objectId', required: true, label: 'Заведение' },
    // Оценка пятибалльная: без верхней границы одним запросом ставилась
    // произвольная, и средний балл заведения уезжал куда угодно.
    rating: { type: 'int', required: true, min: 1, max: 5, label: 'Оценка' },
}), wrap(async (req, res) => {
    const { establishmentId, rating } = req.body;

    // Получите идентификатор пользователя из сессии
    const userId = req.session.userId;

    try {
        // Проверьте, существует ли уже оценка от этого пользователя для этого заведения
        let userRating = await Rating.findOne({ user: userId, establishment: establishmentId });

        if (userRating) {
            // Если оценка существует, обновите ее
            userRating.rating = rating;
            await userRating.save();
        } else {
            // Если оценки не существует, создайте новую
            userRating = new Rating({
                user: userId,
                establishment: establishmentId,
                rating: rating
            });
            await userRating.save();
        }

        res.json(userRating);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
}));

router.get('/getUserRating/:userId/:establishmentId', async (req, res) => {
    const { userId, establishmentId } = req.params;

    try {
        // Проверьте, существует ли уже оценка от этого пользователя для этого заведения
        const userRating = await Rating.findOne({ user: userId, establishment: establishmentId });

        res.json(userRating);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.get('/getRatings/:establishmentId', async (req, res) => {
    const { establishmentId } = req.params;

    try {
        // Получите все оценки для этого заведения
        const ratings = await Rating.find({ establishment: establishmentId });

        res.json(ratings);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
