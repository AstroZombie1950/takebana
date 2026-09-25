// Трафик сервера за месяц — против лимита тарифа.
//
// Hostinger KVM 4 даёт 16 ТБ в месяц, а сверх них режет **весь** сервер до
// 10 Мбит/с до конца месяца — сайт вместе с эфирами, доплатить нельзя.
// Раздачу зрителям поэтому держим на Bunny (решение 25.09.2026), но наш
// канал всё равно тратят: отдача эфиров самому Bunny, реле звонков, обход
// блокировок (/m/, /lf/). Панель показывает, сколько ушло, и пишет в журнал
// ошибок на 70% и 90% лимита — один раз за месяц на каждый порог.
//
// Источник — /proc/net/dev: байты по интерфейсам с загрузки системы. Раз
// в пять минут разница с прошлым показанием прибавляется к месяцу в базе.
// Перезагрузка обнуляет счётчики ядра — тогда прибавка равна показанию.
// Что входит в лимит у Hostinger, входящий или только исходящий, в справке
// не сказано: считаем долю по сумме, так предупреждение не опоздает.
// Сверить раз с панелью Hostinger. Вне Linux (локально) счётчика нет.

const fs = require('fs');
const TrafficMonth = require('../models/TrafficMonth');
const errorLog = require('./errorLog');

const NET_DEV = '/proc/net/dev';
const TICK_MS = 5 * 60 * 1000;
const LIMIT = (Number(process.env.TRAFFIC_LIMIT_TB) || 16) * 1e12;
const WARN = [
  [90, 'Трафик сервера за месяц почти исчерпан — сверх лимита Hostinger режет сервер до 10 Мбит/с'],
  [70, 'Трафик сервера за месяц за порогом предупреждения'],
];

const available = () => fs.existsSync(NET_DEV);
const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);

// Сумма по всем интерфейсам, кроме петли: у сервера он один, но имя
// (eth0, ens3…) от тарифа к тарифу разное.
function read() {
  let rx = 0, tx = 0;
  for (const line of fs.readFileSync(NET_DEV, 'utf8').split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest || name.trim() === 'lo') continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0];
    tx += f[8];
  }
  return { rx, tx };
}

// Перезагрузка обнуляет оба счётчика разом: упал хоть один — считаем
// с нуля оба, иначе выросший за время загрузки второй дал бы разницу
// со старым показанием.
function grow(now, doc) {
  const reboot = now.rx < doc.lastRx || now.tx < doc.lastTx;
  return reboot ? now : { rx: now.rx - doc.lastRx, tx: now.tx - doc.lastTx };
}

async function tick() {
  const now = read();
  const month = monthOf();
  let doc = await TrafficMonth.findOne({ month }).lean();
  if (!doc) {
    // Новый месяц продолжает показания прошлого. Самый первый запуск
    // счёта не имеет, от чего считать, — начинаем с нуля и помечаем дату.
    const prev = await TrafficMonth.findOne().sort({ month: -1 }).lean();
    doc = await TrafficMonth.findOneAndUpdate(
      { month },
      { $setOnInsert: { month, lastRx: prev ? prev.lastRx : now.rx, lastTx: prev ? prev.lastTx : now.tx, startedAt: new Date() } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
  }
  const add = grow(now, doc);
  const rx = doc.rx + add.rx;
  const tx = doc.tx + add.tx;
  const share = ((rx + tx) / LIMIT) * 100;
  const hit = WARN.find(([pct]) => share >= pct && doc.warned < pct);
  await TrafficMonth.updateOne({ month }, {
    $set: { rx, tx, lastRx: now.rx, lastTx: now.tx, updatedAt: new Date(), ...(hit ? { warned: hit[0] } : {}) },
  });
  if (hit) {
    errorLog.server(new Error(`${hit[1]}: ${Math.round(share)}% из ${LIMIT / 1e12} ТБ`), 'traffic.limit',
      { month, rx, tx, limit: LIMIT });
  }
}

function start() {
  if (!available()) return;
  const run = () => tick().catch((e) => errorLog.server(e, 'traffic.tick'));
  run();
  setInterval(run, TICK_MS).unref();
}

// Для «Системы»: месяц, лимит и прогноз на конец месяца по среднему в сутки
// с начала счёта (в первый месяц счёт может начаться не первого числа).
async function summary() {
  if (!available()) return null;
  const doc = await TrafficMonth.findOne({ month: monthOf() }).lean();
  if (!doc) return null;
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const from = Math.max(doc.startedAt.getTime(), Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const spent = doc.rx + doc.tx;
  const elapsed = Math.max(3600e3, doc.updatedAt.getTime() - from);
  return {
    month: doc.month, rx: doc.rx, tx: doc.tx, limit: LIMIT,
    forecast: Math.round(spent + (spent / elapsed) * Math.max(0, end - doc.updatedAt.getTime())),
    since: doc.startedAt, updatedAt: doc.updatedAt,
  };
}

module.exports = { start, summary, tick, read };
