// Адрес ↔ точка на карте.
//
// Зачем это есть: без координат заведение не попадает на карту, а владелец их
// не знает и знать не должен. В форме он либо перетаскивает метку, либо пишет
// адрес — одно превращается в другое здесь.
//
// Чужой хост в проекте один и он на сервере: страницы обращаются к нашему
// /api/geocode, а наружу ходит только этот файл. Поставщик меняется
// переменной GEOCODER_URL, в клиентском коде его нет вовсе.
//
// По умолчанию это Nominatim — общественный поиск OpenStreetMap. Ключа он не
// просит, но и нагружать его нельзя: не больше запроса в секунду и никакого
// поиска на каждую набранную букву. Отсюда очередь, суточный кэш и то, что
// запрос уходит только по нажатию. Общественный сервер плиток OSM нам уже
// закрыли («Access blocked», docs/STATUS.md), так что поставщик может отпасть
// в любой день: форма это переживает — метку всегда можно поставить рукой.

const BASE = (process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const CONTACT = process.env.GEOCODER_CONTACT || '';
const TIMEOUT_MS = 8000;
const MIN_INTERVAL_MS = 1100; // «не чаще раза в секунду» с запасом на дорогу
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;

// Кэш в памяти процесса: один и тот же адрес в форме набирают по нескольку
// раз, а перетаскивание метки туда-обратно возвращается в ту же точку.
const cache = new Map(); // ключ → { at, value }

function cached(key) {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > CACHE_TTL_MS) {
        cache.delete(key);
        return undefined;
    }
    return hit.value;
}

function remember(key, value) {
    cache.delete(key); // порядок вставки — он же порядок вытеснения
    cache.set(key, { at: Date.now(), value });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// Очередь: запросы уходят по одному и не чаще, чем раз в MIN_INTERVAL_MS,
// сколько бы владельцев ни заполняли форму одновременно.
let chain = Promise.resolve();
let last = 0;

function queued(fn) {
    const run = chain.then(async () => {
        const wait = MIN_INTERVAL_MS - (Date.now() - last);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        return fn();
    });
    chain = run.catch(() => {}); // очередь не должна ломаться об одну ошибку
    return run;
}

async function ask(path, params) {
    const url = new URL(BASE + path);
    url.search = new URLSearchParams({
        format: 'jsonv2',
        addressdetails: '1',
        'accept-language': 'ru',
        ...params,
    }).toString();

    // Nominatim требует, чтобы клиент себя назвал, и отвечает 403 на пустое
    // или общее название. Адрес для связи — в GEOCODER_CONTACT.
    const res = await fetch(url, {
        headers: {
            'User-Agent': `Takebana/1.0${CONTACT ? ` (${CONTACT})` : ''}`,
            Accept: 'application/json',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        const err = new Error(`geocode ${path}: ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

// Короткая строка вместо display_name: тот отдаёт и округ, и почтовый индекс,
// и страну — в поле «Адрес заведения» это лишнее.
function shortAddress(a, fallback) {
    if (!a) return fallback || '';
    const street = [a.road, a.house_number].filter(Boolean).join(' ');
    const place = a.city || a.town || a.village || a.municipality || a.county || '';
    return [street, place].filter(Boolean).join(', ') || fallback || '';
}

// Адрес → точка. Город из закрытого списка приходит подсказкой: «Кнеза
// Милоша 5» без города находится в другой стране с той же вероятностью.
async function search(query, hint) {
    const q = [query, hint].filter(Boolean).join(', ');
    const key = 's:' + q.toLowerCase();
    const known = cached(key);
    if (known !== undefined) return known;

    const list = await queued(() => ask('/search', { q, limit: '1' }));
    const hit = Array.isArray(list) ? list[0] : null;
    const point = hit
        ? { lat: Number(hit.lat), lng: Number(hit.lon), address: shortAddress(hit.address, hit.display_name) }
        : null;
    remember(key, point);
    return point;
}

// Точка → адрес. Округление до пяти знаков — это метр на местности: точнее
// метку всё равно не поставить мышью, зато кэш попадает.
async function reverse(lat, lng) {
    const key = `r:${lat.toFixed(5)},${lng.toFixed(5)}`;
    const known = cached(key);
    if (known !== undefined) return known;

    const data = await queued(() => ask('/reverse', { lat: String(lat), lon: String(lng), zoom: '18' }));
    const found = data && !data.error ? { address: shortAddress(data.address, data.display_name) } : null;
    remember(key, found);
    return found;
}

module.exports = { search, reverse };
