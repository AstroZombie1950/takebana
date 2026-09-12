// Поиск адреса для формы заведения.
//
// Страница спрашивает наш сервер, наружу ходит только utils/geocode.js:
// в клиентском коде чужих хостов нет. Маршруты закрыты входом — адрес ищет
// владелец в своей форме, анонимам дёргать чужой сервис незачем.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const { requireAuthApi } = require('../middleware/auth');
const { geocodeLimiter } = require('../middleware/rateLimit');
const { CITY_NAME } = require('../config/catalog');
const geocode = require('../utils/geocode');

// Поставщик — чужой и общественный: он может ответить 403, 429 или не
// ответить вовсе. Это не ошибка сервера: форма без поиска работает, метку
// ставят рукой, — поэтому 503 с человеческим текстом, а не 500.
const UNAVAILABLE = { message: 'Поиск адресов сейчас недоступен — поставьте метку на карте' };

function fail(res, err) {
    console.error('[geocode]', err.message);
    return res.status(503).json(UNAVAILABLE);
}

router.get('/api/geocode', requireAuthApi, geocodeLimiter, async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (q.length < 3) {
        return res.status(400).json({ message: 'Адрес короче трёх символов' });
    }

    // Подсказка — только код города из закрытого списка: свободную строку
    // из запроса в чужой сервис не передаём.
    const hint = CITY_NAME[req.query.city] || '';

    let point;
    try {
        point = await geocode.search(q, hint);
    } catch (err) {
        return fail(res, err);
    }

    if (!point) return res.status(404).json({ message: 'Адрес не найден' });
    res.json(point);
});

router.get('/api/geocode/reverse', requireAuthApi, geocodeLimiter, async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return res.status(400).json({ message: 'Нужны координаты точки' });
    }

    let found;
    try {
        found = await geocode.reverse(lat, lng);
    } catch (err) {
        return fail(res, err);
    }

    if (!found) return res.status(404).json({ message: 'Адрес точки не определён' });
    res.json(found);
});

module.exports = router;
