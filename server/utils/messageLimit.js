// Сообщения с ограничением: «один раз», «два», «три» или таймер после
// открытия. Решение заказчика 18.09.2026, как в Telegram.
//
// Выбор в поле ввода один на все виды: n1–n3 — сколько раз открыть (у фото,
// видео, звука, кружка и текста это просмотры, у документа — скачивания),
// t10…t3600 — сколько секунд живёт после первого открытия (документ скачать
// таймером нельзя — у него это одно скачивание). Неоткрытое стирается через
// семь дней.
//
// Пока сообщение не открыто, браузер не получает ни текста, ни адреса файла
// (routes/streaming/messages.js, view). Открывает только получатель: сервер
// считает раз и на время выдаёт файл через себя (pipe) — постоянного адреса
// на CDN у получателя нет. Исчерпано — текст и файлы стираются, сообщение
// остаётся заглушкой с expiredAt, обоим уходит message:expired.

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const Message = require('../models/Message');
const errorLog = require('./errorLog');
const { release } = require('./attachments');
const { view: viewOf } = require('./messageView');

const LIFETIME_MS = 7 * 24 * 3600 * 1000;
const TIMERS = { t10: 10, t60: 60, t600: 600, t3600: 3600 };
const COUNTS = { n1: 1, n2: 2, n3: 3 };
const OPTIONS = ['', ...Object.keys(COUNTS), ...Object.keys(TIMERS)];
const UPLOADS = path.join(__dirname, '..', 'public', 'uploads');

// Сколько после открытия отдаём файл одного просмотра: картинку смотрят,
// сколько хотят, пока окно открыто; видео и звук — длительность с запасом.
// Закрыл окно — стирается сразу (close), бросил вкладку — по этому сроку.
function grantMs(att) {
  const base = 10 * 60;
  return (att && att.duration ? Math.max(base, att.duration * 2 + 120) : base) * 1000;
}

// Выбор из поля ввода → limit для Message. kind — вид вложения или 'text'.
function parse(option, kind, now = new Date()) {
  if (!option) return undefined;
  const expiresAt = new Date(now.getTime() + LIFETIME_MS);
  if (kind === 'file') return { mode: 'downloads', n: COUNTS[option] || 1, used: 0, expiresAt };
  if (TIMERS[option]) return { mode: 'timer', seconds: TIMERS[option], used: 0, expiresAt };
  return { mode: 'views', n: COUNTS[option], used: 0, expiresAt };
}

const io = { current: null };
const emit = (userId, event, data) => { if (io.current) io.current.to(`user:${userId}`).emit(event, data); };

// Стереть содержимое и оставить заглушку. Условие expiredAt: null делает
// это один раз, даже если истечение пришло с двух сторон сразу.
async function expire(id) {
  const before = await Message.findOneAndUpdate(
    { _id: id, expiredAt: null, 'limit.mode': { $exists: true } },
    { $set: { expiredAt: new Date(), content: '', attachments: [] } },
  ).lean();
  if (!before) return false;
  release(before.attachments || []).catch((e) => errorLog.external(e, 'limit.release', { message: String(id) }));
  const after = await Message.findById(id).lean();
  if (after) {
    const out = viewOf(after);
    emit(after.sender, 'message:expired', { message: out });
    emit(after.recipient, 'message:expired', { message: out });
  }
  return true;
}

// Открыть: посчитать раз и выдать содержимое. null — открыть нечего
// (чужое, уже истекло, исчерпано).
async function open(id, me) {
  const now = new Date();
  const m = await Message.findOne({ _id: id, recipient: me, expiredAt: null, 'limit.mode': { $exists: true } }).lean();
  if (!m) return null;
  const lim = m.limit;
  const att = m.attachments[0];
  let set;

  if (lim.mode === 'timer') {
    if (lim.openedAt) {
      if (lim.expiresAt <= now) return null;
      return m; // таймер уже идёт — открыть снова можно, пока не вышел
    }
    const end = new Date(now.getTime() + lim.seconds * 1000);
    set = { 'limit.openedAt': now, 'limit.grantUntil': end, 'limit.expiresAt': end, 'limit.used': 1 };
    const r = await Message.findOneAndUpdate({ _id: id, 'limit.openedAt': null }, { $set: set }, { new: true }).lean();
    return r || Message.findById(id).lean();
  }

  // Просмотры и скачивания: раз засчитывается атомарно — два открытия
  // одновременно не дадут лишнего. Последний раз ставит срок стирания
  // по окну выдачи.
  const grant = new Date(now.getTime() + (lim.mode === 'downloads' ? 2 * 60 * 1000 : grantMs(att)));
  const last = (lim.used || 0) + 1 >= lim.n;
  set = { 'limit.grantUntil': grant, 'limit.openedAt': lim.openedAt || now };
  if (last) set['limit.expiresAt'] = grant;
  return Message.findOneAndUpdate(
    { _id: id, expiredAt: null, 'limit.used': { $lt: lim.n } },
    { $inc: { 'limit.used': 1 }, $set: set },
    { new: true },
  ).lean();
}

// Окно просмотра закрыто: если раз был последним — стираем сейчас, не дожидаясь
// срока выдачи.
async function close(id, me) {
  const m = await Message.findOne({ _id: id, recipient: me, expiredAt: null }).select('limit').lean();
  if (!m || !m.limit) return;
  if (m.limit.mode !== 'timer' && m.limit.used >= m.limit.n) await expire(id);
}

// Отдать файл открытого сообщения, пока идёт окно выдачи. С Range — видео
// и звук перематываются. Кэшировать запрещаем: второй раз за этим адресом
// браузер должен прийти к нам, а не в свой кэш.
async function pipe(req, res, m, part) {
  const att = m.attachments[0];
  const url = part === 'preview' ? att.preview : att.url;
  if (!url) return res.status(404).end();
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  const disposition = m.limit.mode === 'downloads' ? 'attachment' : 'inline';
  res.set('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(att.name || 'file')}`);

  if (url.startsWith('/uploads/')) {
    const file = path.join(UPLOADS, url.slice('/uploads/'.length));
    if (!file.startsWith(UPLOADS + path.sep) || !fs.existsSync(file)) return res.status(404).end();
    return new Promise((resolve) => res.sendFile(file, { headers: { 'Cache-Control': 'private, no-store' }, lastModified: false, etag: false }, () => resolve()));
  }

  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  const up = await fetch(url, { headers: req.headers.range ? { Range: req.headers.range } : {}, signal: ctrl.signal });
  res.status(up.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = up.headers.get(h);
    if (v) res.set(h, v);
  }
  if (!up.body) return res.end();
  return new Promise((resolve) => {
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res).on('finish', resolve).on('close', resolve);
  });
}

// Уборка: исчерпанные и просроченные — раз в 20 секунд, пачками.
function start(socketIo) {
  io.current = socketIo;
  const tick = async () => {
    try {
      const due = await Message.find({ expiredAt: null, 'limit.expiresAt': { $lte: new Date() } }).select('_id').limit(200).lean();
      for (const m of due) await expire(m._id);
    } catch (e) {
      errorLog.server(e, 'limit.sweep');
    }
  };
  setInterval(tick, 20 * 1000).unref();
  tick();
}

module.exports = { OPTIONS, parse, open, close, expire, pipe, start };
