// Вложения переписки: что принимаем, как проверяем, как обрабатываем и где
// храним. Разбор и решения — temp/backlog-2026-09-17.md, раздел 6.
//
// Файл приходит во временную папку (multer.diskStorage, routes/streaming/
// uploads.js), здесь проверяется по содержимому — присланный браузером тип
// подделывается за минуту — и уезжает в хранилище (utils/storage.js, Bunny;
// решение «куда грузим файлы» 17.09). Ключ — chat/<conversationId>/…
//
// По видам:
//   image — jpeg, png, webp, gif → webp до 2560 px без EXIF со знаком плюс
//           копия 720 px для ленты; gif остаётся анимацией, знак на каждом кадре;
//   video — пережатие со знаком (utils/videoEncode.js): знак обязан быть
//           на всём видео сайта; обложка — кадр;
//   audio — как есть, ffprobe подтверждает, что это звук;
//   voice — записанное в браузере голосовое → AAC в m4a плюс волна громкости:
//           webm из Chrome не несёт длительности и не играет на старых iPhone;
//   round — кружок, записанный в браузере: квадрат 480 со знаком, до минуты;
//   file  — документы и архивы как есть.
//
// Раздача — с pull zone Bunny, не с нашего домена: к файлам не уходят
// сессионные cookie. Документы, которые браузер умеет показать (pdf, txt),
// откроются в новой вкладке на её домене; html и svg мы не принимаем вовсе —
// скрипту в них было бы где выполниться.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stamp } = require('./watermark');
const storage = require('./storage');
const errorLog = require('./errorLog');
const { TRANSLIT } = require('./nickname');
const { FFMPEG, run, probe, encode, schedule } = require('./videoEncode');
const Message = require('../models/Message');

const MB = 1024 * 1024;
const VOICE_SECONDS = 5 * 60;
const ROUND_SECONDS = 60;
const VIDEO_SECONDS = 10 * 60;

// Сигнатуры: первые байты файла. at — смещение.
const SIG = {
  jpeg: [[0, 'ffd8ff']],
  png: [[0, '89504e470d0a1a0a']],
  gif: [[0, '47494638']],
  webp: [[0, '52494646'], [8, '57454250']],
  pdf: [[0, '255044462d']],
  zip: [[0, '504b0304']],
  rar: [[0, '526172211a07']],
  '7z': [[0, '377abcaf271c']],
  rtf: [[0, '7b5c727466']],
  ogg: [[0, '4f676753']],
  wav: [[0, '52494646'], [8, '57415645']],
  ebml: [[0, '1a45dfa3']],            // webm
  ftyp: [[4, '66747970']],            // mp4, m4a, mov
  id3: [[0, '494433']],               // mp3 с тегами
};

const is = (head, name) => SIG[name].every(([at, hex]) => head.subarray(at, at + hex.length / 2).toString('hex') === hex);

// mp3 без тегов начинается сразу с кадра: 11 единичных бит синхронизации.
const mp3Frame = (head) => head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
// mov бывает и без ftyp — старые файлы начинаются с атома moov, mdat или wide.
const movAtom = (head) => ['moov', 'mdat', 'wide', 'free', 'skip'].includes(head.subarray(4, 8).toString('latin1'));

// Текст: проверяем, что это UTF-8 без нулевых байтов, — иначе под .txt
// можно прислать что угодно.
function plainText(head) {
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return true;
  } catch (e) {
    return false;
  }
}

