// Видео галереи профиля: приём кусками, пережатие со знаком и выгрузка
// в хранилище.
//
// С 21.09.2026 видео приходит со страницы загрузки (/upload,
// routes/streaming/upload.js) кусками по CHUNK_MB и копится в
// media/upload/<id>.part: оборвалась сеть, человек ушёл на другую
// страницу — докачка продолжается с того же байта (public/tk-upload.js).
// Раньше файл шёл одним запросом со страницы профиля, и уход с неё
// обрывал загрузку целиком (жалоба заказчика на 400 МБ видео).
//
// Само пережатие — utils/videoEncode.js, общее с вложениями переписки.
// Хранилище — Bunny (utils/storage.js; решение «куда грузим файлы» 17.09),
// ключ gallery/<userId>/<id>.mp4. Ролик — до часа (решение 21.09.2026,
// было 10 минут); пережимается примерно за свою длительность.

const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('./storage');
const errorLog = require('./errorLog');
const indexNow = require('./indexNow');
const uploadTrace = require('./uploadTrace');
const engagement = require('./engagement');
const { encode, schedule } = require('./videoEncode');
const { stamp } = require('./watermark');
const GalleryVideo = require('../models/GalleryVideo');
const limits = require('./limits');

// Обложка своя — под плитку галереи и постер плеера.
const COVER = { width: 1280, height: 1280 };

// Длина, вес и число роликов — из панели, свои у человека (utils/limits.js,
// с 15.10; было час, 8 ГБ и 30). Незаконченное (uploading + draft) лежит
// на диске сервера, а не в Bunny: сумма заявленных размеров на человека —
// не больше двух роликов по потолку (limits.pendingBytes, AUDIT-2026-10-14, S8).
// Название и описание — те же пределы, что у записи эфира (routes/watch.js).
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 5000;
const CHUNK_MB = 8;
// Недокачанное и неопубликованное живёт сутки, потом убирается (было трое
// суток до 14.10, AUDIT-2026-10-14, S8): брошенная загрузка дольше места
// не держит. Едущий файл считается от последнего куска, а не от начала —
// восемь гигабайт по мобильной сети едут и дольше суток.
const DRAFT_DAYS = 1;
const UPLOAD_DIR = path.join(__dirname, '..', 'media', 'upload');
const partPath = (id) => path.join(UPLOAD_DIR, `${id}.part`);
const coverPath = (id) => path.join(UPLOAD_DIR, `${id}.cover`);

// queuedAt — когда встал в очередь: ожидание — тоже часть пути ролика.
async function convert(doc, src, queuedAt = Date.now()) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `tk-gv-${doc._id}-`));
  const base = `gallery/${doc.userId}/${doc._id}`;
  const uploaded = [];
  const t = { queueMs: Date.now() - queuedAt };
  let at = Date.now();
  try {
    const out = await encode(src, dir, { maxSeconds: limits.videoSeconds(await limits.forUser(doc.userId)), log: { video: String(doc._id) }, edit: doc.edit || {} });
    t.encodeMs = Date.now() - at;
    at = Date.now();
    const videoUrl = await storage.put(out.video, `${base}.mp4`, 'video/mp4');
    uploaded.push(`${base}.mp4`);
    // Обложка: своя картинка человека — со знаком, как всё на сайте
    // (utils/watermark.js); иначе кадр, снятый при пережатии.
    let thumbUrl = '';
    let thumbKey = '';
    const own = doc.edit && doc.edit.cover ? await ownCover(doc._id, dir) : '';
    if (own) {
      thumbKey = `${base}.webp`;
      thumbUrl = await storage.put(own, thumbKey, 'image/webp');
    } else if (out.thumb) {
      thumbKey = `${base}.jpg`;
      thumbUrl = await storage.put(out.thumb, thumbKey, 'image/jpeg');
    }
    if (thumbKey) uploaded.push(thumbKey);

    // Ролик могли удалить, пока он пережимался, — тогда убираем и файлы.
    const saved = await GalleryVideo.findOneAndUpdate({ _id: doc._id }, {
      $set: {
        status: 'ready', duration: out.duration, size: out.bytes,
        video: { url: videoUrl, key: `${base}.mp4` },
        thumb: { url: thumbUrl, key: thumbKey },
      },
    });
    if (!saved) await Promise.all(uploaded.map((k) => storage.remove(k).catch(() => {})));
    else indexNow.ping('/video/' + doc._id);
    uploadTrace.done('upload', doc._id, { ...t, storeMs: Date.now() - at, kb: Math.round((out.bytes || 0) / 1024), outcome: 'ok' });
    if (doc.post) await require('./posts').videoDone(doc.post);
  } catch (e) {
    await Promise.all(uploaded.map((k) => storage.remove(k).catch(() => {})));
    uploadTrace.done('upload', doc._id, { ...t, outcome: 'fail', reason: e.reason || (t.encodeMs == null ? 'encode' : 'store') });
    if (!e.reason) errorLog.media(e, 'gallery.video', { video: String(doc._id) });
    await GalleryVideo.updateOne({ _id: doc._id }, { $set: { status: 'failed', error: e.reason || 'convert' } }).catch(() => {});
    // Ролик поста не вышел — пост выходит без него (utils/posts.js).
    if (doc.post) await require('./posts').videoDone(doc.post).catch((err) => errorLog.server(err, 'posts.videoDone'));
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(src, { force: true }).catch(() => {});
    await fs.promises.rm(coverPath(doc._id), { force: true }).catch(() => {});
  }
}

