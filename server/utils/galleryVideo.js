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
const { encode, schedule } = require('./videoEncode');
const { stamp } = require('./watermark');
const GalleryVideo = require('../models/GalleryVideo');

// Обложка своя — под плитку галереи и постер плеера.
const COVER = { width: 1280, height: 1280 };

const MAX_SECONDS = 60 * 60;
// По весу предела для человека нет — только по длительности. 8 ГБ —
// технический потолок, чтобы один файл не забил диск сервера.
const MAX_MB = 8192;
const MAX_PER_USER = 30;
const CHUNK_MB = 8;
// Недокачанное и неопубликованное живёт столько, потом убирается.
const DRAFT_DAYS = 3;
const UPLOAD_DIR = path.join(__dirname, '..', 'media', 'upload');
const partPath = (id) => path.join(UPLOAD_DIR, `${id}.part`);
const coverPath = (id) => path.join(UPLOAD_DIR, `${id}.cover`);

async function convert(doc, src) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `tk-gv-${doc._id}-`));
  const base = `gallery/${doc.userId}/${doc._id}`;
  const uploaded = [];
  try {
    const out = await encode(src, dir, { maxSeconds: MAX_SECONDS, log: { video: String(doc._id) }, edit: doc.edit || {} });
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
  } catch (e) {
    await Promise.all(uploaded.map((k) => storage.remove(k).catch(() => {})));
    if (!e.reason) errorLog.media(e, 'gallery.video', { video: String(doc._id) });
    await GalleryVideo.updateOne({ _id: doc._id }, { $set: { status: 'failed', error: e.reason || 'convert' } }).catch(() => {});
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

// Принятый файл (временный, на диске) — в общую очередь. Файл удаляется после.
function enqueue(doc, src) {
  schedule(() => convert(doc, src));
}

// Файл доехал и «Опубликовать» нажато — в очередь пережатия. Условие
// в запросе делает это один раз, даже если последний кусок и публикация
// пришли одновременно.
async function publishIfReady(id) {
  const doc = await GalleryVideo.findOneAndUpdate(
    { _id: id, status: 'draft', publish: true },
    { $set: { status: 'processing' } },
    { new: true },
  ).lean();
  if (doc) enqueue(doc, partPath(id));
  return doc;
}

async function remove(doc) {
  await Promise.all([doc.video && doc.video.key, doc.thumb && doc.thumb.key].filter(Boolean).map((k) => storage.remove(k)));
  await GalleryVideo.deleteOne({ _id: doc._id });
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
  const old = await GalleryVideo.find({
    status: { $in: ['uploading', 'draft'] },
    createdAt: { $lt: new Date(Date.now() - DRAFT_DAYS * 864e5) },
  }).lean().catch(() => []);
  for (const doc of old) await remove(doc).catch((e) => errorLog.server(e, 'gallery.sweepDrafts'));
}

module.exports = {
  enabled: storage.enabled, MAX_SECONDS, MAX_MB, MAX_PER_USER, CHUNK_MB,
  partPath, coverPath, enqueue, publishIfReady, remove, sweep, sweepDrafts,
};
