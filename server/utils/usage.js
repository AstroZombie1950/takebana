// Расход у поставщиков — по их собственным данным.
//
// Свои метрики (routes/admin/summary.js, /costs) — оценка: Daily считает
// участнико-минуты сам, и кто сидел в комнате камеры заведения, знает только
// он; трафик раздачи и деньги знает только Bunny. Здесь — сверка по их API.
//
// Daily: GET /v1/meetings — встречи новыми первыми, у каждой участники
// с длительностью в секундах. Пагинация — starting_after с id последней
// встречи. Проверено на живом ключе 16 сентября 2026.
// Bunny: GET api.bunny.net/statistics (трафик, запросы, история баланса)
// и GET /storagezone (занятое место). Ключ — ключ аккаунта BUNNY_API_KEY,
// а не ключ зоны хранения: у того на статистику прав нет. Вживую не проверено —
// аккаунта у заказчика пока нет; поля взяты из справочника API.
//
// Ответы кэшируются на десять минут: вкладку расходов открывают и
// переоткрывают, а поставщикам незачем получать запрос на каждый клик.

const errorLog = require('./errorLog');

// Daily обычно отвечает за секунду, но изредка запрос виснет на десятки
// секунд (замерено: один из пяти одинаковых — 42 с). Поэтому короткий
// предел и один повтор, а не длинный предел: повтор приходит быстрее.
const TIMEOUT_MS = 8000;
const CACHE_MS = 10 * 60 * 1000;
// Потолок на перебор встреч: 50 страниц по 100 — пять тысяч встреч за период.
// Дальше счёт помечается неполным, а не висит минуту.
const DAILY_PAGES_MAX = 50;

const cache = new Map();

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.value, cachedAt: new Date(hit.at) };
  const value = await fn();
  // Ошибку не кэшируем: иначе один зависший запрос прятал бы сверку
  // на десять минут, хотя следующий, скорее всего, прошёл бы.
  if (!value.error) cache.set(key, { at: Date.now(), value });
  return { ...value, cachedAt: new Date() };
}

