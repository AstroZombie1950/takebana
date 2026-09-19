// Видео галереи профиля: пережатие со знаком и выгрузка в хранилище.
//
// Файл от человека не выкладывается как есть: водяной знак обязан быть
// на всём видео сайта (требование торговой марки), а положить его можно
// только кодированием. Заодно выход не зависит от того, что прислали:
//   — картинка не больше 1280×720 (у вертикального — 720×1280), не больше
//     30 кадров, H.264 до 2,5 Мбит/с, как у эфира;
//   — звук AAC 128 кбит/с, если он был;
//   — MP4 с индексом в начале (faststart), обложка — кадр с третьей секунды.
// Хранилище — Bunny (utils/storage.js; решение «куда грузим файлы» 17.09),
// ключ gallery/<userId>/<id>.mp4.
//
// Кодирование — по одному ролику за раз, nice 19 и два потока: на сервере
// идут эфиры, их транскод важнее. Ролик до 10 минут — минута-две.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('./storage');
const errorLog = require('./errorLog');
const { WATERMARK, WATERMARK_MARGIN } = require('./hls');
const GalleryVideo = require('../models/GalleryVideo');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFMPEG_PATH ? path.join(path.dirname(process.env.FFMPEG_PATH), 'ffprobe') : 'ffprobe';

const MAX_SECONDS = 10 * 60;
const MAX_MB = 300;
const MAX_PER_USER = 30;
const LONG = 1280, SHORT = 720;
// Знак — 7,5% короткой стороны кадра: 54 px на 720, как у эфира (utils/hls.js).
const WATERMARK_SHARE = 54 / 720;

const queue = [];
let busy = false;

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('nice', ['-n', '19', bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(bin)}: ${err.trim().slice(-300) || 'код ' + code}`))));
  });
}

async function probe(file) {
  const out = JSON.parse(await run(FFPROBE, ['-v', 'error',
    '-show_entries', 'stream=codec_type,width,height:stream_tags=rotate:stream_side_data=rotation:format=duration', '-of', 'json', file]));
  const v = (out.streams || []).find((s) => s.codec_type === 'video');
  if (!v) return null;
  // Снятое на телефон вертикально часто лежит горизонтальным кадром
  // с поворотом в метаданных — ffmpeg повернёт его сам, считаем по итогу.
  const rot = Math.abs(Number((v.tags && v.tags.rotate) || ((v.side_data_list || []).find((d) => 'rotation' in d) || {}).rotation || 0));
  const turned = rot === 90 || rot === 270;
  return {
    width: turned ? v.height : v.width,
    height: turned ? v.width : v.height,
    duration: Number(out.format && out.format.duration) || 0,
    audio: (out.streams || []).some((s) => s.codec_type === 'audio'),
  };
}

// Размер выхода: вписать в 1280×720 по длинной и короткой стороне, чётный.
function fit(w, h) {
  const landscape = w >= h;
  const maxW = landscape ? LONG : SHORT, maxH = landscape ? SHORT : LONG;
  const k = Math.min(1, maxW / w, maxH / h);
  const even = (x) => Math.max(2, Math.round(x * k / 2) * 2);
  return { w: even(w), h: even(h) };
}

function ffmpegArgs(src, out, info) {
  const size = fit(info.width, info.height);
  const wm = Math.max(16, Math.round(Math.min(size.w, size.h) * WATERMARK_SHARE));
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-i', WATERMARK,
    '-filter_complex',
    `[0:v]scale=${size.w}:${size.h},setsar=1[v];[1:v]scale=-1:${wm}[wm];` +
    `[v][wm]overlay=W-w-${WATERMARK_MARGIN}:${WATERMARK_MARGIN}[out]`,
    '-map', '[out]', '-fpsmax', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '2500k', '-bufsize', '5000k',
    '-pix_fmt', 'yuv420p', '-threads', '2'];
  if (info.audio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  args.push('-movflags', '+faststart', out);
  return args;
}

async function convert(doc, src) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `tk-gv-${doc._id}-`));
  const base = `gallery/${doc.userId}/${doc._id}`;
  const uploaded = [];
  try {
    const info = await probe(src);
    if (!info) throw Object.assign(new Error('в файле нет видео'), { reason: 'novideo' });
    if (info.duration > MAX_SECONDS + 1) throw Object.assign(new Error('длиннее 10 минут'), { reason: 'long' });

    const video = path.join(dir, 'video.mp4');
    const thumb = path.join(dir, 'thumb.jpg');
    await run(FFMPEG, ffmpegArgs(src, video, info));
    await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(Math.min(3, info.duration / 2)), '-i', video, '-frames:v', '1', '-vf', 'scale=640:-2', thumb])
      .catch((e) => errorLog.media(e, 'gallery.thumb', { video: String(doc._id) }));

    const { size } = await fs.promises.stat(video);
    const videoUrl = await storage.put(video, `${base}.mp4`, 'video/mp4');
    uploaded.push(`${base}.mp4`);
    let thumbUrl = '';
    if (fs.existsSync(thumb)) {
      thumbUrl = await storage.put(thumb, `${base}.jpg`, 'image/jpeg');
      uploaded.push(`${base}.jpg`);
    }

    // Ролик могли удалить, пока он пережимался, — тогда убираем и файлы.
    const saved = await GalleryVideo.findOneAndUpdate({ _id: doc._id }, {
      $set: {
        status: 'ready', duration: Math.round(info.duration), size,
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

async function next() {
  if (busy || !queue.length) return;
  busy = true;
  const { doc, src } = queue.shift();
  try {
    await convert(doc, src);
  } finally {
    busy = false;
    setImmediate(next);
  }
}

// Принятый файл (временный, на диске) — в очередь. Файл удаляется после.
function enqueue(doc, src) {
  queue.push({ doc, src });
  next();
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

module.exports = { enabled: storage.enabled, MAX_SECONDS, MAX_MB, MAX_PER_USER, enqueue, remove, sweep, ffmpegArgs, fit };
