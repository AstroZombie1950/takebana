// Оценки, комментарии и просмотры — общие у записи эфира и видео галереи
// (routes/watch.js): одни коллекции, recordingId указывает на любое из двух.
// Здесь — уборка за ними, когда уходит предмет или человек.

const Recording = require('../models/Recording');
const GalleryVideo = require('../models/GalleryVideo');
const RecordingReaction = require('../models/RecordingReaction');
const RecordingComment = require('../models/RecordingComment');
const RecordingView = require('../models/RecordingView');
const Report = require('../models/Report');

// Запись или видео удалены: оценки, комментарии, отметки просмотров
// и жалобы на сам предмет и его комментарии — следом, у них нет предмета.
// targetType — 'recording' или 'video', как в models/Report.js.
async function forgetTarget(id, targetType) {
  const commentIds = await RecordingComment.distinct('_id', { recordingId: id });
  await Promise.all([
    RecordingReaction.deleteMany({ recordingId: id }),
    RecordingComment.deleteMany({ recordingId: id }),
    RecordingView.deleteMany({ recordingId: id }),
    Report.deleteMany({ $or: [
      { targetType, targetId: id },
      { targetType: 'comment', targetId: { $in: commentIds } },
    ] }),
  ]);
}

// Удаление аккаунта: его оценки и комментарии под чужими записями и видео
// уходят, а счётчики у них уменьшаются на столько же. Какой коллекции
// принадлежит id, не выясняем: одни и те же операции идут в обе, лишние
// просто ничего не находят.
async function forgetUser(userId) {
  const [reactions, comments] = await Promise.all([
    RecordingReaction.find({ userId }).select('recordingId value').lean(),
    RecordingComment.aggregate([{ $match: { userId } }, { $group: { _id: '$recordingId', n: { $sum: 1 } } }]),
  ]);
  const ops = reactions.map((r) => ({
    updateOne: { filter: { _id: r.recordingId }, update: { $inc: r.value === 1 ? { likes: -1 } : { dislikes: -1 } } },
  })).concat(comments.map((c) => ({
    updateOne: { filter: { _id: c._id }, update: { $inc: { comments: -c.n } } },
  })));
  const commentIds = await RecordingComment.distinct('_id', { userId });
  await Promise.all([
    ops.length ? Recording.bulkWrite(ops, { ordered: false }) : null,
    ops.length ? GalleryVideo.bulkWrite(ops, { ordered: false }) : null,
    RecordingReaction.deleteMany({ userId }),
    RecordingComment.deleteMany({ userId }),
    Report.deleteMany({ targetType: 'comment', targetId: { $in: commentIds } }),
  ]);
}

module.exports = { forgetTarget, forgetUser };