// Расширение → вид, тип для раздачи, предел и проверка содержимого.
const TYPES = {
  jpg:  { kind: 'image', mime: 'image/jpeg', mb: 10, ok: (h) => is(h, 'jpeg') },
  jpeg: { kind: 'image', mime: 'image/jpeg', mb: 10, ok: (h) => is(h, 'jpeg') },
  png:  { kind: 'image', mime: 'image/png', mb: 10, ok: (h) => is(h, 'png') },
  webp: { kind: 'image', mime: 'image/webp', mb: 10, ok: (h) => is(h, 'webp') },
  gif:  { kind: 'image', mime: 'image/gif', mb: 10, ok: (h) => is(h, 'gif') },

  pdf:  { kind: 'file', mime: 'application/pdf', mb: 25, ok: (h) => is(h, 'pdf') },
  docx: { kind: 'file', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', mb: 25, ok: (h) => is(h, 'zip') },
  xlsx: { kind: 'file', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', mb: 25, ok: (h) => is(h, 'zip') },
  pptx: { kind: 'file', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', mb: 25, ok: (h) => is(h, 'zip') },
  odt:  { kind: 'file', mime: 'application/vnd.oasis.opendocument.text', mb: 25, ok: (h) => is(h, 'zip') },
  ods:  { kind: 'file', mime: 'application/vnd.oasis.opendocument.spreadsheet', mb: 25, ok: (h) => is(h, 'zip') },
  rtf:  { kind: 'file', mime: 'application/rtf', mb: 25, ok: (h) => is(h, 'rtf') },
  txt:  { kind: 'file', mime: 'text/plain; charset=utf-8', mb: 25, ok: plainText },
  csv:  { kind: 'file', mime: 'text/csv; charset=utf-8', mb: 25, ok: plainText },
  zip:  { kind: 'file', mime: 'application/zip', mb: 50, ok: (h) => is(h, 'zip') },
  '7z': { kind: 'file', mime: 'application/x-7z-compressed', mb: 50, ok: (h) => is(h, '7z') },
  rar:  { kind: 'file', mime: 'application/vnd.rar', mb: 50, ok: (h) => is(h, 'rar') },

  mp3:  { kind: 'audio', mime: 'audio/mpeg', mb: 50, ok: (h) => is(h, 'id3') || mp3Frame(h) },
  m4a:  { kind: 'audio', mime: 'audio/mp4', mb: 50, ok: (h) => is(h, 'ftyp') },
  ogg:  { kind: 'audio', mime: 'audio/ogg', mb: 50, ok: (h) => is(h, 'ogg') },
  wav:  { kind: 'audio', mime: 'audio/wav', mb: 50, ok: (h) => is(h, 'wav') },

  mp4:  { kind: 'video', mime: 'video/mp4', mb: 200, ok: (h) => is(h, 'ftyp') },
  mov:  { kind: 'video', mime: 'video/quicktime', mb: 200, ok: (h) => is(h, 'ftyp') || movAtom(h) },
  webm: { kind: 'video', mime: 'video/webm', mb: 200, ok: (h) => is(h, 'ebml') },
};

// Голосовое и кружок пишет браузер: Chrome и Firefox — webm, Safari — mp4.
const RECORDED = {
  voice: { mb: 10, types: { webm: (h) => is(h, 'ebml'), m4a: (h) => is(h, 'ftyp') }, bad: 'Голосовое не распознано', big: 'Голосовое слишком большое' },
  round: { mb: 60, types: { webm: (h) => is(h, 'ebml'), mp4: (h) => is(h, 'ftyp') }, bad: 'Кружок не распознан', big: 'Кружок слишком большой' },
};

// Самый большой предел из всех — для multer: точный проверяется здесь по виду.
const MAX_MB = Math.max(...Object.values(TYPES).map((x) => x.mb));

const bad = (message) => Object.assign(new Error(message), { status: 400, expose: true });

// multer 1.x отдаёт имя файла, прочитанное как latin1: кириллица приходит
// кракозябрами. Браузеры шлют UTF-8 — перечитываем.
function originalName(file) {
  const raw = String(file.originalname || '');
  const utf = Buffer.from(raw, 'latin1').toString('utf8');
  const name = (utf.includes('\ufffd') ? raw : utf).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.slice(-200) || 'file';
}

function extOf(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

// Имя в ключе хранилища — латиницей: под ним файл и скачается.
function safeBase(name) {
  const base = name.replace(/\.[^.]*$/, '').toLowerCase()
    .replace(/[а-яё]/g, (c) => TRANSLIT[c] || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 60);
  return base || 'file';
}

async function readHead(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// Проверка принятого файла: вид, тип, имя. Ничего не обрабатывает — это
// store(). special — 'voice' или 'round': записанное на странице.
// Бросает 400 с понятным текстом; временный файл удаляет вызывающий.
async function inspect(file, { special = '' } = {}) {
  const name = originalName(file);
  const ext = extOf(name);
  const head = await readHead(file.path);

  const rec = RECORDED[special];
  if (rec) {
    // Первые байты — в журнал панели: по ним видно, что записал телефон.
    if (!rec.types[ext] || !rec.types[ext](head)) throw Object.assign(bad(rec.bad), { head: head.subarray(0, 16).toString('hex') });
    if (file.size > rec.mb * MB) throw bad(rec.big);
    const out = special === 'voice' ? 'voice.m4a' : 'round.mp4';
    return { kind: special, ext, mime: special === 'voice' ? 'audio/mp4' : 'video/mp4', name: out, size: file.size, path: file.path };
  }

  const type = TYPES[ext];
  if (!type) throw bad('Такие файлы не принимаем');
  if (file.size > type.mb * MB) throw bad(`Файл больше ${type.mb} МБ`);
  if (!type.ok(head)) throw bad('Содержимое файла не совпадает с его типом');
  return { kind: type.kind, ext, mime: type.mime, name, size: file.size, path: file.path };
}

// Волна голосового: 48 столбиков громкости 0–31. Звук — моно 2 кГц,
// этого хватает на огибающую; пять минут — около мегабайта в памяти.
const BARS = 48;
async function waveOf(file) {
  const pcm = await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file,
    '-ac', '1', '-ar', '2000', '-f', 's16le', '-'], { raw: true });
  const n = Math.floor(pcm.length / 2);
  if (!n) return new Array(BARS).fill(0);
  const per = Math.max(1, Math.floor(n / BARS));
  const bars = [];
  for (let b = 0; b < BARS; b++) {
    let sum = 0, cnt = 0;
    for (let i = b * per; i < Math.min(n, (b + 1) * per); i++) {
      const v = pcm.readInt16LE(i * 2);
      sum += v * v; cnt++;
    }
    bars.push(cnt ? Math.sqrt(sum / cnt) : 0);
  }
  const top = Math.max(...bars) || 1;
  return bars.map((v) => Math.round(v / top * 31));
}

// Загрузка с откатом: если дальше что-то упало, уже выложенное удаляется.
async function putAll(items) {
  const done = [];
  try {
    for (const [file, key, mime] of items) done.push({ key, url: await storage.put(file, key, mime) });
    return done;
  } catch (e) {
    await Promise.all(done.map((d) => storage.remove(d.key).catch(() => {})));
    throw e;
  }
}

// Оба размера — со знаком, каждый своего масштаба: знак, уменьшенный вместе
// с полной картинкой, на превью стал бы нечитаемым. EXIF не переносится.
async function storeImage(info, base, dir) {
  const fullFile = path.join(dir, 'full.webp');
  const prevFile = path.join(dir, 'prev.webp');
  let meta;
  try {
    meta = await stamp(info.path, { width: 2560, height: 2560 }, 82);
    await fs.promises.writeFile(fullFile, meta.data);
    await fs.promises.writeFile(prevFile, (await stamp(info.path, { width: 720, height: 720 }, 78)).data);
  } catch (e) {
    throw bad('Изображение не распознано');
  }
  const [full, prev] = await putAll([[fullFile, `${base}.webp`, 'image/webp'], [prevFile, `${base}-p.webp`, 'image/webp']]);
  return { key: full.key, url: full.url, previewKey: prev.key, preview: prev.url, width: meta.width, height: meta.height, mime: 'image/webp' };
}

async function storeVideo(info, base, dir) {
  const round = info.kind === 'round';
  let out;
  try {
    out = await schedule(() => encode(info.path, dir, { maxSeconds: round ? ROUND_SECONDS : VIDEO_SECONDS, round, log: { key: base } }));
  } catch (e) {
    if (e.reason === 'long') throw bad(round ? 'Кружок длиннее минуты' : 'Видео длиннее 10 минут');
    if (e.reason === 'novideo') throw Object.assign(bad('В файле нет видео'), { cause: e });
    throw e;
  }
  const items = [[out.video, `${base}.mp4`, 'video/mp4']];
  if (out.thumb) items.push([out.thumb, `${base}.jpg`, 'image/jpeg']);
  const [video, thumb] = await putAll(items);
  return {
    key: video.key, url: video.url, previewKey: thumb && thumb.key, preview: thumb && thumb.url,
    width: out.width, height: out.height, duration: out.duration, size: out.bytes, mime: 'video/mp4',
  };
}

async function storeAudio(info, base) {
  const p = await probe(info.path);
  if (!p || !p.audio || p.video) throw bad('В файле нет звука');
  const [file] = await putAll([[info.path, `${base}/${safeBase(info.name)}.${info.ext}`, info.mime]]);
  return { key: file.key, url: file.url, duration: Math.round(p.duration) };
}

// Голосовое: моно AAC 48 кбит/с — минута около 360 КБ. Длительность
// берём у результата: у webm из MediaRecorder её в заголовке нет.
async function storeVoice(info, base, dir) {
  const out = path.join(dir, 'voice.m4a');
  try {
    await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', info.path,
      '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', out]);
  } catch (e) {
    throw Object.assign(bad('Голосовое не распознано'), { cause: e });
  }
  const p = await probe(out);
  if (!p || !p.audio) throw bad('Голосовое не распознано');
  if (p.duration > VOICE_SECONDS + 2) throw bad('Голосовое длиннее 5 минут');
  const wave = await waveOf(out).catch(() => null);
  const [file] = await putAll([[out, `${base}.m4a`, 'audio/mp4']]);
  return { key: file.key, url: file.url, duration: Math.max(1, Math.round(p.duration)), mime: 'audio/mp4', ...(wave ? { wave } : {}) };
}

// Обработать проверенный файл и выложить. Возвращает вложение для Message.
// Временный файл удаляется в любом случае.
async function store(info, conversationId) {
  const id = crypto.randomBytes(9).toString('base64url');
  const base = `chat/${conversationId}/${id}`;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tk-att-'));
  try {
    let stored;
    if (info.kind === 'image') stored = await storeImage(info, base, dir);
    else if (info.kind === 'video' || info.kind === 'round') stored = await storeVideo(info, base, dir);
    else if (info.kind === 'audio') stored = await storeAudio(info, base);
    else if (info.kind === 'voice') stored = await storeVoice(info, base, dir);
    else stored = (await putAll([[info.path, `${base}/${safeBase(info.name)}.${info.ext}`, info.mime]]))[0];
    return { kind: info.kind, name: info.name, size: info.size, mime: info.mime, ...stored };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(info.path, { force: true }).catch(() => {});
  }
}

// Файлы вложений, на которые больше не ссылается ни одно сообщение, —
// из хранилища. Пересланная копия держит файл живым.
async function release(list) {
  for (const a of list) {
    if (!a || !a.key) continue;
    if (await Message.exists({ 'attachments.key': a.key })) continue;
    await Promise.all([a.key, a.previewKey].filter(Boolean).map((k) => storage.remove(k)))
      .catch((e) => errorLog.external(e, 'attachments.remove', { key: a.key }));
  }
}

// Удалить сообщения и освободить их файлы. Все удаления переписки идут
// через это место — иначе хранилище росло бы молча.
async function deleteMessages(filter) {
  const withFiles = await Message.find({ ...filter, 'attachments.0': { $exists: true } }).select('attachments').lean();
  const result = await Message.deleteMany(filter);
  if (withFiles.length) {
    release(withFiles.flatMap((m) => m.attachments))
      .catch((e) => errorLog.external(e, 'attachments.release'));
  }
  return result;
}

// Пережимается минуту-другую — отвечаем 202, сообщение приходит сокетом.
const SLOW = new Set(['video', 'round']);

module.exports = { enabled: storage.enabled, MAX_MB, SLOW, inspect, store, release, deleteMessages };
