// Запись в нескольких качествах: HLS 720p / 480p / 360p для выбора в плеере
// (public/tk-player.js) и для слабой сети — плеер сам опускает качество.
//
// Готовая запись (utils/recording.js) сначала смотрится одним MP4 — сразу
// после склейки. Потом здесь, в фоне, из него делается HLS:
//   — 720p (или какое пришло) копируется без перекодирования: водяной знак
//     уже в кадре (utils/hls.js), качество не теряется;
//   — 480p и 360p кодируются заново — знак уменьшается вместе с кадром;
//   — каждое качество — один файл с диапазонами (single_file): три видео
//     и четыре плейлиста в хранилище вместо тысяч кусков.
// Когда HLS выгружен, MP4 удаляется: плеер берёт плейлист, а прямой ссылки
// на целый файл, которую можно скачать одним щелчком, больше нет.
//
// Нагрузка. Кодирование идёт по одной записи за раз, с nice 19 и двумя
// потоками — на сервере в это время идут эфиры, их транскод важнее. Час
// записи — около 10–15 минут. Незаконченные после перезапуска подхватывает
// resume() при старте: он же переводит записи, сохранённые до этой функции.
//
// Хранение: 480p + 360p добавляют ~75% к объёму 720p (1200 + 700 кбит/с
// к 2500), MP4 уходит — итог примерно в 1,75 раза больше прежнего.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const storage = require('./storage');
const errorLog = require('./errorLog');
const streamLog = require('./streamLog');
const { resolveWithin } = require('./safePath');
const Recording = require('../models/Recording');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFMPEG_PATH ? path.join(path.dirname(process.env.FFMPEG_PATH), 'ffprobe') : 'ffprobe';
const LOCAL_UPLOADS = path.join(__dirname, '..', 'public', 'uploads');

// Лестница качеств ниже исходного. Исходное — всегда, копией.
const LADDER = [
  { height: 480, bitrate: 1200 },
  { height: 360, bitrate: 700 },
];
const SEGMENT_SECONDS = 6;
const THREADS = '2';

// На бою — только явным RECORDING_HLS=on: без CORS на CDN для m3u8 и ts
// Chrome записи не сыграет, а MP4 после пережатия удаляется (.env.example).
const PROD = process.env.START_SERVER === 'prod' || process.env.NODE_ENV === 'production';
const ENABLED = process.env.RECORDING_HLS === 'on' || (!PROD && process.env.RECORDING_HLS !== 'off');

const queue = [];
let busy = false;