async function getJson(url, headers, what, retry = true) {
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    if (retry && err.name === 'TimeoutError') return getJson(url, headers, what, false);
    throw new Error(`${what}: ${err.name === 'TimeoutError' ? 'нет ответа за ' + TIMEOUT_MS / 1000 + ' с' : err.message}`);
  }
  if (!res.ok) {
    const err = new Error(`${what}: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Вид комнаты — по префиксу имени: так их называет код, который их создаёт
// (utils/webLive.js и streams — stream_, звонки — call_, камеры — venue_).
function kindOf(room) {
  const prefix = String(room || '').split('_')[0];
  return ['stream', 'call', 'venue'].includes(prefix) ? prefix : 'other';
}

// ── Daily ────────────────────────────────────────────────────────────────────
function daily(from, to) {
  if (!process.env.DAILY_API_KEY) return Promise.resolve({ configured: false });

  const start = Math.floor(from.getTime() / 1000);
  const end = Math.floor(to.getTime() / 1000);

  return cached(`daily:${Math.floor(start / 600)}:${Math.floor(end / 600)}`, async () => {
    const kinds = {};
    const add = (kind) => (kinds[kind] = kinds[kind] || { meetings: 0, participantSeconds: 0, peak: 0 });
    let after = '';
    let pages = 0;
    let complete = true;
    let ongoing = 0;

    try {
      for (;;) {
        const q = new URLSearchParams({ limit: '100', timeframe_start: String(start), timeframe_end: String(end) });
        if (after) q.set('starting_after', after);
        const page = await getJson('https://api.daily.co/v1/meetings?' + q, { Authorization: `Bearer ${process.env.DAILY_API_KEY}` }, 'Daily meetings');
        const rows = page.data || [];

        for (const m of rows) {
          const k = add(kindOf(m.room));
          k.meetings += 1;
          k.peak = Math.max(k.peak, m.max_participants || 0);
          if (m.ongoing) ongoing += 1;
          for (const p of m.participants || []) k.participantSeconds += p.duration || 0;
        }

        pages += 1;
        if (rows.length < 100) break;
        if (pages >= DAILY_PAGES_MAX) { complete = false; break; }
        after = rows[rows.length - 1].id;
      }
    } catch (err) {
      errorLog.external(err, 'usage.daily');
      return { configured: true, error: err.message };
    }

    const minutes = (s) => Math.round(s / 60);
    const total = Object.values(kinds).reduce((n, k) => n + k.participantSeconds, 0);
    // Цена минуты — по тарифу заказчика, в коде её нет: задаётся переменной,
    // иначе показываем только минуты, а не придуманные деньги.
    const rate = Number(process.env.DAILY_USD_PER_MINUTE) || 0;

    return {
      configured: true,
      complete,
      ongoing,
      kinds: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, { meetings: v.meetings, minutes: minutes(v.participantSeconds), peak: v.peak }])),
      minutes: minutes(total),
      usd: rate ? Math.round(minutes(total) * rate * 100) / 100 : null,
    };
  });
}

// ── Bunny ────────────────────────────────────────────────────────────────────
function bunny(from, to) {
  if (!process.env.BUNNY_API_KEY) return Promise.resolve({ configured: false });

  const headers = { AccessKey: process.env.BUNNY_API_KEY, Accept: 'application/json' };
  const day = (d) => d.toISOString().slice(0, 10);

  return cached(`bunny:${day(from)}:${day(to)}`, async () => {
    try {
      const q = new URLSearchParams({
        dateFrom: from.toISOString(),
        dateTo: to.toISOString(),
        loadBandwidthUsed: 'true',
        loadRequestsServed: 'true',
        loadUserBalanceHistory: 'true',
      });
      if (process.env.BUNNY_PULL_ZONE_ID) q.set('pullZone', process.env.BUNNY_PULL_ZONE_ID);

      const [stats, zones] = await Promise.all([
        getJson('https://api.bunny.net/statistics?' + q, headers, 'Bunny statistics'),
        process.env.BUNNY_STORAGE_ZONE
          ? getJson('https://api.bunny.net/storagezone?' + new URLSearchParams({ search: process.env.BUNNY_STORAGE_ZONE }), headers, 'Bunny storagezone')
          : [],
      ]);

      // История баланса — сумма на счёте по дням. Расход — сумма дневных
      // уменьшений: пополнение счёта даёт рост, и простая разница первого
      // и последнего дня его бы вычла из расхода.
      const balance = Object.entries(stats.UserBalanceHistoryChart || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, v]) => Number(v) || 0);
      let spent = 0;
      for (let i = 1; i < balance.length; i++) if (balance[i] < balance[i - 1]) spent += balance[i - 1] - balance[i];

      const list = Array.isArray(zones) ? zones : zones.Items || [];
      const zone = list.find((z) => z.Name === process.env.BUNNY_STORAGE_ZONE) || null;

      return {
        configured: true,
        bandwidthBytes: stats.TotalBandwidthUsed || 0,
        requests: stats.TotalRequestsServed || 0,
        cacheHitRate: stats.CacheHitRate != null ? Math.round(stats.CacheHitRate * 10) / 10 : null,
        spentUsd: balance.length > 1 ? Math.round(spent * 100) / 100 : null,
        balanceUsd: balance.length ? Math.round(balance[balance.length - 1] * 100) / 100 : null,
        // Копий — основная плюс реплики в других регионах: хранение
        // оплачивается за каждую (utils/storageReport.js).
        storage: zone ? {
          bytes: zone.StorageUsed || 0, files: zone.FilesStored || 0, region: zone.Region || '',
          copies: 1 + (zone.ReplicationRegions || []).length,
        } : null,
        pullZone: process.env.BUNNY_PULL_ZONE_ID || null,
      };
    } catch (err) {
      errorLog.external(err, 'usage.bunny');
      return { configured: true, error: err.message };
    }
  });
}

module.exports = { daily, bunny, kindOf };
