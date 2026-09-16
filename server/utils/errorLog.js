// Запись ошибок в журнал (models/ErrorLog.js).
//
// Одинаковые ошибки складываются в одну строку со счётчиком: поломка в
// горячем маршруте за час даёт тысячи случаев, и список из тысячи одинаковых
// строк не читается, а база пухнет на ровном месте. Ключ группы — отпечаток
// из вида, места, имени и текста ошибки, причём из текста выброшены числа
// и идентификаторы: «эфир 66f1… не найден» и «эфир 66f2… не найден» — это
// одна поломка, а не две.
//
// Как и журнал действий, запись здесь не имеет права ни бросить исключение,
// ни задержать ответ: копим в памяти и раз в две секунды отправляем пачкой.

const { createHash } = require('crypto');
const ErrorLog = require('../models/ErrorLog');

const FLUSH_MS = 2000;
// Потолок на случай шторма: больше пятисот разных отпечатков за два
// секунды — это не ошибки, а что-то, что мы всё равно не прочитаем.
const PENDING_LIMIT = 500;

const pending = new Map();
let timer = null;

// Числа, ObjectId и UUID из текста вон — иначе каждая ошибка со своим
// идентификатором заводит собственную строку.
function normalize(text) {
  return String(text || '')
    .replace(/[0-9a-f]{24}\b/gi, '<id>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d+/g, 'N')
    .slice(0, 300);
}

function fingerprint(scope, route, name, message) {
  return createHash('sha1')
    .update([scope, route, name, normalize(message)].join('|'))
    .digest('hex')
    .slice(0, 16);
}

function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!pending.size) return Promise.resolve();

  const batch = [...pending.values()];
  pending.clear();

  // Повтор увеличивает счётчик и сдвигает lastAt; отметка «разобрано»
  // снимается — ошибка вернулась, значит разобрана она не была.
  const ops = batch.map(({ fp, count, doc }) => ({
    updateOne: {
      filter: { fingerprint: fp },
      update: {
        $inc: { count },
        $set: { ...doc, lastAt: new Date(), resolved: false, resolvedBy: null, resolvedAt: null },
        $setOnInsert: { fingerprint: fp, firstAt: new Date() },
      },
      upsert: true,
    },
  }));

  return ErrorLog.bulkWrite(ops, { ordered: false })
    .catch((e) => console.error('[errorlog] запись не удалась:', e.message));
}

function schedule() {
  if (pending.size >= PENDING_LIMIT) return flush();
  if (!timer) timer = setTimeout(flush, FLUSH_MS).unref();
}

// scope: server | client | media | external.
// err — объект ошибки или строка; route — маршрут или страница; req — если есть.
function record({ scope, err, route = '', status = 0, req = null, meta = null }) {
  try {
    const name = (err && err.name) || 'Error';
    const message = (err && err.message) || String(err || '');
    const fp = fingerprint(scope, route, name, message);

    const doc = {
      scope,
      name: String(name).slice(0, 100),
      message: String(message).slice(0, 500),
      // Стек режем: первые строки называют место, остальное — внутренности
      // Express и Node, одинаковые у всех ошибок.
      stack: String((err && err.stack) || '').split('\n').slice(0, 12).join('\n').slice(0, 4000),
      route: String(route).slice(0, 200),
      status,
      lastUser: req && req.session && req.session.userId ? req.session.userId : null,
      lastIp: req ? String(req.ip || '').replace(/^::ffff:/, '').slice(0, 45) : '',
      lastUa: req ? String(req.get('user-agent') || '').slice(0, 200) : '',
      lastMeta: meta,
    };

    const hit = pending.get(fp);
    if (hit) { hit.count += 1; hit.doc = doc; }
    else pending.set(fp, { fp, count: 1, doc });

    schedule();
  } catch (e) {
    // Журнал ошибок, уронивший приложение, — худшее, что тут может случиться.
    console.error('[errorlog] не удалось подготовить запись:', e.message);
  }
}

// Короткие обёртки для мест, где ошибку ловят и гасят, чтобы работа шла
// дальше: внешние сервисы (Daily, почта, геокодер), медиаконвейер и фоновые
// дела сервера (сокеты, уборка, журналы). Печатают и в консоль: строка
// в логах pm2 остаётся там же, где была до журнала.
function report(scope, err, where, meta) {
  console.error(`[${where}]`, (err && err.message) || err);
  record({ scope, err, route: where, meta });
}

const external = (err, where, meta) => report('external', err, where, meta);
const media = (err, where, meta) => report('media', err, where, meta);
const server = (err, where, meta) => report('server', err, where, meta);

module.exports = { record, external, media, server, flush, fingerprint };
