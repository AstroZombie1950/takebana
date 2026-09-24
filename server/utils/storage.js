// Хранилище записей эфиров. Видео на диске VPS не живёт (решение в
// docs/STATUS.md): час записи — около 1,2 ГБ, диск сервера кончится за сотню
// часов. Поэтому на бою — Bunny Storage, раздача через pull zone Bunny.
//
// Bunny Storage — все четыре переменные в .env (см. .env.example).
// Без них локально — папка public/uploads/recordings, её отдаёт express.static;
// на бою без них записи выключены: кнопки «Сохранить запись» нет.
//
// Ключ файла — путь внутри хранилища: recordings/<userId>/<id>.mp4.

const fs = require('fs');
const path = require('path');
const errorLog = require('./errorLog');

const PROD = process.env.START_SERVER === 'prod' || process.env.NODE_ENV === 'production';
const LOCAL_ROOT = path.join(__dirname, '..', 'public', 'uploads');

const bunny = {
  zone: process.env.BUNNY_STORAGE_ZONE,
  key: process.env.BUNNY_STORAGE_KEY,
  // Адрес API своего региона: https://storage.bunnycdn.com (Фалькенштайн)
  // или https://uk.storage.bunnycdn.com и т. п. — берётся из панели зоны.
  endpoint: (process.env.BUNNY_STORAGE_ENDPOINT || '').replace(/\/+$/, ''),
  // Pull zone, подключённая к зоне хранилища: https://vod.takebana.com.
  cdn: (process.env.RECORDINGS_CDN_URL || '').replace(/\/+$/, ''),
};
const useBunny = !!(bunny.zone && bunny.key && bunny.endpoint && bunny.cdn);

const driver = useBunny ? 'bunny' : PROD ? null : 'local';

if (PROD && !useBunny) {
  console.warn('[storage] BUNNY_STORAGE_* и RECORDINGS_CDN_URL не заданы: записи эфиров выключены');
}

function objectUrl(key) {
  return `${bunny.endpoint}/${encodeURIComponent(bunny.zone)}/${key}`;
}

async function checked(res, what) {
  if (res.ok || (what === 'DELETE' && res.status === 404)) return;
  const text = await res.text().catch(() => '');
  throw new Error(`Bunny ${what} ${res.status}: ${text.slice(0, 200)}`);
}

// Выгрузка в Bunny идёт по сети и может встать: медленный канал, таймаут,
// отказ зоны. Раньше об этом узнавал только тот, кому не повезло, — исключение
// всплывало наверх и в лучшем случае становилось 500. Теперь каждая неудача
// и каждая слишком долгая выгрузка попадают в журнал с ключом и размером:
// по ним видно, наше это, сети или Bunny.
const SLOW_PUT_MS = 20000;

// Файл с диска — в хранилище. Возвращает адрес, по которому его смотрят.
async function put(file, key, contentType) {
  if (driver === 'bunny') {
    const { size } = await fs.promises.stat(file);
    const startedAt = Date.now();
    let res;
    try {
      res = await fetch(objectUrl(key), {
        method: 'PUT',
        headers: { AccessKey: bunny.key, 'Content-Type': contentType, 'Content-Length': String(size) },
        body: fs.createReadStream(file),
        duplex: 'half',
        // Без предела зависшее соединение держало задание очереди пережатия
        // вечно — и вставала вся обработка видео. Минута плюс секунда на
        // мегабайт: час видео (~1 ГБ) — до 18 минут, этого хватает с запасом.
        signal: AbortSignal.timeout(60000 + Math.ceil(size / 1048576) * 1000),
      });
      await checked(res, 'PUT');
    } catch (e) {
      errorLog.external(e, 'storage.put', { key, mb: +(size / 1048576).toFixed(2), ms: Date.now() - startedAt });
      throw e;
    }
    const ms = Date.now() - startedAt;
    if (ms > SLOW_PUT_MS) {
      errorLog.external(new Error(`выгрузка заняла ${Math.round(ms / 1000)} с`), 'storage.put.slow',
        { key, mb: +(size / 1048576).toFixed(2), ms });
    }
    return `${bunny.cdn}/${key}`;
  }
  if (driver === 'local') {
    const target = path.join(LOCAL_ROOT, key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(file, target);
    return `/uploads/${key}`;
  }
  throw new Error('хранилище записей не настроено');
}

// Удаление из хранилища CDN не касается: pull zone записей держит файл
// в кэше месяц, и удалённая запись по прямой ссылке продолжала бы играть
// (проверено 16.09.2026). Поэтому следом — сброс кэша по адресу, ключом
// аккаунта (BUNNY_API_KEY): у пароля зоны на это прав нет. Кэш у pull zone
// один на все её адреса, сброс по одному снимает файл и с остальных.
async function purge(key) {
  if (!process.env.BUNNY_API_KEY) {
    console.warn(`[storage] BUNNY_API_KEY не задан: ${key} удалён из хранилища, но остаётся в кэше CDN`);
    return;
  }
  const q = new URLSearchParams({ url: `${bunny.cdn}/${key}`, async: 'false' });
  const res = await fetch(`https://api.bunny.net/purge?${q}`, {
    method: 'POST',
    headers: { AccessKey: process.env.BUNNY_API_KEY },
    signal: AbortSignal.timeout(15000),
  });
  await checked(res, 'PURGE');
}

async function remove(key) {
  if (!key) return;
  if (driver === 'bunny') {
    await checked(await fetch(objectUrl(key), { method: 'DELETE', headers: { AccessKey: bunny.key }, signal: AbortSignal.timeout(15000) }), 'DELETE');
    await purge(key);
  } else if (driver === 'local') {
    await fs.promises.rm(path.join(LOCAL_ROOT, key), { force: true });
  }
}

// Содержимое папки хранилища (только Bunny): для сводки места в панели
// (utils/storageReport.js). prefix — '' или 'recordings/…/', со слешем
// на конце. Папки приходят отдельно от файлов; размер и дата — у файлов.
async function list(prefix) {
  if (driver !== 'bunny') throw new Error('список есть только у Bunny');
  const res = await fetch(`${objectUrl(prefix)}${prefix && !prefix.endsWith('/') ? '/' : ''}`, {
    headers: { AccessKey: bunny.key, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  await checked(res, 'LIST');
  return (await res.json()).map((o) => ({
    name: o.ObjectName,
    dir: !!o.IsDirectory,
    size: o.Length || 0,
    at: new Date(o.DateCreated + (/Z|[+-]\d\d:?\d\d$/.test(o.DateCreated) ? '' : 'Z')),
  }));
}

module.exports = { enabled: !!driver, driver, put, remove, list };
