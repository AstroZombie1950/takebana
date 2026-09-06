// Подпись для публикации в RTMP.
//
// Зачем. Ключ трансляции (streamKey) попадает в исходник страницы каждому
// зрителю: по нему собирается URL воспроизведения `/live/<streamKey>.flv`,
// иначе плеер поток не найдёт. То есть «секретным» ключ быть не может.
// А node-media-server по умолчанию пускает публиковать любого, кто этот путь
// знает, — значит, зритель мог подменить чужой эфир своей картинкой.
//
// Решение: адрес воспроизведения остаётся открытым, а право публиковать даёт
// отдельная подпись, которую видит только владелец эфира на своей странице.
//
// Формат подписи задан самим node-media-server (node_core_utils.verifyAuth):
//   sign = <срок в секундах Unix>-<md5( "<путь>-<срок>-<секрет>" )>
// Путь — это `/live/<streamKey>`, ровно как его видит медиасервер.

const crypto = require('crypto');

// Сколько живёт подпись. Ключ с подписью вставляют в OBS и не трогают неделями,
// поэтому срок длинный: короткий заставлял бы переоткрывать страницу перед
// каждым эфиром. Меняется через RTMP_SIGN_TTL_DAYS.
const DEFAULT_TTL_DAYS = 30;

function getSecret() {
    return process.env.RTMP_PUBLISH_SECRET || '';
}

// Проверка публикации включается только вместе с секретом: без него вещатели
// со старыми ключами продолжают работать, как работали.
function isPublishAuthEnabled() {
    return Boolean(getSecret());
}

function sign(streamPath, ttlSeconds) {
    const secret = getSecret();
    if (!secret) return null;

    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const hash = crypto.createHash('md5').update(`${streamPath}-${exp}-${secret}`).digest('hex');
    return `${exp}-${hash}`;
}

// То, что вещатель вставляет в OBS в поле «Ключ потока».
// Без секрета — просто ключ, как было раньше.
function buildObsStreamKey(streamKey, ttlDays) {
    if (!streamKey) return '';
    if (!isPublishAuthEnabled()) return streamKey;

    const days = Number(ttlDays || process.env.RTMP_SIGN_TTL_DAYS) || DEFAULT_TTL_DAYS;
    const signature = sign(`/live/${streamKey}`, days * 24 * 60 * 60);
    return `${streamKey}?sign=${signature}`;
}

// Дата, до которой действует ключ, — её показываем вещателю рядом с полем.
function getSignExpiry(ttlDays) {
    if (!isPublishAuthEnabled()) return null;
    const days = Number(ttlDays || process.env.RTMP_SIGN_TTL_DAYS) || DEFAULT_TTL_DAYS;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

module.exports = { isPublishAuthEnabled, getSecret, sign, buildObsStreamKey, getSignExpiry };
