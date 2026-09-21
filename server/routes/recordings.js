// Записи эфиров: страница, просмотры, оценки, комментарии, правка и удаление.
// Сохраняет запись завершение эфира (routes/streaming/streams.js), склеивает
// и выгружает utils/recording.js, список — на странице пользователя
// (routes/streaming/catalog.js), подборку «Смотрите также» — utils/recommend.js.

const crypto = require('crypto');
const restriction = require('../utils/restrict');
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const Recording = require('../models/Recording');
const RecordingReaction = require('../models/RecordingReaction');
const RecordingComment = require('../models/RecordingComment');
const RecordingView = require('../models/RecordingView');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { requireAuth, requireAuthApi, requireOwner, requireNotBanned, canModerate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { commonDataMiddleware } = require('./streaming/shared');
const recording = require('../utils/recording');
const recommend = require('../utils/recommend');
const userView = require('../utils/userView');
const { audit } = require('../utils/audit');

const OBJECT_ID = /^[a-f\d]{24}$/i;
const COMMENTS_PAGE = 20;
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 5000;
const COMMENT_MAX = 2000;

// Комментарии: 10 в минуту с человека — живому разговору хватает, спам-циклу нет.
const commentLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: (req) => String(req.session.userId),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Слишком много комментариев. Подождите минуту.' },
});

// Роль в сессии не лежит (и не должна: снятая роль действовала бы до
// перелогина) — спрашиваем базу, когда от неё что-то зависит.
async function isModerator(req) {
  if (!req.session.userId) return false;
  return canModerate(await User.findById(req.session.userId).select('role').lean());
}

const checkId = (req, res, next) => (OBJECT_ID.test(req.params.id) ? next() : res.status(404).json({ message: 'Запись не найдена' }));

// Готовая запись, которую этот человек вправе смотреть: для оценок,
// комментариев и просмотров. Чужая незаконченная — «нет такой».
async function readyRecording(req, res) {
  const rec = await Recording.findById(req.params.id).select('userId status isAdult title').lean();
  if (!rec || rec.status !== 'ready') {
    res.status(404).json({ message: 'Запись не найдена' });
    return null;
  }
  // 18+ — тот же гейт, что у страницы: автору и подтвердившим возраст.
  const me = req.session.userId;
  if (rec.isAdult && String(rec.userId) !== String(me)) {
    const u = me ? await User.findById(me).select('adultConfirmedAt').lean() : null;
    if (!u || !u.adultConfirmedAt) {
      res.status(403).json({ message: 'Запись для 18+: подтвердите возраст' });
      return null;
    }
  }
  return rec;
}

// Автор комментария для ленты: имя и аватар — как везде на сайте.
function commentView(c, me, recOwnerId, moderator) {
  const u = c.userId || {};
  const name = userView.displayName(u);
  const mine = !!me && String(u._id) === String(me);
  return {
    _id: String(c._id),
    text: c.text,
    createdAt: c.createdAt,
    author: { _id: u._id ? String(u._id) : '', name, avatar: userView.avatarStyle(u, name) },
    mine,
    canDelete: mine || String(recOwnerId) === String(me) || moderator,
  };
}

function commentsPage(recordingId, before) {
  const filter = { recordingId };
  if (before) filter.createdAt = { $lt: before };
  return RecordingComment.find(filter)
    .sort({ createdAt: -1 })
    .limit(COMMENTS_PAGE + 1)
    .populate('userId', 'nickname login email avatar')
    .lean();
}

