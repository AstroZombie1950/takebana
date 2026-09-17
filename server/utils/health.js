// Проверка внешних сервисов для вкладки «Система».
//
// Переменная окружения может быть задана и при этом не работать: ключ
// отозван, домен не тот, CDN лежит. Здесь каждый сервис получает один
// дешёвый запрос, который ничего не меняет, и по ответу видно, пускает ли
// он нас с этими настройками.
//
// Ответ кэшируется на минуту: вкладку переоткрывают, а сервисам незачем
// получать запрос на каждый клик.

const TIMEOUT_MS = 5000;
const CACHE_MS = 60 * 1000;

let last = null;

const NET = { ENOTFOUND: 'домен не найден', ECONNREFUSED: 'соединение отклонено', ECONNRESET: 'соединение оборвано', CERT_HAS_EXPIRED: 'сертификат просрочен' };

async function request(url, init = {}) {
  try {
    return await fetch(url, { redirect: 'manual', ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const code = err.cause && err.cause.code;
    throw new Error(err.name === 'TimeoutError' ? `нет ответа за ${TIMEOUT_MS / 1000} с` : NET[code] || code || err.message);
  }
}

// Ключ приняли — 2xx; 401 и 403 — ключ не подходит; остальное — сбой сервиса.
function expectOk(res) {
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) throw new Error(`ключ не принят (HTTP ${res.status})`);
  throw new Error(`HTTP ${res.status}`);
}

// Адрес раздачи: важно, что он отвечает, а не что в корне что-то лежит —
// 404 на корень CDN нормален. Сбой — только сеть и 5xx.
async function reachable(base) {
  const res = await request(base.replace(/\/+$/, '') + '/', { method: 'HEAD' });
  if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
}

const CHECKS = {
  async daily() {
    const res = await request('https://api.daily.co/v1/', { headers: { Authorization: `Bearer ${process.env.DAILY_API_KEY}` } });
    expectOk(res);
    // Ключ может быть от другого аккаунта: тогда комнаты создаются не там,
    // где их ищет браузер.
    const { domain_name: domain } = await res.json();
    const want = String(process.env.DAILY_DOMAIN || '').replace(/^https?:\/\//, '').split('.')[0];
    if (want && domain && domain !== want) throw new Error(`ключ от домена ${domain}, а задан ${want}`);
  },

  // Код заведомо негодный: Google отвечает invalid_grant, если пара
  // «клиент — секрет» верна, и invalid_client, если нет. Ничего не выдаётся.
  async google() {
    const res = await request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        grant_type: 'authorization_code',
        code: 'takebana-health-check',
        redirect_uri: process.env.CALLBACKURL || '',
      }),
    });
    const { error } = await res.json().catch(() => ({}));
    if (error === 'invalid_client' || error === 'unauthorized_client') throw new Error('клиент или секрет не приняты');
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  },

  // Ключ только на отправку списка доменов не видит и отвечает
  // restricted_api_key — это рабочий ключ, а не ошибка.
  async resend() {
    const res = await request('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
    if (res.ok) return;
    const { name } = await res.json().catch(() => ({}));
    if (name === 'restricted_api_key') return;
    expectOk(res);
  },

  async bunnyStorage() {
    const endpoint = (process.env.BUNNY_STORAGE_ENDPOINT || '').replace(/\/+$/, '');
    if (!endpoint || !process.env.BUNNY_STORAGE_ZONE) throw new Error('нет BUNNY_STORAGE_ENDPOINT или BUNNY_STORAGE_ZONE');
    const res = await request(`${endpoint}/${encodeURIComponent(process.env.BUNNY_STORAGE_ZONE)}/`, {
      headers: { AccessKey: process.env.BUNNY_STORAGE_KEY, Accept: 'application/json' },
    });
    if (res.status === 404) throw new Error('зона хранения не найдена');
    expectOk(res);
  },

  async bunnyApi() {
    const res = await request('https://api.bunny.net/storagezone?page=1&perPage=1', {
      headers: { AccessKey: process.env.BUNNY_API_KEY, Accept: 'application/json' },
    });
    expectOk(res);
  },

  cdn: () => reachable(process.env.RECORDINGS_CDN_URL),
  hls: () => reachable(process.env.HLS_BASE_URL),

  // Nominatim закрывает доступ ответом 403 — ровно то, что стоит увидеть здесь.
  // Запрос — с тем же User-Agent, что у utils/geocode.js.
  async geocoder() {
    const base = (process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
    const res = await request(base + '/status', {
      headers: { 'User-Agent': `Takebana/1.0 (${process.env.GEOCODER_CONTACT})`, Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) throw new Error(`доступ закрыт (HTTP ${res.status})`);
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  },
};

// Какая переменная каким сервисом проверяется. Проверка идёт, только если
// переменная задана: «не задана» видно и без запроса.
const CHECK_OF = {
  DAILY_API_KEY: 'daily',
  DAILY_DOMAIN: 'daily',
  GOOGLE_CLIENT_ID: 'google',
  RESEND_API_KEY: 'resend',
  BUNNY_STORAGE_KEY: 'bunnyStorage',
  BUNNY_API_KEY: 'bunnyApi',
  RECORDINGS_CDN_URL: 'cdn',
  HLS_BASE_URL: 'hls',
  GEOCODER_CONTACT: 'geocoder',
};

async function run() {
  if (last && Date.now() - last.at < CACHE_MS) return last.value;

  const names = [...new Set(Object.entries(CHECK_OF).filter(([env]) => process.env[env]).map(([, name]) => name))];
  const results = await Promise.all(names.map((name) => CHECKS[name]().then(
    () => [name, { ok: true }],
    (err) => [name, { ok: false, error: String(err.message || err).slice(0, 200) }],
  )));

  const byName = Object.fromEntries(results);
  const value = {
    checkedAt: new Date(),
    env: Object.fromEntries(Object.keys(CHECK_OF).filter((env) => byName[CHECK_OF[env]]).map((env) => [env, byName[CHECK_OF[env]]])),
  };
  last = { at: Date.now(), value };
  return value;
}

module.exports = { run };
