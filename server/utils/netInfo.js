// Страна и провайдер по IP — для телеметрии (models/Trace.js).
//
// Зачем. Жалоба «не открывается без VPN» без страны и провайдера не
// разбирается: тесты 01.10 шли из России, и понять это получилось только
// по часовому поясу в журналах Daily (docs/STATUS.md, 2 октября).
//
// Откуда. Базы DB-IP Lite (страна и ASN), файлы .mmdb — локально, без
// запроса наружу на каждую запись. Лицензия CC BY 4.0: в панели, где это
// показывается, стоит подпись «IP Geolocation by DB-IP». Сервер сам берёт
// свежие раз в месяц (новые выходят в начале месяца); не скачалось — работает
// со старыми, а без них просто не заполняет поля. Вне боя не качает, если
// не задано GEOIP=1: зонды и стенд не должны ходить наружу.
//
// «Похоже на VPN» — догадка, а не факт, и в панели так и подписана: адрес
// принадлежит хостингу или облаку (у людей дома таких не бывает), либо часовой
// пояс браузера не совпадает со страной адреса там, где это видно надёжно, —
// Москва в браузере и Германия по адресу.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Reader } = require('mmdb-lib');
const errorLog = require('./errorLog');

const DIR = path.join(__dirname, '..', 'media', 'geo');
const KINDS = ['asn', 'country'];
const MAX_AGE_MS = 35 * 86400000;
const DAY_MS = 86400000;
const enabled = process.env.GEOIP === '1' || (process.env.GEOIP !== '0' && process.env.NODE_ENV === 'production');

const readers = {};

const file = (kind) => path.join(DIR, `dbip-${kind}-lite.mmdb`);

function open(kind) {
  try {
    readers[kind] = new Reader(fs.readFileSync(file(kind)));
  } catch (e) {
    if (e.code !== 'ENOENT') errorLog.server(e, 'netInfo.open', { kind });
  }
}

const month = (d) => d.toISOString().slice(0, 7);

// Файл текущего месяца DB-IP выкладывает в первые дни месяца: нет его — берём прошлый.
async function download(kind) {
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  for (const m of [month(now), month(prev)]) {
    const res = await fetch(`https://download.db-ip.com/free/dbip-${kind}-lite-${m}.mmdb.gz`, { signal: AbortSignal.timeout(120000) });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`DB-IP ${kind}: HTTP ${res.status}`);
    const data = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
    new Reader(data); // битый файл — исключение здесь, а не у работающего читателя
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file(kind) + '.next', data);
    fs.renameSync(file(kind) + '.next', file(kind));
    return;
  }
  throw new Error(`DB-IP ${kind}: нет файла ни за этот, ни за прошлый месяц`);
}

async function refresh() {
  for (const kind of KINDS) {
    let age = Infinity;
    try { age = Date.now() - fs.statSync(file(kind)).mtimeMs; } catch (e) { /* файла нет */ }
    if (age < MAX_AGE_MS) continue;
    try {
      await download(kind);
      open(kind);
    } catch (e) {
      errorLog.external(e, 'netInfo.download', { kind });
    }
  }
}

KINDS.forEach(open);
if (enabled) {
  refresh();
  setInterval(refresh, DAY_MS).unref();
}

// Облака и хостинги — по названию владельца сети. Список коротким намеренно:
// он только подсвечивает, а ошибка в нём ничего не ломает.
const HOSTING = /amazon|google|microsoft|azure|digitalocean|hetzner|ovh|linode|akamai|vultr|contabo|leaseweb|m247|datacamp|melbicom|choopa|cloudflare|oracle|alibaba|tencent|scaleway|hostinger|hosting|server|cloud|data ?cent|vpn|proxy/i;

// Часовые пояса, по которым страна видна однозначно. Только там, где это
// нужно: аудитория, у которой режут сервисы и которая ходит через VPN.
const TZ_COUNTRY = {
  'Europe/Moscow': 'RU', 'Europe/Samara': 'RU', 'Europe/Volgograd': 'RU', 'Europe/Kaliningrad': 'RU',
  'Asia/Yekaterinburg': 'RU', 'Asia/Omsk': 'RU', 'Asia/Novosibirsk': 'RU', 'Asia/Krasnoyarsk': 'RU',
  'Asia/Irkutsk': 'RU', 'Asia/Yakutsk': 'RU', 'Asia/Vladivostok': 'RU', 'Asia/Magadan': 'RU',
  'Europe/Minsk': 'BY', 'Europe/Kyiv': 'UA', 'Europe/Kiev': 'UA', 'Asia/Almaty': 'KZ',
};

// { country, asn, org, vpn } — пустые поля, если баз нет или адрес частный.
function lookup(ip, tz) {
  const out = { country: '', asn: 0, org: '', vpn: false };
  const addr = String(ip || '').replace(/^::ffff:/, '');
  if (!addr) return out;
  try {
    const c = readers.country && readers.country.get(addr);
    if (c && c.country) out.country = c.country.iso_code || '';
    const a = readers.asn && readers.asn.get(addr);
    if (a) {
      out.asn = a.autonomous_system_number || 0;
      out.org = String(a.autonomous_system_organization || '').slice(0, 80);
    }
  } catch (e) {
    return out; // не адрес — ничего не знаем
  }
  const home = TZ_COUNTRY[tz];
  out.vpn = HOSTING.test(out.org) || !!(home && out.country && home !== out.country);
  return out;
}

module.exports = { lookup, ready: () => !!(readers.asn || readers.country) };
