// Запись эфира.
//
// Пока эфир идёт, HLS-конвейер (utils/hls.js) тем же ffmpeg пишет кусок
// в media/rec/<streamKey>/: без второго кодирования, на каждый запуск свой
// кусок — пауза и обрыв дают новый. Решает ведущий в конце: «Сохранить
// запись» — куски склеиваются в один MP4 (паузы вырезаны сами: во время
// паузы ничего не пишется), к нему снимается кадр-обложка, оба уходят
// в хранилище (utils/storage.js). «Завершить без записи» — куски удаляются.
//
// Место на диске во время эфира: ~1,2 ГБ в час на эфир (720p, 2,5 Мбит/с).
// Куски живут до конца эфира и склейки, дольше — нет.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isPlainFileName } = require('./safePath');
const storage = require('./storage');
const streamLog = require('./streamLog');
const { audit } = require('./audit');
const errorLog = require('./errorLog');
const Recording = require('../models/Recording');
const RecordingReaction = require('../models/RecordingReaction');
const RecordingComment = require('../models/RecordingComment');
const RecordingView = require('../models/RecordingView');
const Report = require('../models/Report');
const recordingHls = require('./recordingHls');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
// ffprobe лежит рядом с ffmpeg: в apt они приходят одним пакетом.
const FFPROBE = process.env.FFMPEG_PATH ? path.join(path.dirname(process.env.FFMPEG_PATH), 'ffprobe') : 'ffprobe';

const REC_ROOT = path.join(__dirname, '..', 'media', 'rec');

function dirFor(streamKey) {
  return isPlainFileName(streamKey) ? path.join(REC_ROOT, streamKey) : null;
}

// Путь нового куска для ffmpeg. null — не пишем (каталог не создать):
// эфир от этого не страдает, только записи не будет.
function newPart(streamKey) {
  const dir = dirFor(streamKey);
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    errorLog.media(e, 'recording.dir', { streamKey });
    return null;
  }
  return path.join(dir, `part-${Date.now()}.ts`);
}

