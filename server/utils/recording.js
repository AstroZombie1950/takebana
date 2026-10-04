// Запись эфира.
//
// Пока эфир идёт, HLS-конвейер (utils/hls.js) тем же ffmpeg пишет кусок
// в media/rec/<streamKey>/: без второго кодирования, на каждый запуск свой
// кусок — пауза и обрыв дают новый. Решает ведущий в конце: «Сохранить
// запись» — куски склеиваются в один MP4 (паузы вырезаны сами: во время
// паузы ничего не пишется), к нему снимается кадр-обложка, оба уходят
// в хранилище (utils/storage.js). «Завершить без записи» — куски удаляются.
// Эфир со знаком поверх плеера пишет куски без знака — при склейке они
// пережимаются со знаком в кадре (burnMark ниже).
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
const indexNow = require('./indexNow');
const Recording = require('../models/Recording');
const engagement = require('./engagement');
const recordingHls = require('./recordingHls');
const videoEncode = require('./videoEncode');
const ioHolder = require('./io');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
// ffprobe лежит рядом с ffmpeg: в apt они приходят одним пакетом.
const FFPROBE = process.env.FFMPEG_PATH ? path.join(path.dirname(process.env.FFMPEG_PATH), 'ffprobe') : 'ffprobe';

const REC_ROOT = path.join(__dirname, '..', 'media', 'rec');

function dirFor(streamKey) {
  return isPlainFileName(streamKey) ? path.join(REC_ROOT, streamKey) : null;
}

// Отметка в каталоге кусков: хоть один шёл без знака в кадре — эфир со
// знаком поверх плеера (utils/streamWatermark.js). Такая запись при
// склейке пережимается, и знак ложится в кадр (finalize ниже).
const UNMARKED = 'unmarked';

