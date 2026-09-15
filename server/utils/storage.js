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

// Файл с диска — в хранилище. Возвращает адрес, по которому его смотрят.
async function put(file, key, contentType) {
  if (driver === 'bunny') {
    const { size } = await fs.promises.stat(file);
    const res = await fetch(objectUrl(key), {
      method: 'PUT',
      headers: { AccessKey: bunny.key, 'Content-Type': contentType, 'Content-Length': String(size) },
      body: fs.createReadStream(file),
      duplex: 'half',
    });
    await checked(res, 'PUT');
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

async function remove(key) {
  if (!key) return;
  if (driver === 'bunny') {
    await checked(await fetch(objectUrl(key), { method: 'DELETE', headers: { AccessKey: bunny.key } }), 'DELETE');
  } else if (driver === 'local') {
    await fs.promises.rm(path.join(LOCAL_ROOT, key), { force: true });
  }
}

module.exports = { enabled: !!driver, driver, put, remove };
