const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router);
const { authLimiter } = require('../middleware/rateLimit'); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const Establishments = require('../models/Establishments');
const bcrypt = require('bcrypt');
const User = require('../models/User');
// multer здесь был объявлен, но ни один маршрут админки файлы не принимает —
// убран вместе с path, который нужен был только ему.
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



router.post('/admin/updatePassword', isAdmin, authLimiter, async (req, res) => {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
        return res.status(400).json({ message: 'Нужны текущий и новый пароль' });
    }
    // Столько же требует форма админки (views/admin.ejs)
    if (newPassword.length < 8) {
        return res.status(400).json({ message: 'Новый пароль должен содержать не менее 8 символов' });
    }

    try {
        // Пароль администратора хранится в его собственной записи User — там же,
        // где его сверяет вход (routes/userRoutes.js). Прежняя версия писала хеш
        // в коллекцию adminsettings, которую при входе не читает никто, поэтому
        // смена пароля отвечала «успешно», а войти можно было только по старому.
        const user = await User.findById(req.session.userId);
        if (!user) {
            return res.status(404).json({ message: 'Пользователь не найден' });
        }

        const match = await bcrypt.compare(oldPassword, user.password);
        if (!match) {
            return res.status(401).json({ message: 'Неверный текущий пароль' });
        }

        user.password = await bcrypt.hash(newPassword, 10);
        await user.save();

        res.json({ message: 'Пароль успешно обновлен' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
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
        // спецсимволы экранируем — см. /searchEstablishments в establishmentsRouter
        query.name = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
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
