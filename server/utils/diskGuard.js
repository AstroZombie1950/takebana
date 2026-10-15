// Свободное место под загрузки (AUDIT-2026-10-14, S8).
//
// Черновики видео, вложения переписки и ролики меню ложатся на тот же диск,
// что HLS эфиров, куски записей и MongoDB. Полный диск — встают все эфиры
// и база. Поэтому приём файлов останавливается заранее, пока места ещё
// много: меньше порога из панели (utils/limits.js, diskMinFreeGb; по
// умолчанию UPLOAD_MIN_FREE_GB или 20 ГБ) или 10 % диска — 507 «Сервер
// временно не принимает видео». Эфиры и записи порог не трогает: место
// держим как раз под них.
//
// Замер — statfs той папки, куда ляжет файл, не чаще раза в 5 секунд:
// куски видео идут по 8 МБ, и звать statfs на каждый незачем.
// Отказ — в журнал ошибок раз в час (одна строка со счётчиком) и в журнал
// действий на каждую попытку начать загрузку.

const fs = require('fs');
const errorLog = require('./errorLog');
const { audit } = require('./audit');
const limits = require('./limits');

const MIN_SHARE = 0.10;
const CACHE_MS = 5000;
const REPORT_MS = 3600 * 1000;

const seen = new Map(); // папка → { at, free, total }
let reportedAt = 0;

function measure(dir) {
  const hit = seen.get(dir);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  let m;
  try {
    const st = fs.statfsSync(dir);
    m = { at: Date.now(), free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch (e) {
    // Не замерили — не держим: загрузка важнее, чем недоступный замер.
    errorLog.server(e, 'diskGuard.statfs', { dir });
    m = { at: Date.now(), free: Infinity, total: Infinity };
  }
  seen.set(dir, m);
  return m;
}

// true — места мало, файл не принимаем.
function full(dir) {
  const m = measure(dir);
  return m.free < limits.get().diskMinFreeGb * 1024 ** 3 || m.free < m.total * MIN_SHARE;
}

// Отказ: ответ, журнал ошибок раз в час, журнал действий — когда это
// начало загрузки (start), а не очередной кусок той же.
function refuse(req, res, what, { start = true } = {}) {
  const m = [...seen.values()].sort((a, b) => a.free - b.free)[0] || {};
  const gb = (x) => (Number.isFinite(x) ? Math.round(x / 1024 ** 3 * 10) / 10 : null);
  if (Date.now() - reportedAt > REPORT_MS) {
    reportedAt = Date.now();
    errorLog.media(new Error('Мало места на диске — приём загрузок остановлен'), 'disk.uploads', { what, freeGb: gb(m.free), totalGb: gb(m.total) });
  }
  if (start) audit(req, 'upload.disk.full', { result: 'denied', meta: { what, freeGb: gb(m.free) } });
  res.status(507).json({ success: false, full: true, message: 'Сервер временно не принимает видео и файлы — попробуйте позже' });
}

// Перед multer: файл не должен даже лечь во временную папку.
const guard = (dir, what) => (req, res, next) => (full(dir) ? refuse(req, res, what) : next());

module.exports = { full, refuse, guard };
