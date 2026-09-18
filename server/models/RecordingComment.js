// Комментарий к записи эфира. Плоский список, новые сверху. Удаляют автор
// комментария, автор записи и модератор; счётчик — Recording.comments.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const commentSchema = new Schema({
  recordingId: { type: Schema.Types.ObjectId, ref: 'Recording', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true, maxlength: 2000 },
  createdAt: { type: Date, default: Date.now },
});

// Лента комментариев записи — порциями от новых к старым.
commentSchema.index({ recordingId: 1, createdAt: -1 });
commentSchema.index({ userId: 1 });

module.exports = mongoose.model('RecordingComment', commentSchema);
