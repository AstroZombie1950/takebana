// Нагрузка сервера — раз в минуту в базу (models/LoadSample.js), в панели —
// «Система → Нагрузка» (план 2 октября, п. 7; просьба Ивана 02.10 писать
// статистику по часам и дням).
//
// До этого в панели была только оценка ядер по числу эфиров (utils/hls.js,
// usage): сколько на самом деле ест ffmpeg, Node и база — не видел никто,
// а 02.10 после теста средняя загрузка за 15 минут была 5,4 при 4 ядрах.
//
// Процессор — по /proc: весь сервер из /proc/stat, по процессам — из
// /proc/<pid>/stat (utime + stime). Процесс, начавшийся после прошлого замера
// (пережатие записи), считается целиком. Вне Linux (локально) — только
// общий процент по os.cpus(), без разбивки.
//
// Вторая часть п. 7 (03.10): сеть в Мбит/с (/proc/net/dev, как у
// utils/traffic.js), занятость диска эфиров, порты TURN по звонкам своим
// путём, зрители на запасном пути /lf/ (наш канал вместо Bunny) и очереди
// пережатия.
const fs = require('fs');
const os = require('os');
const LoadSample = require('../models/LoadSample');
const hls = require('./hls');
const traffic = require('./traffic');
const turn = require('./turn');
const videoEncode = require('./videoEncode');
const recordingHls = require('./recordingHls');
const ioHolder = require('./io');
const errorLog = require('./errorLog');

const EVERY_MS = 60000;
const TICK_HZ = 100; // CLK_TCK на Linux
// Имя процесса (comm) — группа в панели.
const GROUPS = { ffmpeg: 'ffmpeg', node: 'node', mongod: 'mongo', mediamtx: 'mediamtx', turnserver: 'turn' };
// Процессор выше CPU_WARN % пять замеров подряд — запись в журнал ошибок,
// снова — когда опустится ниже CPU_CALM.
const CPU_WARN = 85;
const CPU_CALM = 70;
const WARN_STREAK = 5;
// Диск эфиров занят на DISK_WARN % — запись сразу: забитый до нуля гасит
// все эфиры разом (routes/admin/summary.js). Снова — после DISK_CALM.
const DISK_WARN = 90;
const DISK_CALM = 85;

const linux = fs.existsSync('/proc/stat');
let prevCpu = null;
let prevProcs = null; // pid -> ticks
let prevUptime = 0;
let streak = 0;
let warned = false;
let diskWarned = false;
let prevNet = null;
let calls = new Map();

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function cpuPercent() {
  const now = cpuTimes();
  const prev = prevCpu;
  prevCpu = now;
  if (!prev || now.total <= prev.total) return 0;
  return Math.round((1 - (now.idle - prev.idle) / (now.total - prev.total)) * 1000) / 10;
}

// Ядра по группам процессов с прошлого замера.
function procCores() {
  if (!linux) return null;
  const uptime = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  const ticks = new Map();
  const out = {};
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try { stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8'); } catch (_) { continue; } // процесс уже кончился
    // comm в скобках может содержать пробелы — режем по последней скобке.
    const close = stat.lastIndexOf(')');
    const comm = stat.slice(stat.indexOf('(') + 1, close);
    const f = stat.slice(close + 2).split(' ');
    const used = Number(f[11]) + Number(f[12]); // utime, stime (поля 14 и 15)
    const started = Number(f[19]) / TICK_HZ;    // starttime (поле 22), с от загрузки
    ticks.set(name, used);
    if (!prevProcs) continue;
    const before = prevProcs.get(name);
    const delta = before != null ? used - before : started >= prevUptime ? used : 0;
    if (delta <= 0) continue;
    const group = GROUPS[comm] || 'other';
    out[group] = (out[group] || 0) + delta;
  }
  const elapsed = uptime - prevUptime;
  const first = !prevProcs;
  prevProcs = ticks;
  prevUptime = uptime;
  if (first || elapsed <= 0) return null;
  for (const k of Object.keys(out)) out[k] = Math.round((out[k] / TICK_HZ / elapsed) * 100) / 100;
  return out;
}

function memPercent() {
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = Number(/MemTotal:\s+(\d+)/.exec(info)[1]);
    const avail = Number(/MemAvailable:\s+(\d+)/.exec(info)[1]);
    return Math.round((1 - avail / total) * 1000) / 10;
  } catch (_) {
    return Math.round((1 - os.freemem() / os.totalmem()) * 1000) / 10;
  }
}

