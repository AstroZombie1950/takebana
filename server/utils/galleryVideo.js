// Видео галереи профиля: пережатие со знаком и выгрузка в хранилище.
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
const GalleryVideo = require('../models/GalleryVideo');

const MAX_SECONDS = 60 * 60;
// По весу предела для человека нет — только по длительности. 8 ГБ —
// технический потолок, чтобы один файл не забил диск сервера.
const MAX_MB = 8192;
const MAX_PER_USER = 30;

async function convert(doc, src) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `tk-gv-${doc._id}-`));
  const base = `gallery/${doc.userId}/${doc._id}`;
  const uploaded = [];
  try {
    const out = await encode(src, dir, { maxSeconds: MAX_SECONDS, log: { video: String(doc._id) } });
    const videoUrl = await storage.put(out.video, `${base}.mp4`, 'video/mp4');
    uploaded.push(`${base}.mp4`);
    let thumbUrl = '';
    if (out.thumb) {
      thumbUrl = await storage.put(out.thumb, `${base}.jpg`, 'image/jpeg');
      uploaded.push(`${base}.jpg`);
    }

    // Ролик могли удалить, пока он пережимался, — тогда убираем и файлы.
    const saved = await GalleryVideo.findOneAndUpdate({ _id: doc._id }, {
      $set: {
        status: 'ready', duration: out.duration, size: out.bytes,
        video: { url: videoUrl, key: `${base}.mp4` },
        thumb: { url: thumbUrl, key: thumbUrl ? `${base}.jpg` : '' },
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
  }
}

// Принятый файл (временный, на диске) — в общую очередь. Файл удаляется после.
function enqueue(doc, src) {
  schedule(() => convert(doc, src));
}

async function remove(doc) {
  await Promise.all([doc.video && doc.video.key, doc.thumb && doc.thumb.key].filter(Boolean).map((k) => storage.remove(k)));
  await GalleryVideo.deleteOne({ _id: doc._id });
}

// При запуске: пережатие, оборванное перезапуском, уже не доделать —
// временного файла больше нет.
async function sweep() {
  await GalleryVideo.updateMany({ status: 'processing' }, { $set: { status: 'failed', error: 'restart' } }).catch(() => {});
}

module.exports = { enabled: storage.enabled, MAX_SECONDS, MAX_MB, MAX_PER_USER, enqueue, remove, sweep };
