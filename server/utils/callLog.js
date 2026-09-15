// Запись звонков в журнал (models/Call.js) и чтение из него. Звонок идёт
// независимо от журнала: ошибка записи только пишется в лог и разговор не рвёт.
//
// Пропущенный — не ответили за 30 секунд или звонящий отменил до ответа:
// у получателя появляется уведомление и растёт счётчик в левой панели.
//
// Журнал показывает страница переписки: вкладка «Звонки» и строки звонков
// в ленте диалога (public/chats.js). Кончившийся звонок уходит обоим
// сокетом — call:logged, — чтобы появиться там без перезагрузки.

const Call = require('../models/Call');
const Notification = require('../models/Notification');
const userView = require('./userView');

const MISSED = ['missed', 'canceled'];

function quiet(promise) {
  return promise.catch((e) => console.error('[calls] журнал:', e.message));
}

// Запись о звонке ещё может сохраняться, когда его уже приняли или отменили:
// последующие обновления ждут её, иначе им нечего обновлять.
const creating = new Map();
const after = (callId, fn) => quiet(Promise.resolve(creating.get(callId)).then(fn));

function created(callId, { callerId, calleeId, type }) {
  const p = quiet(Call.create({ callId, caller: callerId, callee: calleeId, type }))
    .finally(() => { if (creating.get(callId) === p) creating.delete(callId); });
  creating.set(callId, p);
  return p;
}

function answered(callId) {
  return after(callId, () => Call.updateOne({ callId, status: 'ringing' }, { $set: { status: 'answered', answeredAt: new Date() } }));
}

// Звонок кончился. Статус «звонит» превращается в итог без ответа, у
// разговора только проставляется конец.
async function finished(io, callId, outcome) {
  const call = await Call.findOneAndUpdate(
    { callId, endedAt: null },
    [{ $set: {
      endedAt: new Date(),
      status: { $cond: [{ $eq: ['$status', 'ringing'] }, outcome, { $cond: [{ $eq: [outcome, 'failed'] }, 'failed', '$status'] }] },
    } }],
    { new: true }
  ).lean();
  if (!call) return;

  if (MISSED.includes(call.status)) {
    await Notification.create({ recipient: call.callee, sender: call.caller, type: 'call' });
    if (io) {
      io.to(`user:${call.callee}`).emit('notification:new');
      io.to(`user:${call.callee}`).emit('call:missed');
    }
  }
  // После call:missed: открытая вкладка звонков, получив запись, перечитывает
  // журнал и гасит счётчик — он должен успеть вырасти до этого.
  if (io) io.to(`user:${call.caller}`).to(`user:${call.callee}`).emit('call:logged', { call: view(call) });
}

function ended(io, callId, outcome = 'canceled') {
  return after(callId, () => finished(io, callId, outcome));
}

function missedCount(userId) {
  return Call.countDocuments({ callee: userId, seen: false, status: { $in: MISSED } });
}

// Звонок в том виде, в каком его получает браузер. Кто звонил — по id:
// одна и та же запись уходит обоим, «входящий» или «исходящий» решает
// браузер. Длительность — в секундах, только у состоявшегося разговора.
function view(c) {
  const id = (u) => String(u && u._id ? u._id : u);
  return {
    id: c.callId,
    caller: id(c.caller),
    callee: id(c.callee),
    type: c.type,
    status: c.status,
    startedAt: c.startedAt,
    duration: c.answeredAt && c.endedAt ? Math.round((c.endedAt - c.answeredAt) / 1000) : 0,
  };
}

// Вкладка «Звонки»: последние сто в обе стороны, с собеседником. Открыли —
// пропущенные увидены: счётчик и уведомления о них гаснут.
async function journal(me) {
  const calls = await Call.find({ $or: [{ caller: me }, { callee: me }], endedAt: { $ne: null } })
    .sort({ startedAt: -1 })
    .limit(100)
    .populate('caller callee', 'login email avatar')
    .lean();

  await Promise.all([
    Call.updateMany({ callee: me, seen: false }, { $set: { seen: true } }),
    Notification.updateMany({ recipient: me, type: 'call', isRead: false }, { $set: { isRead: true } }),
  ]);

  return calls
    .filter((c) => c.caller && c.callee) // собеседник мог удалить аккаунт
    .map((c) => {
      const other = String(c.caller._id) === String(me) ? c.callee : c.caller;
      const displayName = userView.displayName(other);
      return { ...view(c), peer: { id: String(other._id), displayName, avatarStyle: userView.avatarStyle(other, displayName) } };
    });
}

// Звонки двоих за отрезок времени — для ленты диалога: from включительно,
// to — нет; любая граница может отсутствовать.
async function between(a, b, { from, to } = {}) {
  const startedAt = {};
  if (from) startedAt.$gte = from;
  if (to) startedAt.$lt = to;
  const calls = await Call.find({
    $or: [{ caller: a, callee: b }, { caller: b, callee: a }],
    endedAt: { $ne: null },
    ...(from || to ? { startedAt } : {}),
  }).sort({ startedAt: 1 }).lean();
  return calls.map(view);
}

module.exports = { created, answered, ended, missedCount, journal, between, MISSED };