// Страница записи. Чужому — только готовая; метка 18+ — через тот же гейт,
// что у эфира: подтверждение возраста хранится в аккаунте, гостя гейт зовёт войти.
router.get('/recording/:id', commonDataMiddleware, async (req, res) => {
  const rec = OBJECT_ID.test(req.params.id)
    ? await Recording.findById(req.params.id).populate('userId', 'nickname login email avatar').lean()
    : null;
  const me = req.session.userId;
  const isOwner = !!rec && !!rec.userId && String(rec.userId._id) === String(me);
  if (!rec || !rec.userId || (rec.status !== 'ready' && !isOwner)) {
    return res.status(404).render('streamNotFound');
  }
  const blocked = await restriction.isRestricted(rec.userId._id, me);
  res.locals.pageOwner = { id: String(rec.userId._id), scope: 'content', access: blocked ? 'them' : '' };
  if (blocked) return res.status(403).render('streamNotFound', { restricted: true });
  const current = res.locals.currentUser;
  const adultOk = isOwner || !!(current && current.adultConfirmedAt);
  if (rec.isAdult && !adultOk) {
    return res.render('ageGate');
  }

  const [moderator, mine, comments, related] = await Promise.all([
    isModerator(req),
    me ? RecordingReaction.findOne({ recordingId: rec._id, userId: me }).select('value').lean() : null,
    commentsPage(rec._id),
    recommend.forRecording(rec, { adultOk: !!(current && current.adultConfirmedAt) }),
  ]);

  const displayName = userView.displayName(rec.userId);
  res.render('recording', {
    rec,
    isOwner,
    myReaction: mine ? mine.value : 0,
    comments: comments.slice(0, COMMENTS_PAGE).map((c) => commentView(c, me, rec.userId._id, moderator)),
    moreComments: comments.length > COMMENTS_PAGE,
    related,
    limits: { title: TITLE_MAX, description: DESCRIPTION_MAX, comment: COMMENT_MAX },
    author: { _id: rec.userId._id, displayName, avatarStyle: userView.avatarStyle(rec.userId, displayName) },
  });
});

