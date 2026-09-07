// Уборка брошенных эфиров.
//
// Эфир помечается активным при старте и снимается при остановке, но вкладку
// закрывают, браузер падает, сеть рвётся — и запись остаётся «в эфире» навсегда.
// Раньше setInterval стоял прямо в теле роутера и запускался фактом его
// подключения; теперь запуск явный, из app.js.

const Stream = require('../models/Stream');

const ACTIVE_TTL_MINUTES = Number(process.env.STREAM_CLEANUP_ACTIVE_TTL_MINUTES || 5);
const INACTIVE_TTL_DAYS = Number(process.env.STREAM_CLEANUP_INACTIVE_TTL_DAYS || 30);

const STREAM_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // run every 5 minutes

const cleanupAbandonedStreams = async () => {
  try {
    const now = Date.now();
    const activeCutoff = new Date(now - Math.max(1, ACTIVE_TTL_MINUTES) * 60 * 1000);
    const inactiveCutoff = new Date(now - Math.max(1, INACTIVE_TTL_DAYS) * 24 * 60 * 60 * 1000);

    const query = {
      $or: [
        { isActive: true, updatedAt: { $lt: activeCutoff } },
        { isActive: false, updatedAt: { $lt: inactiveCutoff } }
      ]
    };

    const toDelete = await Stream.find(query).select('_id isActive updatedAt userId streamType').lean();
    if (!toDelete.length) return;

    console.log(`[cleanup] deleting abandoned streams: count=${toDelete.length} activeTTL=${ACTIVE_TTL_MINUTES}m inactiveTTL=${INACTIVE_TTL_DAYS}d`);

    // Bulk delete
    await Stream.deleteMany({ _id: { $in: toDelete.map(s => s._id) } });
  } catch (error) {
    console.error('[cleanup] error while deleting abandoned streams:', error);
  }
};

function startStreamCleanup() {
  // unref: таймер не должен удерживать процесс при завершении.
  setInterval(cleanupAbandonedStreams, STREAM_CLEANUP_INTERVAL_MS).unref();
}

module.exports = { startStreamCleanup };