// Куски прошлого эфира этого ключа — при создании нового и без сохранения.
async function discard(streamKey) {
  const dir = dirFor(streamKey);
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(bin)}: ${err.trim().slice(-300) || 'код ' + code}`))));
  });
}

// Склейка, обложка, выгрузка. Идёт после ответа ведущему: на часовом эфире
// копирование — секунды, выгрузка в хранилище — минуты.
async function finalize(rec, dir) {
  const work = path.join(dir, 'out');
  try {
    const parts = (await fs.promises.readdir(dir))
      .filter((n) => /^part-\d+\.ts$/.test(n))
      .sort((a, b) => Number(a.slice(5, -3)) - Number(b.slice(5, -3)));
    // Пустой кусок остаётся от запуска ffmpeg, который не дождался кадра.
    const nonEmpty = [];
    for (const n of parts) {
      if ((await fs.promises.stat(path.join(dir, n))).size > 0) nonEmpty.push(n);
    }
    if (!nonEmpty.length) throw new Error('кусков записи нет');

    await fs.promises.mkdir(work, { recursive: true });
    const list = path.join(work, 'list.txt');
    await fs.promises.writeFile(list, nonEmpty.map((n) => `file '${path.join(dir, n)}'\n`).join(''));

    const video = path.join(work, 'video.mp4');
    const thumb = path.join(work, 'thumb.jpg');
    // faststart — индекс в начале файла: плеер начинает играть, не скачав всё.
    await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', video]);

    const duration = Math.round(Number(await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', video])) || 0);
    // Кадр не с нуля — первая секунда часто чёрная, пока камера просыпается.
    await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(Math.min(3, Math.max(0, duration / 2))), '-i', video, '-frames:v', '1', '-vf', 'scale=640:-2', thumb])
      .catch((e) => errorLog.media(e, 'recording.thumb', { recording: String(rec._id) }));

    const base = `recordings/${rec.userId}/${rec._id}`;
    const { size } = await fs.promises.stat(video);
    const videoUrl = await storage.put(video, `${base}.mp4`, 'video/mp4');
    const thumbUrl = fs.existsSync(thumb) ? await storage.put(thumb, `${base}.jpg`, 'image/jpeg') : '';

    // Запись могли удалить, пока шла выгрузка, — тогда убираем и файлы.
    const saved = await Recording.findOneAndUpdate({ _id: rec._id }, {
      $set: {
        status: 'ready', duration, size,
        video: { url: videoUrl, key: `${base}.mp4` },
        thumb: { url: thumbUrl, key: thumbUrl ? `${base}.jpg` : '' },
      },
    });
    if (!saved) await Promise.all([storage.remove(`${base}.mp4`), storage.remove(`${base}.jpg`)]);
    console.log(`[rec ${rec._id}] готова: ${duration} с, ${(size / 1048576).toFixed(1)} МБ`);

    // Склейка идёт в стороне от запроса, поэтому действие системное — req нет.
    // Размер уходит и в отрезок эфира: на вкладке расходов гигабайты должны
    // сходиться с эфиром, который их породил.
    audit(null, 'recording.ready', { actor: rec.userId, targetType: 'recording', target: rec, meta: { duration, size } });
    streamLog.recordingSize(rec._id, size);
    // Несколько качеств — в фоне; пока их нет, запись играет из MP4.
    if (saved) recordingHls.enqueue(rec._id);
  } catch (e) {
    errorLog.media(e, 'recording.finalize', { recording: String(rec._id) });
    audit(null, 'recording.fail', { actor: rec.userId, result: 'fail', targetType: 'recording', target: rec, meta: { error: e.message } });
    await Recording.updateOne({ _id: rec._id }, { $set: { status: 'failed' } }).catch(() => {});
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Эфир завершён с сохранением. Конвейер к этому моменту остановлен
// (routes/streaming/streams.js ждёт hls.stopped): куски закрыты. Каталог
// сразу переименовывается — следующий эфир того же ключа начнёт писать
// в пустой, пока этот склеивается.
async function save(stream) {
  const dir = dirFor(stream.streamKey);
  const rec = await Recording.create({
    userId: stream.userId,
    title: stream.title,
    description: stream.description || '',
    category: stream.category,
    subcategory: stream.subcategory,
    city: stream.city || '',
    isAdult: !!stream.isAdult,
    recordedAt: stream.firstLiveAt || null,
  });
  const detached = `${dir}.${rec._id}`;
  try {
    await fs.promises.rename(dir, detached);
  } catch (e) {
    await Recording.updateOne({ _id: rec._id }, { $set: { status: 'failed' } });
    errorLog.media(e, 'recording.parts', { recording: String(rec._id) });
    audit(null, 'recording.fail', { actor: rec.userId, result: 'fail', targetType: 'recording', target: rec, meta: { error: 'нет кусков' } });
    return rec;
  }
  finalize(rec, detached);
  return rec;
}

// Запись после склейки — удалить из хранилища и базы.
// Вместе с файлами уходят оценки, комментарии, отметки просмотров и жалобы
// на запись и её комментарии: у них больше нет предмета.
async function remove(rec) {
  const keys = [rec.video && rec.video.key, rec.thumb && rec.thumb.key, ...((rec.hls && rec.hls.files) || [])];
  await Promise.all(keys.filter(Boolean).map((k) => storage.remove(k)));
  const commentIds = await RecordingComment.distinct('_id', { recordingId: rec._id });
  await Promise.all([
    Recording.deleteOne({ _id: rec._id }),
    RecordingReaction.deleteMany({ recordingId: rec._id }),
    RecordingComment.deleteMany({ recordingId: rec._id }),
    RecordingView.deleteMany({ recordingId: rec._id }),
    Report.deleteMany({ $or: [
      { targetType: 'recording', targetId: rec._id },
      { targetType: 'comment', targetId: { $in: commentIds } },
    ] }),
  ]);
}

// Удаление аккаунта: его оценки и комментарии под чужими записями уходят,
// а счётчики тех записей уменьшаются на столько же.
async function forgetUser(userId) {
  const [reactions, comments] = await Promise.all([
    RecordingReaction.find({ userId }).select('recordingId value').lean(),
    RecordingComment.aggregate([{ $match: { userId } }, { $group: { _id: '$recordingId', n: { $sum: 1 } } }]),
  ]);
  const ops = reactions.map((r) => ({
    updateOne: { filter: { _id: r.recordingId }, update: { $inc: r.value === 1 ? { likes: -1 } : { dislikes: -1 } } },
  })).concat(comments.map((c) => ({
    updateOne: { filter: { _id: c._id }, update: { $inc: { comments: -c.n } } },
  })));
  const commentIds = await RecordingComment.distinct('_id', { userId });
  await Promise.all([
    ops.length ? Recording.bulkWrite(ops, { ordered: false }) : null,
    RecordingReaction.deleteMany({ userId }),
    RecordingComment.deleteMany({ userId }),
    Report.deleteMany({ targetType: 'comment', targetId: { $in: commentIds } }),
  ]);
}

// Каталоги, оставшиеся от падения процесса посреди склейки: их никто уже
// не доделает. Вызывается при запуске.
async function sweep() {
  let names = [];
  try { names = await fs.promises.readdir(REC_ROOT); } catch { return; }
  const ids = names.map((n) => n.split('.')[1]).filter(Boolean);
  if (!ids.length) return;
  await Recording.updateMany({ _id: { $in: ids }, status: 'processing' }, { $set: { status: 'failed' } }).catch(() => {});
  await Promise.all(names.filter((n) => n.includes('.'))
    .map((n) => fs.promises.rm(path.join(REC_ROOT, n), { recursive: true, force: true })));
}

// Длительность записи для подписи: 7:05, 1:02:09.
function clock(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

module.exports = { enabled: storage.enabled, newPart, discard, save, remove, forgetUser, sweep, clock };
