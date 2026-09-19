// Пережатие загруженного видео со знаком — общее у галереи профиля
// (utils/galleryVideo.js) и вложений переписки (utils/attachments.js).
//
// Файл от человека не выкладывается как есть: водяной знак обязан быть
// на всём видео сайта (требование торговой марки), а положить его можно
// только кодированием. Заодно выход не зависит от того, что прислали:
//   — картинка не больше 1280×720 (у вертикального — 720×1280), не больше
//     30 кадров, H.264 до 2,5 Мбит/с, как у эфира;
//   — звук AAC 128 кбит/с, если он был;
//   — MP4 с индексом в начале (faststart), обложка — кадр с третьей секунды.
//
// Кодирование — по одному ролику за раз на всё приложение (schedule), nice 19
// и два потока: на сервере идут эфиры, их транскод важнее.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const errorLog = require('./errorLog');
const { WATERMARK, WATERMARK_MARGIN, WATERMARK_SHARE, size: markSize } = require('./watermark');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFMPEG_PATH ? path.join(path.dirname(process.env.FFMPEG_PATH), 'ffprobe') : 'ffprobe';

const LONG = 1280, SHORT = 720;

// stdout — строкой, либо буфером (raw: true) для сырого звука.
function run(bin, args, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('nice', ['-n', '19', bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    proc.stdout.on('data', (c) => { out.push(c); });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${path.basename(bin)}: ${err.trim().slice(-300) || 'код ' + code}`));
      const buf = Buffer.concat(out);
      resolve(raw ? buf : buf.toString());
    });
  });
}

// Что внутри файла: размеры кадра (с учётом поворота), длительность, есть ли
// видео и звук. null — ffprobe файл не разобрал.
async function probe(file, { explain = false } = {}) {
  let out;
  try {
    out = JSON.parse(await run(FFPROBE, ['-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height:stream_tags=rotate:stream_side_data=rotation:format=duration', '-of', 'json', file]));
  } catch (e) {
    // explain — вернуть причину вместо null: её пишет журнал панели.
    return explain ? { error: e.message } : null;
  }
  const streams = out.streams || [];
  // Обложка mp3 и m4a — тоже «видео», но одним кадром: такой файл — звук.
  const v = streams.find((s) => s.codec_type === 'video' && !/^(mjpeg|png|bmp)$/.test(s.codec_name || ''));
  // Снятое на телефон вертикально часто лежит горизонтальным кадром
  // с поворотом в метаданных — ffmpeg повернёт его сам, считаем по итогу.
  const rot = v ? Math.abs(Number((v.tags && v.tags.rotate) || ((v.side_data_list || []).find((d) => 'rotation' in d) || {}).rotation || 0)) : 0;
  const turned = rot === 90 || rot === 270;
  return {
    video: !!v,
    width: v ? (turned ? v.height : v.width) : 0,
    height: v ? (turned ? v.width : v.height) : 0,
    duration: Number(out.format && out.format.duration) || 0,
    audio: streams.some((s) => s.codec_type === 'audio'),
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

// Кружок: квадрат из середины кадра, 480×480. В ленте он круглый, и угол
// квадрата маска срезает — знак ставим внутрь круга, на диагональ к правому
// верхнему углу.
const ROUND = 480;
function roundArgs(src, out, info) {
  const wm = markSize(ROUND, ROUND).height;
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-i', WATERMARK,
    '-filter_complex',
    `[0:v]crop='min(iw,ih)':'min(iw,ih)',scale=${ROUND}:${ROUND},setsar=1[v];[1:v]scale=-1:${wm}[wm];` +
    `[v][wm]overlay=W*0.84-w:H*0.13[out]`,
    '-map', '[out]', '-fpsmax', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-maxrate', '1200k', '-bufsize', '2400k',
    '-pix_fmt', 'yuv420p', '-threads', '2'];
  if (info.audio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '64k', '-ac', '1');
  args.push('-movflags', '+faststart', out);
  return args;
}

// Пережать src в dir/video.mp4 со знаком и снять обложку dir/thumb.jpg.
// round — кружок (roundArgs). Ошибки с reason — про сам файл (не видео,
// слишком длинное), а не про сервер.
async function encode(src, dir, { maxSeconds, round = false, log = {} }) {
  const info = await probe(src, { explain: true });
  if (info.error || !info.video) throw Object.assign(new Error(info.error || 'в файле нет видеодорожки'), { reason: 'novideo' });
  // У webm из MediaRecorder длительности в заголовке нет — тогда её проверяет
  // сам ffmpeg: -t режет всё, что длиннее предела.
  if (info.duration > maxSeconds + 1) throw Object.assign(new Error('слишком длинное'), { reason: 'long' });

  const video = path.join(dir, 'video.mp4');
  const thumb = path.join(dir, 'thumb.jpg');
  const args = round ? roundArgs(src, video, info) : ffmpegArgs(src, video, info);
  args.splice(args.length - 1, 0, '-t', String(maxSeconds + 1));
  await run(FFMPEG, args);
  const out = await probe(video);
  const seconds = (out && out.duration) || info.duration;
  await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(Math.min(3, seconds / 2)), '-i', video, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", thumb])
    .catch((e) => errorLog.media(e, 'video.thumb', log));

  const size = round ? { w: ROUND, h: ROUND } : fit(info.width, info.height);
  return {
    video,
    thumb: fs.existsSync(thumb) ? thumb : '',
    duration: Math.max(1, Math.round(seconds)),
    width: size.w,
    height: size.h,
    bytes: (await fs.promises.stat(video)).size,
  };
}

// Очередь: одно кодирование за раз на всё приложение. Галерея и переписка
// делят её, чтобы вместе не отнять у эфиров больше двух потоков.
let tail = Promise.resolve();
function schedule(job) {
  const done = tail.then(job);
  tail = done.catch(() => {});
  return done;
}

module.exports = { FFMPEG, run, probe, fit, ffmpegArgs, encode, schedule };
