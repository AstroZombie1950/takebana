const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router);
const { authLimiter } = require('../middleware/rateLimit'); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { validate } = require('../middleware/validate');

const Establishments = require('../models/Establishments');
const bcrypt = require('bcrypt');
const User = require('../models/User');
// multer здесь был объявлен, но ни один маршрут админки файлы не принимает —
// убран вместе с path, который нужен был только ему.
// Часы работы приходят объектом {open, close} — так же они лежат и в схеме
// Establishments. `json: true` разбирает поле, если форма прислала его строкой.
const HOURS = { type: 'object', json: true, schema: {
    open: { type: 'string', max: 5 },
    close: { type: 'string', max: 5 },
} };

// lat/lng намеренно не обязательные: форма админки шлёт parseFloat('') → NaN,
// а он уезжает в JSON как null. Прежний код на такое значение просто не обновлял
// координату, и это поведение сохраняем.
const LOCATION = { type: 'object', label: 'Координаты', schema: {
    lat: { type: 'number', min: -90, max: 90 },
    lng: { type: 'number', min: -180, max: 180 },
} };

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



// Минимум в 8 символов требует и форма админки (views/admin.ejs).
router.post('/admin/updatePassword', isAdmin, authLimiter, validate({
    oldPassword: { type: 'string', required: true, max: 200, trim: false, label: 'Текущий пароль' },
    newPassword: { type: 'string', required: true, min: 8, max: 200, trim: false, label: 'Новый пароль' },
}), async (req, res) => {
    const { oldPassword, newPassword } = req.body;

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




router.put('/admin/updEstablishment/:id', isAdmin, validate({
    name: { type: 'string', max: 200, label: 'Название' },
    country: { type: 'string', max: 100, label: 'Страна' },
    city: { type: 'string', max: 100, label: 'Город' },
    address: { type: 'string', max: 300, label: 'Адрес' },
    email: { type: 'email', label: 'Почта' },
    phone: { type: 'string', max: 32, label: 'Телефон' },
    weekdayHours: { ...HOURS, label: 'Часы по будням' },
    weekendHours: { ...HOURS, label: 'Часы по выходным' },
    location: LOCATION,
}), async (req, res) => {
    const { name, country, city, address, email, phone, weekdayHours, weekendHours, location } = req.body;
    const { lat, lng } = location || {};

    // После валидации в теле остаются только заполненные поля, поэтому пустой
    // объект и означает «обновлять нечего». JSON.parse отсюда убран: часы
    // разбирает схема, и кривая строка теперь даёт 400, а не 500.
    if (!Object.keys(req.body).length) {
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
        weekdayHours,
        weekendHours,
        location: { lat, lng }
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


router.put('/admin/updateEstablishmentStatus/:id', isAdmin, validate({
    status: { type: 'bool', required: true, label: 'Статус' },
}), function(req, res) {
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
