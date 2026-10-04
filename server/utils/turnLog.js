// Свой TURN глазами coturn — по каждому звонку (docs/TELEMETRY.md,
// «Звонки», сервер). Браузер говорит, каким путём пошёл разговор
// (public/tk-peer.js), но не видно, что было у самого реле: выдал ли
// coturn порты, сколько через них прошло к собеседнику, отказал ли
// он (486 — квота на человека, 508 — порты кончились, неверный ключ).
//
// Источник — журнал coturn (ops/coturn/turnserver.conf: log-file, verbose).
// В имени временного ключа третьим полем стоит callId (utils/turn.js),
// поэтому строка «allocation new, …, username=<срок:userId:callId>»
// сразу говорит, чей это звонок. Итог реле — строка «peer usage»: байты
// к собеседнику и от него. coturn пишет её при закрытии реле и каждые
// 4096 пакетов, каждый раз за отрезок с прошлой строки, поэтому
// складываем. Две формы строк: coturn 4.18 (проверено локально) пишет
// «allocation new, realm=…» и «allocation delete: realm=…», 4.5 (бой,
// Ubuntu 22.04) — «session N: new, realm=…» и «session N: delete: realm=…».
// Разбор ищет общую часть и имя в любом месте строки.
//
// Итог по людям ложится в запись звонка (models/Call.js, turn), карточка
// звонка в панели показывает его рядом с попытками сторон. Журнал читаем
// с конца, как он есть на старте: звонки до перезапуска процесса досчитать
// нечем — их строк мы не видели с начала.
const fs = require('fs');
const Call = require('../models/Call');
const turn = require('./turn');
const errorLog = require('./errorLog');

const LOG = process.env.TURN_LOG || '/var/log/turnserver/turn.log';
const EVERY_MS = 5000;
// За один проход — не больше: отставший журнал догоняется за несколько.
const CHUNK = 1024 * 1024;
// Запись в базу — когда звонок затих на столько: реле закрываются пачкой.
const FLUSH_MS = 5000;
// Звонок без строк дольше этого забываем: реле живёт до 10 минут
// без обновления (lifetime=600), ключ — 12 часов.
const FORGET_MS = 60 * 60 * 1000;

const NAME = /^\d+:([a-f\d]{24}):([\w-]{8,64})$/i;

let offset = null;
let inode = 0;
let rest = '';
let warned = false;
const calls = new Map();    // callId → { users: Map(userId → итог), timer, at }

function slot(callId, userId) {
  let c = calls.get(callId);
  if (!c) calls.set(callId, c = { users: new Map(), timer: null, at: 0 });
  let u = c.users.get(userId);
  if (!u) c.users.set(userId, u = { allocs: 0, open: 0, inB: 0, outB: 0, errors: {} });
  c.at = Date.now();
  if (!c.timer) c.timer = setTimeout(() => flush(callId), FLUSH_MS).unref();
  return u;
}

function flush(callId) {
  const c = calls.get(callId);
  if (!c) return;
  c.timer = null;
  const kb = (b) => Math.round(b / 1024);
  const rows = [...c.users].map(([user, u]) => ({ user, allocs: u.allocs, open: u.open, inKB: kb(u.inB), outKB: kb(u.outB), errors: u.errors }));
  Call.updateOne({ callId }, { $set: { turn: rows } }).catch((e) => errorLog.server(e, 'turnLog'));
  if (rows.every((r) => r.open <= 0)) calls.delete(callId);
}

function line(s) {
  const name = (s.match(/username=<([^>]*)>/) || s.match(/user <([^>]*)>/) || [])[1];
  const m = name && name.match(NAME);
  if (!m) return;
  const [, userId, callId] = m;

  if (s.includes('new, realm=')) {
    const u = slot(callId, userId);
    u.allocs++;
    u.open++;
  } else if (s.includes('peer usage:')) {
    const u = slot(callId, userId);
    u.inB += Number((s.match(/rb=(\d+)/) || [])[1]) || 0;
    u.outB += Number((s.match(/sb=(\d+)/) || [])[1]) || 0;
  } else if (s.includes('delete: realm=')) {
    const u = slot(callId, userId);
    u.open = Math.max(0, u.open - 1);
  } else if (/ALLOCATE processed, error (\d+)/.test(s)) {
    // 401 без имени — обычный первый круг проверки ключа и сюда не доходит
    // (имени нет); с именем — неверный ключ, у 4.5 это единственный его след
    // (4.18 пишет ещё «credentials … are wrong»). 438 — устаревший nonce:
    // браузер повторяет запрос сам, это не отказ.
    const code = s.match(/ALLOCATE processed, error (\d+)/)[1];
    if (code === '438') return;
    const key = code === '401' ? 'auth' : code;
    const u = slot(callId, userId);
    u.errors[key] = (u.errors[key] || 0) + 1;
  } else if (/credentials of user .* are wrong/.test(s)) {
    const u = slot(callId, userId);
    u.errors.auth = (u.errors.auth || 0) + 1;
  }
}

async function tick() {
  let st;
  try {
    st = await fs.promises.stat(LOG);
  } catch (e) {
    // Локально coturn нет — молчим. На бою TURN есть, а журнала нет — один
    // раз в журнал ошибок: карточки звонков останутся без строки TURN.
    if (!warned && turn.configured() && process.env.NODE_ENV === 'production') {
      warned = true;
      errorLog.media(new Error(`Журнал coturn не читается (${LOG}): TURN по звонкам не пишется`), 'turn.log', { path: LOG, code: e.code });
    }
    return;
  }
  // Первый проход — с конца; новый файл (ротация) или усечённый — с начала.
  if (offset === null) { offset = st.size; inode = st.ino; return; }
  if (st.ino !== inode || st.size < offset) { offset = 0; inode = st.ino; rest = ''; }
  if (st.size === offset) return;

  const len = Math.min(CHUNK, st.size - offset);
  const buf = Buffer.alloc(len);
  const fh = await fs.promises.open(LOG, 'r');
  try {
    await fh.read(buf, 0, len, offset);
  } finally {
    await fh.close();
  }
  offset += len;
  const lines = (rest + buf.toString('utf8')).split('\n');
  rest = lines.pop().slice(-4096);
  for (const s of lines) line(s);

  const old = Date.now() - FORGET_MS;
  for (const [callId, c] of calls) if (c.at < old && !c.timer) calls.delete(callId);
}

function start() {
  if (!turn.configured()) return;
  setInterval(() => tick().catch((e) => errorLog.server(e, 'turnLog')), EVERY_MS).unref();
}

module.exports = { start, line };
