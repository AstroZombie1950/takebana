const express = require('express');
const router = express.Router();

const Establishments = require('../models/Establishments');
const Rating = require('../models/Rating');
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, 'uploads/')
  },
  filename: function(req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname)) // сохраняем оригинальное расширение файла
  }
})

const upload = multer({ storage: storage });




// Видимо создание заведения хз пока 

router.post('/register-establishment', async (req, res) => {
    const { name, country, city, address, email, phone, weekdayHours, weekendHours, lat, lng } = req.body;

    if (!name || !country || !city || !address || !email || !phone || !weekdayHours || !weekendHours) {
        return res.status(400).json({ message: 'Please fill in all fields' });
    }

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
});


router.get('/establishmentsLocation', async (req, res) => {
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
});



router.get('/getEstablishments/:id', async (req, res) => {
    const id = req.params.id;

    // Найдите заведение с заданным идентификатором
    const establishment = await Establishments.findById(id);

    if (establishment) {
        res.json(establishment);
    } else {
        res.status(404).send('Establishment not found');
    }
});


router.get('/searchEstablishments/:name', async (req, res) => {
    const name = req.params.name;

    // Создайте регулярное выражение, которое ищет заведения, имена которых содержат введенный текст
    var regex = new RegExp(name, 'i');

    // Найдите все заведения, имена которых соответствуют регулярному выражению
    const establishments = await Establishments.find({ name: regex });

    if (establishments) {
        res.json(establishments);
    } else {
        res.status(404).send('No establishments found');
    }
});




router.get('/user-establishments', async (req, res) => {
    const userId = req.session.userId;

    // Используйте ваш контроллер для получения заведений пользователя
    const establishments = await Establishments.find({ owner: userId });

    if (establishments) {
        res.json(establishments);
    } else {
        res.status(404).send('No establishments found');
    }
});

router.put('/updateEstablishment/:id', upload.array('newPhotos'), async (req, res) => {
    
    if (req.files.length > 6) {
        req.files = req.files.slice(0, 6);
    }

    const { name, country, city, address, email, phone, weekdayHours, weekendHours, location, uploadedPhotos } = req.body;
    const { lat, lng } = location || {}; // Извлекаем lat и lng из объекта location

    if (!name && !country && !city && !address && !email && !phone && !weekdayHours && !weekendHours && !lat && !lng) {
        return res.status(400).json({ message: 'Please specify at least one field to update' }); // Change this line
    }

    const establishment = {
        name,
        country,
        city,
        address,
        email,
        phone,
        status: false, 
        weekdayHours: JSON.parse(weekdayHours),
        weekendHours: JSON.parse(weekendHours),
        location: location && lat && lng ? {
            lat: parseFloat(lat),
            lng: parseFloat(lng)
        } : undefined,
        photos: JSON.parse(uploadedPhotos).concat(req.files.map(file => file.path)) // Здесь вы можете добавить логику для сохранения пути к файлу или URL
    };

    try {
        const updatedEstablishment = await Establishments.findByIdAndUpdate(req.params.id, establishment, { new: true });
        res.json(updatedEstablishment);
    } catch (err) {
        console.error(err); // Логируем ошибку
        res.status(500).json({ message: 'An error occurred while updating the establishment.' }); // Change this line
    }
});


router.post('/updateEstablishmentsOnlineStatus', function(req, res) {
    const { userId, online, peerId } = req.body; // добавьте peerId здесь

    Establishments.updateMany({ owner: userId }, { online: online, peerId: peerId }) // обновите peerId здесь
        .then(result => {
            res.send(result);
        })
        .catch(err => {
            res.send(err);
        });
});

router.post('/updateEstablishmentOnlineStatus', function(req, res) {
    const { userId, establishmentId, online, peerId } = req.body; // добавьте peerId здесь

    // Найдите заведение по идентификатору
    Establishments.findById(establishmentId)
        .then(establishment => {
            // Проверьте, принадлежит ли заведение пользователю
            if (establishment.owner.toString() === userId) {
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



router.post('/rateEstablishment', async (req, res) => {
    const { establishmentId, rating } = req.body;

    // Получите идентификатор пользователя из сессии
    const userId = req.session.userId;

    if (!userId || !establishmentId || !rating) {
        return res.status(400).json({ message: 'Пожалуйста, заполните все поля' });
    }

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
});

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