// Мбит/с с прошлого замера, вход и выход. Перезагрузка обнуляет счётчики
// ядра — этот замер пропускаем.
function netMbps() {
  if (!linux) return null;
  const now = { ...traffic.read(), at: Date.now() };
  const prev = prevNet;
  prevNet = now;
  if (!prev || now.rx < prev.rx || now.tx < prev.tx) return null;
  const sec = (now.at - prev.at) / 1000;
  const mbps = (b) => Math.round((b * 8) / sec / 1e4) / 100;
  return { rx: mbps(now.rx - prev.rx), tx: mbps(now.tx - prev.tx) };
}

// % диска, куда ffmpeg пишет эфиры, — как считает df: занято / (занято + доступно).
function diskPercent() {
  try {
    const st = fs.statfsSync(hls.HLS_ROOT);
    const used = st.blocks - st.bfree;
    return Math.round((used / (used + st.bavail)) * 1000) / 10;
  } catch (_) {
    return null; // папки нет на свежей машине
  }
}

// Зрители — все сокеты в комнатах эфиров (вкладка ведущего тоже, это копейки);
// lf — из них на запасном пути (sockets/index.js, stream:route).
function viewersNow() {
  const io = ioHolder.get();
  const out = { all: 0, lf: 0 };
  if (!io) return out;
  for (const [room, ids] of io.sockets.adapter.rooms) {
    if (!room.startsWith('stream:')) continue;
    out.all += ids.size;
    for (const id of ids) {
      const s = io.sockets.sockets.get(id);
      if (s && s.data.lf) out.lf++;
    }
  }
  return out;
}

// Порты реле по идущим разговорам своим путём — та же оценка, что у
// предупреждения turn.capacity (sockets/index.js).
function turnPorts() {
  let ports = 0;
  for (const call of calls.values()) if (call.engine === 'own') ports += turn.portsFor(call.members.size);
  return ports;
}

// Записи — вместе с очередью лестницы (старый путь, utils/recordingHls.js).
function encodeNow() {
  const q = videoEncode.queued();
  return { recording: q.recording + recordingHls.pending(), chat: q.chat, gallery: q.gallery };
}

// Счётчики — явными нулями: пустой объект mongoose не сохраняет вовсе.
// Камеры — одним числом, пережатые и копией (utils/hls.js, venueCopy).
function streamsNow() {
  const c = hls.usage().count;
  return { full: c.full || 0, lite: c.lite || 0, copy: c.copy || 0, venue: (c.venue || 0) + (c.venueCopy || 0) };
}

function sample() {
  const viewers = viewersNow();
  return {
    at: new Date(),
    cpu: cpuPercent(),
    procs: procCores(),
    mem: memPercent(),
    load: Math.round(os.loadavg()[0] * 100) / 100,
    net: netMbps(),
    disk: diskPercent(),
    streams: streamsNow(),
    viewers: viewers.all,
    lf: viewers.lf,
    calls: calls.size,
    turn: turnPorts(),
    encode: encodeNow(),
  };
}

function watch(s) {
  if (s.disk != null) {
    if (s.disk < DISK_CALM) diskWarned = false;
    if (!diskWarned && s.disk >= DISK_WARN) {
      diskWarned = true;
      errorLog.media(new Error(`Диск эфиров занят на ${s.disk}% — при нуле встанут все эфиры`), 'load.disk', { disk: s.disk, streams: s.streams, encode: s.encode });
    }
  }
  streak = s.cpu >= CPU_WARN ? streak + 1 : 0;
  if (s.cpu < CPU_CALM) warned = false;
  if (warned || streak < WARN_STREAK) return;
  warned = true;
  errorLog.media(new Error(`Процессор сервера выше ${CPU_WARN}% пять минут подряд: ${s.cpu}%`), 'load.cpu', { cpu: s.cpu, procs: s.procs, streams: s.streams, viewers: s.viewers });
}

async function tick() {
  const s = sample();
  watch(s);
  await LoadSample.create(s);
}

// calls — идущие звонки (activeCalls из sockets/index.js: utils их не знает).
function start(opts = {}) {
  if (opts.calls) calls = opts.calls;
  sample(); // первый замер — точка отсчёта для разниц
  setInterval(() => tick().catch((e) => errorLog.server(e, 'loadStats')), EVERY_MS).unref();
}

module.exports = { start, CPU_WARN, DISK_WARN };
