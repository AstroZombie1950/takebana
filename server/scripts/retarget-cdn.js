// Перенос адресов медиа на новый домен раздачи.
//
//   node scripts/retarget-cdn.js --from https://takebana-vod.b-cdn.net
//   node scripts/retarget-cdn.js --from https://takebana-vod.b-cdn.net --apply
//
// Куда переносим — из RECORDINGS_CDN_URL в .env (или явно, --to).
//
// Зачем. Адрес файла пишется в базу целиком в момент загрузки: put() в
// utils/storage.js возвращает `${cdn}/${key}`, и это значение уходит в документ.
// Поэтому смена RECORDINGS_CDN_URL действует только на новые загрузки — всё,
// что уже лежит, продолжает ссылаться на прежний домен. Здесь переписывается
// начало адреса у старых записей.
//
// Ключ файла не меняется — значит новый домен обязан вести на ту же зону
// хранилища. Если это не так, не запускайте: ссылки станут вести в пустоту.
// Проверить просто: открыть любой существующий файл по новому домену руками.
//
// Чего скрипт НЕ трогает: recordings.hls.files — там лежат ключи внутри
// хранилища, а не адреса (utils/recordingHls.js), и домена в них нет вовсе.

const mongoose = require('mongoose');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : '';
}

const trim = (u) => String(u || '').replace(/\/+$/, '');
const FROM = trim(arg('--from') || process.env.CDN_OLD_URL);
const TO = trim(arg('--to') || process.env.RECORDINGS_CDN_URL);

// Две формы хранения, и обновляются они по-разному.
//   scalar — обычное поле документа;
//   array  — поля внутри массива поддокументов: их правит $map, потому что
//            `$attachments.url` в конвейере даёт массив строк, а не строку.
const TARGETS = [
  { collection: 'messages', array: 'attachments', keys: ['url', 'preview'] },
  { collection: 'recordings', scalar: ['video.url', 'thumb.url', 'hls.url'] },
  { collection: 'galleryvideos', scalar: ['video.url', 'poster.url'] },
];

function die(message) {
  console.error('✗ ' + message);
  process.exit(1);
}

// Выражение: строка начинается со старого домена — заменить начало,
// иначе оставить как есть. Пустое и отсутствующее поле не портим:
// $replaceOne на не-строке роняет весь запрос.
const swap = (ref) => ({
  $cond: [
    { $eq: [{ $type: ref }, 'string'] },
    { $replaceOne: { input: ref, find: FROM, replacement: TO } },
    ref,
  ],
});

async function run(db, target) {
  const { collection } = target;
  const fields = target.array ? target.keys.map((k) => `${target.array}.${k}`) : target.scalar;
  const filter = { $or: fields.map((f) => ({ [f]: { $regex: '^' + FROM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } })) };

  let found;
  try {
    found = await db.collection(collection).countDocuments(filter);
  } catch (e) {
    console.log(`  ${collection}: пропущено (${e.message})`);
    return 0;
  }
  if (!found) return 0;

  if (!APPLY) {
    console.log(`  ${collection}: ${found} док. (${fields.join(', ')})`);
    return found;
  }

  const set = target.array
    ? {
        [target.array]: {
          $map: {
            input: `$${target.array}`,
            as: 'x',
            in: { $mergeObjects: ['$$x', Object.fromEntries(target.keys.map((k) => [k, swap(`$$x.${k}`)]))] },
          },
        },
      }
    : Object.fromEntries(target.scalar.map((f) => [f, swap(`$${f}`)]));

  const res = await db.collection(collection).updateMany(filter, [{ $set: set }]);
  console.log(`  ${collection}: ${res.modifiedCount} из ${found}`);
  return found;
}

async function main() {
  if (!FROM) die('не задан прежний домен: --from https://takebana-vod.b-cdn.net');
  if (!TO) die('не задан новый домен: --to https://vod.takebana.com (или RECORDINGS_CDN_URL в .env)');
  if (FROM === TO) die('прежний и новый домен совпадают — менять нечего');
  if (!process.env.MONGODB_URI) die('нет MONGODB_URI');

  console.log(`  было: ${FROM}`);
  console.log(`станет: ${TO}`);
  console.log(APPLY ? '\nРежим: переписываем.\n' : '\nРежим: только счёт. Для записи добавьте --apply.\n');

  await mongoose.connect(process.env.MONGODB_URI);
  let total = 0;
  for (const target of TARGETS) total += await run(mongoose.connection.db, target);
  console.log(total ? `\nВсего документов: ${total}` : '\nСтарых адресов не нашлось — переносить нечего.');
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
