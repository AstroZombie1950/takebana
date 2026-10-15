// Адрес просмотра эфира (14.10, аудит S3, models/Stream.js): каталог HLS —
// /live/<playbackId>/, а не /live/<ключ вещания>/.
//
// Эфиры, заведённые до 14.10, его не имеют — выдаём при первом обращении
// и сразу пишем в базу: одному эфиру — один адрес, сколько бы его ни
// спрашивали (условие в запросе — на случай двух обращений разом).

const { randomBytes } = require('crypto');

const newId = () => randomBytes(16).toString('hex');

async function ensure(stream) {
  if (!stream) return null;
  if (stream.playbackId) return stream.playbackId;
  const Stream = require('../models/Stream');
  const id = newId();
  const r = await Stream.updateOne({ _id: stream._id, playbackId: { $in: [null, ''] } }, { $set: { playbackId: id } });
  if (r.modifiedCount) return id;
  const fresh = await Stream.findById(stream._id).select('playbackId').lean();
  return fresh ? fresh.playbackId : null;
}

module.exports = { newId, ensure };
