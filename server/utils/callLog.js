// Запись звонков в журнал (models/Call.js). Звонок идёт независимо от
// журнала: ошибка записи только пишется в лог и разговор не рвёт.
//
// Пропущенный — не ответили за 30 секунд или звонящий отменил до ответа:
// у получателя появляется уведомление и растёт счётчик в левой панели.

const Call = require('../models/Call');
const Notification = require('../models/Notification');

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
  if (!call || !MISSED.includes(call.status)) return;

  await Notification.create({ recipient: call.callee, sender: call.caller, type: 'call' });
  if (io) {
    io.to(`user:${call.callee}`).emit('notification:new');
    io.to(`user:${call.callee}`).emit('call:missed');
  }
}

function ended(io, callId, outcome = 'canceled') {
  return after(callId, () => finished(io, callId, outcome));
}

function missedCount(userId) {
  return Call.countDocuments({ callee: userId, seen: false, status: { $in: MISSED } });
}

module.exports = { created, answered, ended, missedCount, MISSED };