// Своя обложка — в webp со знаком. Не разобралась — берём кадр из видео.
async function ownCover(id, dir) {
  try {
    const out = path.join(dir, 'cover.webp');
    await fs.promises.writeFile(out, (await stamp(await fs.promises.readFile(coverPath(id)), COVER, 82)).data);
    return out;
  } catch (e) {
    errorLog.media(e, 'gallery.cover', { video: String(id) });
    return '';
  }
}

// Принятый файл (временный, на диске) — в очередь галереи, отдельную от
// переписки (videoEncode.js). Файл удаляется после.
function enqueue(doc, src) {
  const queuedAt = Date.now();
  schedule(() => convert(doc, src, queuedAt), { lane: 'gallery', owner: doc.userId });
}

// Файл доехал и «Опубликовать» нажато — в очередь пережатия. Условие
// в запросе делает это один раз, даже если последний кусок и публикация
// пришли одновременно.
async function publishIfReady(id) {
  const doc = await GalleryVideo.findOneAndUpdate(
    { _id: id, status: 'draft', publish: true },
    { $set: { status: 'processing' } },
    { returnDocument: 'after' },
  ).lean();
  if (doc) enqueue(doc, partPath(id));
  return doc;
}

// Вместе с видео — его оценки, комментарии, просмотры и жалобы
// (utils/engagement.js).
// Ролик, отправленный в переписку из библиотеки, остаётся ей (utils/library.js).
async function remove(doc) {
  const kept = doc.video && await require('./library').handOver(doc.video.url);
  if (!kept) await Promise.all([doc.video && doc.video.key, doc.thumb && doc.thumb.key].filter(Boolean).map((k) => storage.remove(k)));
  await Promise.all([
    GalleryVideo.deleteOne({ _id: doc._id }),
    engagement.forgetTarget(doc._id, 'video'),
  ]);
  // Видео из поста — и из поста (utils/posts.js).
  if (doc.post) await require('./posts').mediaGone(doc.post, doc._id);
  // Недокачанное и неопубликованное лежит у нас на диске.
  if (doc.status === 'uploading' || doc.status === 'draft') {
    await Promise.all([partPath(doc._id), coverPath(doc._id)].map((f) => fs.promises.rm(f, { force: true }).catch(() => {})));
  }
}

// При запуске: пережатие, оборванное перезапуском, начинается заново —
// исходник лежит в media/upload, а не во временной папке системы. Нет
// исходника — не вышло. Загрузки и черновики переживают перезапуск так же.
async function sweep() {
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {});
  const cut = await GalleryVideo.find({ status: 'processing' }).lean().catch(() => []);
  for (const doc of cut) {
    if (fs.existsSync(partPath(doc._id))) enqueue(doc, partPath(doc._id));
    else await GalleryVideo.updateOne({ _id: doc._id }, { $set: { status: 'failed', error: 'restart' } }).catch(() => {});
  }
  await sweepDrafts();
  setInterval(sweepDrafts, 6 * 3600 * 1000).unref();
}

// Брошенные загрузки и черновики старше DRAFT_DAYS — вон вместе с файлом.
async function sweepDrafts() {
  const cutoff = new Date(Date.now() - DRAFT_DAYS * 864e5);
  let old = [];
  try {
    old = await GalleryVideo.find({
      createdAt: { $lt: cutoff },
      $or: [{ status: 'draft' }, { status: 'uploading', 'upload.at': { $not: { $gte: cutoff } } }],
    }).lean();
  } catch (e) {
    return errorLog.server(e, 'gallery.sweepDrafts');
  }
  let removed = 0;
  let bytes = 0;
  for (const doc of old) {
    try {
      await remove(doc);
      removed += 1;
      bytes += (doc.upload && doc.upload.received) || 0;
    } catch (e) {
      errorLog.server(e, 'gallery.sweepDrafts', { video: String(doc._id) });
    }
  }
  if (removed) console.log(`[gallery] убрано брошенных черновиков: ${removed}, ${(bytes / 1048576).toFixed(0)} МБ`);
}

// Сколько байт у человека в незаконченных загрузках (заявлено, не доехало).
async function pendingBytes(userId) {
  const [r] = await GalleryVideo.aggregate([
    { $match: { userId: new GalleryVideo.base.Types.ObjectId(String(userId)), status: { $in: ['uploading', 'draft'] } } },
    { $group: { _id: null, n: { $sum: '$upload.size' } } },
  ]);
  return r ? r.n : 0;
}

module.exports = {
  enabled: storage.enabled, CHUNK_MB, TITLE_MAX, DESCRIPTION_MAX,
  UPLOAD_DIR, partPath, coverPath, enqueue, publishIfReady, remove, sweep, sweepDrafts, pendingBytes,
};
