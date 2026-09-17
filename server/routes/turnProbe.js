// Проверка своего TURN-сервера (coturn) из сети посетителя. ВРЕМЕННО.
//
// У части людей в России звонки Daily без VPN не соединяются: провайдер
// душит долгие соединения с зарубежными облаками, а до нашего сервера всё
// доходит. Прежде чем строить запасной путь звонка через свой TURN, меряем,
// держится ли через него живой видеопоток: страница public/turn-probe.html,
// итог — в журнал ошибок под именем TurnProbe. После решения — удалить
// вместе со страницей.
//
// Ключи — временные, по схеме coturn use-auth-secret (TURN REST API):
// имя = «срок годности:пользователь», пароль = HMAC-SHA1 имени общим
// секретом. Секрет живёт только в .env и в конфиге coturn.

const express = require('express');
const router = express.Router();
const { createHmac } = require('crypto');
const { requireAuthApi } = require('../middleware/auth');

const TTL_S = 2 * 60 * 60;

router.get('/api/turn-probe', requireAuthApi, (req, res) => {
    const secret = process.env.TURN_SECRET;
    const host = process.env.TURN_HOST;
    if (!secret || !host) return res.status(503).json({ message: 'TURN не настроен' });

    const username = Math.floor(Date.now() / 1000 + TTL_S) + ':' + req.session.userId;
    const credential = createHmac('sha1', secret).update(username).digest('base64');

    // Каждый путь проверяется отдельно: какой режет провайдер — и есть ответ.
    const paths = [
        { label: 'UDP 3478', url: `turn:${host}:3478?transport=udp` },
        { label: 'TCP 3478', url: `turn:${host}:3478?transport=tcp` },
        { label: 'TLS 5349', url: `turns:${host}:5349?transport=tcp` },
    ];
    // TLS на 443 — только когда nginx делит порт по имени (ssl_preread).
    if (process.env.TURN_TLS443_HOST) {
        paths.push({ label: 'TLS 443', url: `turns:${process.env.TURN_TLS443_HOST}:443?transport=tcp` });
    }

    res.json({ username, credential, paths });
});

module.exports = router;