// Просмотр: плеер шлёт его, когда запись действительно смотрят (tk-recording.js).
// Раз в сутки на зрителя; свои просмотры автор не накручивает. Гость —
// хеш адреса и браузера: сам адрес в базе не хранится.
router.post('/recording/:id/view', checkId, async (req, res) => {
  const rec = await readyRecording(req, res);
  if (!rec) return;
  const me = req.session.userId;
  if (me && String(rec.userId) === String(me)) return res.json({ counted: false });

  const viewer = me ? 'u:' + me : 'g:' + crypto.createHash('sha256')
    .update((req.ip || '') + '|' + (req.get('user-agent') || '') + '|' + (process.env.SESSION_SECRET || ''))
    .digest('hex').slice(0, 32);
  const r = await RecordingView.updateOne(
    { recordingId: rec._id, viewer },
    { $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  ).catch((e) => (e.code === 11000 ? { upsertedCount: 0 } : Promise.reject(e)));
  if (r.upsertedCount) await Recording.updateOne({ _id: rec._id }, { $inc: { views: 1 } });
  res.json({ counted: !!r.upsertedCount });
});

// Оценка: 1 — нравится, -1 — не нравится, 0 — снять. Повтор той же оценки
// с клиента приходит как 0 (кнопка отжимается). Дизлайки в ответе — только автору.
router.post('/recording/:id/reaction', requireAuthApi, requireNotBanned, checkId, validate({
  value: { type: 'int', required: true, values: [1, -1, 0], label: 'Оценка' },
}), async (req, res) => {
  const rec = await readyRecording(req, res);
  if (!rec) return;
  const me = req.session.userId;
  const value = req.body.value;

  const key = { recordingId: rec._id, userId: me };
  const prev = value
    ? await RecordingReaction.findOneAndUpdate(key, { $set: { value, createdAt: new Date() } }, { upsert: true, new: false }).lean()
    : await RecordingReaction.findOneAndDelete(key).lean();

  const was = prev ? prev.value : 0;
  const inc = { likes: 0, dislikes: 0 };
  if (was === 1) inc.likes--;
  if (was === -1) inc.dislikes--;
  if (value === 1) inc.likes++;
  if (value === -1) inc.dislikes++;

  const after = inc.likes || inc.dislikes
    ? await Recording.findOneAndUpdate({ _id: rec._id }, { $inc: inc }, { new: true }).select('likes dislikes userId').lean()
    : await Recording.findById(rec._id).select('likes dislikes userId').lean();
  const isOwner = String(after.userId) === String(me);
  res.json({
    mine: value,
    likes: Math.max(0, after.likes),
    dislikes: isOwner ? Math.max(0, after.dislikes) : undefined,
  });
});

// Название и описание — правит автор (и администратор, как у удаления).
router.patch('/recording/:id', requireAuth, checkId, requireOwner(Recording, { field: 'userId' }), validate({
  title: { type: 'string', required: true, max: TITLE_MAX, label: 'Название' },
  description: { type: 'string', max: DESCRIPTION_MAX, allowEmpty: true, label: 'Описание' },
}), async (req, res) => {
  const set = { title: req.body.title, description: req.body.description || '' };
  await Recording.updateOne({ _id: req.resource._id }, { $set: set });
  audit(req, 'recording.edit', { targetType: 'recording', target: req.resource, meta: { title: set.title } });
  res.json({ success: true, ...set });
});

// Лента комментариев порциями: before — время последнего показанного.
router.get('/recording/:id/comments', checkId, async (req, res) => {
  const rec = await readyRecording(req, res);
  if (!rec) return;
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  if (before && isNaN(before)) return res.status(400).json({ message: 'Некорректная дата' });
  const [list, moderator] = await Promise.all([commentsPage(rec._id, before), isModerator(req)]);
  res.json({
    items: list.slice(0, COMMENTS_PAGE).map((c) => commentView(c, req.session.userId, rec.userId, moderator)),
    more: list.length > COMMENTS_PAGE,
  });
});

router.post('/recording/:id/comments', requireAuthApi, requireNotBanned, checkId, commentLimiter, validate({
  text: { type: 'string', required: true, max: COMMENT_MAX, label: 'Комментарий' },
}), async (req, res) => {
  const rec = await readyRecording(req, res);
  if (!rec) return;
  const me = req.session.userId;
  const c = await RecordingComment.create({ recordingId: rec._id, userId: me, text: req.body.text });
  await Recording.updateOne({ _id: rec._id }, { $inc: { comments: 1 } });

  // Автору — уведомление в колокольчик; сам себе он не пишет.
  if (String(rec.userId) !== String(me)) {
    Notification.create({
      recipient: rec.userId,
      sender: me,
      type: 'comment',
      content: req.body.text.slice(0, 140),
      link: `/recording/${rec._id}#c-${c._id}`,
    }).catch(() => {});
    const io = req.app.get('io');
    if (io) io.to(`user:${rec.userId}`).emit('notification:new', { type: 'comment' });
  }
  audit(req, 'recording.comment', { targetType: 'recording', target: rec, meta: { comment: String(c._id) } });

  const full = await RecordingComment.findById(c._id).populate('userId', 'nickname login email avatar').lean();
  res.status(201).json(commentView(full, me, rec.userId, false));
});

// Удаляют автор комментария, автор записи и модератор.
router.delete('/recording/:id/comments/:cid', requireAuthApi, checkId, async (req, res) => {
  if (!OBJECT_ID.test(req.params.cid)) return res.status(404).json({ message: 'Комментарий не найден' });
  const [c, rec] = await Promise.all([
    RecordingComment.findOne({ _id: req.params.cid, recordingId: req.params.id }).lean(),
    Recording.findById(req.params.id).select('userId title').lean(),
  ]);
  if (!c || !rec) return res.status(404).json({ message: 'Комментарий не найден' });
  const me = String(req.session.userId);
  const allowed = String(c.userId) === me || String(rec.userId) === me || await isModerator(req);
  if (!allowed) return res.status(403).json({ message: 'Нет прав на этот комментарий' });

  const { deletedCount } = await RecordingComment.deleteOne({ _id: c._id });
  if (deletedCount) await Recording.updateOne({ _id: rec._id, comments: { $gt: 0 } }, { $inc: { comments: -1 } });
  audit(req, 'recording.uncomment', { targetType: 'recording', target: rec, meta: { comment: String(c._id), author: String(c.userId) } });
  res.json({ success: true });
});

// Удаляет автор (и администратор — так устроен requireOwner). Пока запись
// склеивается, удалять нечего: файлов ещё нет, а склейка допишет документ.
router.delete('/recording/:id', requireAuth, checkId,
  requireOwner(Recording, { field: 'userId' }), async (req, res) => {
  if (req.resource.status === 'processing') {
    return res.status(409).json({ message: 'Запись ещё сохраняется, удалить можно после' });
  }
  await recording.remove(req.resource);
  audit(req, 'recording.delete', {
    targetType: 'recording',
    target: req.resource,
    meta: { duration: req.resource.duration, size: req.resource.size },
  });
  res.json({ success: true });
});

module.exports = router;