function run(bin, args) {
  return new Promise((resolve, reject) => {
    // nice есть и на Linux, и на macOS; без него — тот же ffmpeg с обычным приоритетом.
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
  const out = JSON.parse(await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', file]));
  const streams = out.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const w = video ? Number(video.width) || 0 : 0;
  const h = video ? Number(video.height) || 720 : 0;
  // Ступени лестницы — по короткой стороне: у вертикальной записи это ширина.
  return { height: w ? Math.min(w, h) : h, portrait: w > 0 && w < h, audio: streams.some((s) => s.codec_type === 'audio') };
}

// MP4 записи на диск: локально он уже там, из Bunny — скачиваем.
async function fetchSource(rec, dir) {
  const url = rec.video && rec.video.url;
  if (!url) throw new Error('у записи нет MP4');
  if (url.startsWith('/uploads/')) {
    // resolveWithin, а не startsWith: тот пропускал соседнюю папку
    // с тем же началом имени (uploads-old/…).
    const local = resolveWithin(LOCAL_UPLOADS, url.slice('/uploads/'.length));
    if (!local) throw new Error('путь вне uploads');
    return local;
  }
  const file = path.join(dir, 'source.mp4');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`скачать MP4: HTTP ${res.status}`);
  // Потоком на диск: час записи — больше гигабайта, в памяти ему не место.
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
  return file;
}

function ffmpegArgs(src, out, info) {
  const levels = LADDER.filter((l) => l.height < info.height - 40);
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', src];
  const maps = ['-map', '0:v:0'];
  if (levels.length) {
    const split = `[0:v:0]split=${levels.length}` + levels.map((_, i) => `[s${i}]`).join('') + ';' +
      levels.map((l, i) => `[s${i}]scale=${info.portrait ? `${l.height}:-2` : `-2:${l.height}`}[v${i}]`).join(';');
    args.push('-filter_complex', split);
    levels.forEach((_, i) => maps.push('-map', `[v${i}]`));
  }
  if (info.audio) for (let i = 0; i <= levels.length; i++) maps.push('-map', '0:a:0');
  args.push(...maps, '-c:v:0', 'copy');
  levels.forEach((l, i) => {
    const n = i + 1;
    args.push(`-c:v:${n}`, 'libx264', `-preset:v:${n}`, 'veryfast', `-b:v:${n}`, `${l.bitrate}k`,
      `-maxrate:v:${n}`, `${Math.round(l.bitrate * 1.1)}k`, `-bufsize:v:${n}`, `${l.bitrate * 2}k`);
  });
  if (levels.length) {
    // Ключевые кадры в тех же местах, что у копии (раз в 2 с, utils/hls.js):
    // куски качеств совпадают, и переключение идёт без скачка.
    levels.forEach((_, i) => args.push(`-pix_fmt:v:${i + 1}`, 'yuv420p'));
    args.push('-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0', '-threads', THREADS);
  }
  if (info.audio) args.push('-c:a', 'copy');
  const map = Array.from({ length: levels.length + 1 }, (_, i) => `v:${i}` + (info.audio ? `,a:${i}` : '')).join(' ');
  args.push('-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod',
    '-hls_flags', 'single_file+independent_segments', '-master_pl_name', 'master.m3u8',
    '-var_stream_map', map, '-hls_segment_filename', path.join(out, 'v%v.ts'), path.join(out, 'v%v.m3u8'));
  return args;
}

const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };

async function convert(rec) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `tk-hls-${rec._id}-`));
  const uploaded = [];
  try {
    const src = await fetchSource(rec, dir);
    const info = await probe(src);
    if (!info.height) throw new Error('в MP4 нет видео');
    const out = path.join(dir, 'hls');
    await fs.promises.mkdir(out);
    const started = Date.now();
    await run(FFMPEG, ffmpegArgs(src, out, info));

    const prefix = `recordings/${rec.userId}/${rec._id}/hls`;
    // Плейлист — последним: пока он не выгружен, недокачанные видео никто не откроет.
    const names = (await fs.promises.readdir(out)).sort((a, b) => (a === 'master.m3u8') - (b === 'master.m3u8'));
    let size = 0;
    let masterUrl = '';
    for (const name of names) {
      const file = path.join(out, name);
      size += (await fs.promises.stat(file)).size;
      const url = await storage.put(file, `${prefix}/${name}`, TYPES[path.extname(name)] || 'application/octet-stream');
      uploaded.push(`${prefix}/${name}`);
      if (name === 'master.m3u8') masterUrl = url;
    }

    // Запись могли удалить, пока шло кодирование, — тогда убираем и выгруженное.
    const saved = await Recording.findOneAndUpdate({ _id: rec._id, status: 'ready' }, {
      $set: { hls: { url: masterUrl, files: uploaded }, size, video: { url: '', key: '' } },
    });
    if (!saved) {
      await Promise.all(uploaded.map((k) => storage.remove(k).catch(() => {})));
      return;
    }
    // Объём на вкладке расходов сходится с хранилищем: был MP4, стали качества.
    streamLog.recordingSize(rec._id, size);
    if (saved.video && saved.video.key) {
      await storage.remove(saved.video.key).catch((e) => errorLog.external(e, 'recording.hls.mp4', { recording: String(rec._id) }));
    }
    console.log(`[rec ${rec._id}] HLS готов: ${names.length} файлов, ${(size / 1048576).toFixed(1)} МБ, ${Math.round((Date.now() - started) / 1000)} с`);
  } catch (e) {
    await Promise.all(uploaded.map((k) => storage.remove(k).catch(() => {})));
    // Запись остаётся смотрибельной одним MP4; повтор — при следующем запуске.
    errorLog.media(e, 'recording.hls', { recording: String(rec._id) });
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function next() {
  if (busy || !queue.length) return;
  busy = true;
  const id = queue.shift();
  try {
    const rec = await Recording.findById(id).lean();
    if (rec && rec.status === 'ready' && !(rec.hls && rec.hls.url)) await convert(rec);
  } catch (e) {
    errorLog.media(e, 'recording.hls', { recording: String(id) });
  } finally {
    busy = false;
    setImmediate(next);
  }
}

// Поставить запись в очередь: после склейки (utils/recording.js) и при старте.
function enqueue(id) {
  if (!ENABLED) return;
  const key = String(id);
  if (!queue.includes(key)) queue.push(key);
  next();
}

// При запуске: всё готовое без HLS — в очередь, старые записи вперёд.
// Без хранилища (на бою без Bunny) записей нет и делать нечего.
async function resume() {
  if (!storage.enabled || !ENABLED) return;
  const rows = await Recording.find({ status: 'ready', 'hls.url': { $in: [null, ''] }, 'video.url': { $nin: [null, ''] } })
    .sort({ createdAt: 1 }).select('_id').lean().catch(() => []);
  rows.forEach((r) => enqueue(r._id));
}

module.exports = { enqueue, resume, ffmpegArgs };
