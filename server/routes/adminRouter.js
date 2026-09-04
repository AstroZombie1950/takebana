const express = require('express');
const router = express.Router();
const Establishments = require('../models/Establishments');
const bcrypt = require('bcrypt');
const User = require('../models/User');
const Admin = require('../models/Admin');
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
async function isAdmin(req, res, next) {
    if (req.session && req.session.userId) {
        const user = await User.findById(req.session.userId);
        if (user && user.role === 'admin') {
            next(); // пользователь администратор, продолжаем обработку запроса
        } else {
            res.status(403).send('Access denied'); // пользователь не администратор, отказ в доступе
        }
    } else {
        res.status(403).send('Access denied'); // нет идентификатора сессии, отказ в доступе
    }
}



router.post('/admin/updatePassword', isAdmin, async (req, res) => {
    const { oldPassword, newPassword } = req.body;

    // Попытка найти настройку с именем 'password'
    let setting = await Admin.findOne({ name: 'password' });

    if (setting) {
        // Проверяем, совпадает ли старый пароль с текущим паролем в базе данных
        const match = await bcrypt.compare(oldPassword, setting.value);
        if (!match) {
            return res.status(401).json({ message: 'Неверный текущий пароль' });
        }

        // Если настройка найдена и старый пароль совпадает, обновляем ее значение
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        setting.value = hashedPassword;
    } else {
        // Если настройка не найдена, создаем новую
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        setting = new Admin({
            name: 'password',
            value: hashedPassword
        });
    }

    // Сохраняем настройку в базе данных
    setting.save()
        .then(() => res.json({ message: 'Пароль успешно обновлен' }))
        .catch(err => res.status(500).json({ message: err.message }));
});



router.post('/admin/establishments', isAdmin, async (req, res) => {
    const page = req.query.page || 1;
    const perPage = req.query.perPage || 10;
    const status = req.query.status;
    const search = req.query.search;

    let query = {};
    if (status === 'active') {
        query.status = true;
    } else if (status === 'inactive') {
        query.status = false;
    }
    if (search) {
        query.name = new RegExp(search, 'i'); // ищем заведения, название которых содержит поисковый запрос
    }

    try {
        const establishments = await Establishments.find(query)
            .sort({ _id: -1 })
            .skip((page - 1) * perPage)
            .limit(perPage);
        res.json(establishments);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});




router.put('/admin/updEstablishment/:id', isAdmin, async (req, res) => {
    const { name, country, city, address, email, phone, weekdayHours, weekendHours, location } = req.body;
    const { lat, lng } = location || {}; // Извлекаем lat и lng из объекта location

    if (!name && !country && !city && !address && !email && !phone && !weekdayHours && !weekendHours && !lat && !lng) {
        return res.status(400).json({ message: 'Пожалуйста, укажите хотя бы одно поле для обновления' });
    }

    const establishment = {
        name,
        country,
        city,
        address,
        email,
        phone,
        status: false, 
        weekdayHours: weekdayHours ? JSON.parse(weekdayHours) : undefined,
        weekendHours: weekendHours ? JSON.parse(weekendHours) : undefined,
        location: {
            lat: lat ? parseFloat(lat) : undefined,
            lng: lng ? parseFloat(lng) : undefined
        }
    };

    try {
        const updatedEstablishment = await Establishments.findByIdAndUpdate(req.params.id, establishment, { new: true });
        res.json(updatedEstablishment);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});


router.delete('/admin/deleteEstablishment/:id', isAdmin, function(req, res) {
    const { id } = req.params;

    Establishments.findByIdAndDelete(id)
        .then(result => {
            if (!result) {
                throw new Error('Заведение не найдено');
            }
            res.send(result);
        })
        .catch(err => {
            res.status(400).send(err.message);
        });
});


router.put('/admin/updateEstablishmentStatus/:id', isAdmin, function(req, res) {
    const { id } = req.params;
    const { status } = req.body;

    Establishments.findByIdAndUpdate(id, { status: status })
        .then(result => {
            if (!result) {
                throw new Error('Заведение не найдено');
            }
            res.send(result);
        })
        .catch(err => {
            res.status(400).send(err.message);
        });
});




module.exports = router;