// Путь нового куска для ffmpeg. null — не пишем (каталог не создать):
// эфир от этого не страдает, только записи не будет.
function newPart(streamKey, { unmarked = false } = {}) {
  const dir = dirFor(streamKey);
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (unmarked) fs.writeFileSync(path.join(dir, UNMARKED), '');
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
// копирование — секунды, пережатие со знаком — десятки минут, выгрузка
// в хранилище — минуты.
// cover — обложка эфира (/uploads/thumbnails/…): есть — она и становится
// обложкой записи (21.09); до этого обложкой всегда был кадр с третьей
// секунды, случайный кусок видео.
async function finalize(rec, dir, cover) {
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
    // Список — рядом с кусками и по именам: так его принимает concat без
    // -safe 0, и тот же список годится пережатию (videoEncode.input).
    const list = path.join(dir, 'list.txt');
    await fs.promises.writeFile(list, nonEmpty.map((n) => `file '${n}'\n`).join(''));

    const video = path.join(work, 'video.mp4');
    const hlsDir = path.join(work, 'hls');
    const thumb = path.join(work, 'thumb.jpg');
    // Знак поверх плеера — запись пережимается со знаком. Есть HLS записей —
    // сразу в качества одним проходом (utils/recordingHls.js, markedArgs);
    // нет — в MP4, как раньше.
    const unmarked = fs.existsSync(path.join(dir, UNMARKED));
    const oneShot = unmarked && recordingHls.ENABLED;
    let duration;
    if (oneShot) {
      duration = await burnHls(rec, dir, nonEmpty, list, hlsDir);
    } else {
      if (unmarked) {
        await burnMark(rec, dir, nonEmpty, list, video);
      } else {
        // Знак уже в кадре (utils/hls.js) — склейка копией, секунды.
        // faststart — индекс в начале файла: плеер начинает играть, не скачав всё.
        await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'concat', '-i', list, '-c', 'copy', '-movflags', '+faststart', video]);
      }
      duration = Math.round(Number(await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', video])) || 0);
    }
    // Кадр не с нуля — первая секунда часто чёрная, пока камера просыпается.
    await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(Math.min(3, Math.max(0, duration / 2))), '-i', oneShot ? path.join(hlsDir, 'v0.ts') : video,
      '-frames:v', '1', '-vf', 'scale=640:-2', thumb])
      .catch((e) => errorLog.media(e, 'recording.thumb', { recording: String(rec._id) }));

    const base = `recordings/${rec.userId}/${rec._id}`;
    let size, media, keys;
    if (oneShot) {
      const up = await recordingHls.upload(rec, hlsDir);
      size = up.size;
      media = { hls: { url: up.url, files: up.files }, video: { url: '', key: '' } };
      keys = up.files;
    } else {
      size = (await fs.promises.stat(video)).size;
      media = { video: { url: await storage.put(video, `${base}.mp4`, 'video/mp4'), key: `${base}.mp4` } };
      keys = [`${base}.mp4`];
    }
    const own = cover && ownCover(cover);
    const thumbKey = own ? `${base}.webp` : fs.existsSync(thumb) ? `${base}.jpg` : '';
    const thumbUrl = own ? await storage.put(own, thumbKey, 'image/webp')
      : thumbKey ? await storage.put(thumb, thumbKey, 'image/jpeg') : '';

    // Запись могли удалить, пока шла выгрузка, — тогда убираем и файлы.
    const saved = await Recording.findOneAndUpdate({ _id: rec._id }, {
      $set: { status: 'ready', duration, size, ...media, thumb: { url: thumbUrl, key: thumbKey } },
    });
    if (!saved) await Promise.all([...keys, thumbKey].filter(Boolean).map((k) => storage.remove(k).catch(() => {})));
    // 18+ в индекс не идёт — как и в карту сайта (routes/seo.js).
    else if (!saved.isAdult) indexNow.ping('/recording/' + rec._id);
    console.log(`[rec ${rec._id}] готова: ${duration} с, ${(size / 1048576).toFixed(1)} МБ`);

    // Автору — сейчас. Склейка идёт минуты, и до 20.09.2026 он не узнавал
    // о ней ничего: ни что готово, ни что не вышло. Страница профиля
    // показывала «обрабатывается», пока её не обновят руками.
    const io = ioHolder.get();
    if (io && saved) {
      io.to(`user:${rec.userId}`).emit('recording:status', {
        id: String(rec._id), status: 'ready', duration, thumb: thumbUrl || '',
      });
    }

    // Склейка идёт в стороне от запроса, поэтому действие системное — req нет.
    // Размер уходит и в отрезок эфира: на вкладке расходов гигабайты должны
    // сходиться с эфиром, который их породил.
    audit(null, 'recording.ready', { actor: rec.userId, targetType: 'recording', target: rec, meta: { duration, size } });
    streamLog.recordingSize(rec._id, size);
    // Несколько качеств — в фоне; пока их нет, запись играет из MP4.
    if (saved && !oneShot) recordingHls.enqueue(rec._id);
  } catch (e) {
    errorLog.media(e, 'recording.finalize', { recording: String(rec._id) });
    audit(null, 'recording.fail', { actor: rec.userId, result: 'fail', targetType: 'recording', target: rec, meta: { error: e.message } });
    await Recording.updateOne({ _id: rec._id }, { $set: { status: 'failed' } })
      .catch((err) => errorLog.media(err, 'recording.markFailed', { recording: String(rec._id) }));
    // Отказ автор обязан увидеть: эфир он уже провёл, и «запись потерялась
    // молча» — худший из возможных исходов.
    const io = ioHolder.get();
    if (io) io.to(`user:${rec.userId}`).emit('recording:status', { id: String(rec._id), status: 'failed' });
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Запись эфира, шедшего со знаком поверх плеера: в кусках знака нет, и без
// пережатия запись ушла бы в хранилище чистой — скачал и унёс. Здесь знак
// ложится в кадр тем же пережатием, что у загруженного видео
// (utils/videoEncode.js): до 1280×720 и 30 кадров, знак в правом верхнем
// углу. Решение 01.10.2026: во время эфира процессор не тратим (знак
// поверх плеера), зато всё, что сохраняется, пережимается со знаком.
//
// Очередь своя (lane 'recording'), по одной записи, nice 19 и два потока:
// эфиры важнее. Пока идёт пережатие, запись «обрабатывается».
// Куски разного размера (эфир шёл то лестницей 720p, то копией 1080p) кадр
// приводит к одному размеру — копией такие склеивались бы битым файлом.
// Кусок из режима «в кадре» в такой записи (настройку сменили посреди
// эфира, между паузами) получит знак ещё раз, в тот же угол — почти точно
// поверх прежнего.
async function burnMark(rec, dir, parts, list, video) {
  let seconds = 0;
  for (const n of parts) {
    const p = await videoEncode.probe(path.join(dir, n), { format: 'mpegts' });
    seconds += (p && p.duration) || 0;
  }
  // Размер кадра и звук — по первому куску, как у склейки копией.
  const info = await videoEncode.probe(list, { format: 'concat' });
  if (!info || !info.video) throw new Error('в кусках записи нет видео');
  const started = Date.now();
  await videoEncode.schedule(() => videoEncode.run(FFMPEG, videoEncode.ffmpegArgs(list, video, { ...info, format: 'concat' }),
    { timeout: Math.max(600, 4 * seconds) }), { lane: 'recording', owner: rec.userId });
  console.log(`[rec ${rec._id}] знак в кадре: ${Math.round(seconds)} с записи за ${Math.round((Date.now() - started) / 1000)} с`);
}

// То же, что burnMark, но сразу в качества HLS (utils/recordingHls.js,
// markedArgs). Возвращает длительность записи, с.
async function burnHls(rec, dir, parts, list, out) {
  let seconds = 0;
  for (const n of parts) {
    const p = await videoEncode.probe(path.join(dir, n), { format: 'mpegts' });
    seconds += (p && p.duration) || 0;
  }
  const info = await videoEncode.probe(list, { format: 'concat' });
  if (!info || !info.video) throw new Error('в кусках записи нет видео');
  await fs.promises.mkdir(out, { recursive: true });
  const started = Date.now();
  await videoEncode.schedule(() => videoEncode.run(FFMPEG, recordingHls.markedArgs(list, out, info),
    { timeout: Math.max(600, 4 * seconds) }), { lane: 'recording', owner: rec.userId });
  console.log(`[rec ${rec._id}] знак и качества одним проходом: ${Math.round(seconds)} с записи за ${Math.round((Date.now() - started) / 1000)} с`);
  return Math.round(seconds);
}

// Эфир завершён с сохранением. Конвейер к этому моменту остановлен
// (routes/streaming/streams.js ждёт hls.stopped): куски закрыты. Каталог
// сразу переименовывается — следующий эфир того же ключа начнёт писать
// в пустой, пока этот склеивается.
async function save(stream) {
  const dir = dirFor(stream.streamKey);
  const rec = await Recording.create({
    userId: stream.userId,
    venue: stream.venue || null, // эфир заведения — и запись его (29.09)
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
  finalize(rec, detached, stream.thumbnail);
  return rec;
}

// Файл обложки эфира на диске — только из папки обложек и только по имени.
function ownCover(url) {
  const name = path.basename(String(url));
  if (!/^[\w.-]+\.webp$/.test(name)) return '';
  const file = path.join(__dirname, '..', 'public', 'uploads', 'thumbnails', name);
  return fs.existsSync(file) ? file : '';
}

// Запись после склейки — удалить из базы и хранилища. Вместе с ней —
// оценки, комментарии, просмотры и жалобы (utils/engagement.js).
//
// Сначала база: для человека запись исчезает сразу. Файлы (видео, обложка,
// все файлы HLS) — следом, в фоне, с повтором: 01.10 удаление ждало их
// по одному, и один зависший запрос к Bunny давал «удалить» 500, а запись
// оставалась на месте. Не удалилось и за три попытки — в журнал с ключами:
// такие файлы — сироты, их видно в «Хранилище» панели.
const REMOVE_RETRY_MS = [0, 30000, 300000];

async function remove(rec) {
  const keys = [rec.video && rec.video.key, rec.thumb && rec.thumb.key, ...((rec.hls && rec.hls.files) || [])].filter(Boolean);
  await Promise.all([
    Recording.deleteOne({ _id: rec._id }),
    engagement.forgetTarget(rec._id, 'recording'),
  ]);
  removeFiles(String(rec._id), keys, 0);
}

function removeFiles(id, keys, attempt) {
  setTimeout(async () => {
    const left = [];
    await Promise.all(keys.map((k) => storage.remove(k).catch(() => left.push(k))));
    if (!left.length) return;
    if (attempt + 1 < REMOVE_RETRY_MS.length) return removeFiles(id, left, attempt + 1);
    errorLog.external(new Error(`файлы записи не удалились из хранилища: ${left.length}`), 'recording.remove', { recording: id, keys: left.slice(0, 20) });
  }, REMOVE_RETRY_MS[attempt]).unref();
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

module.exports = { enabled: storage.enabled, newPart, discard, save, remove, sweep, clock };
