// Страницы просмотра: запись эфира (/recording/:id) и, с 23.09.2026, видео
// галереи (/video/:id). У обоих одно и то же: плеер, просмотры, оценки,
// комментарии, правка названия и описания, удаление, «Смотрите также» —
// поэтому обработчики одни, а различия собраны в KINDS. Оценки, комментарии
// и просмотры лежат в общих коллекциях (utils/engagement.js).
//
// Запись сохраняет завершение эфира (routes/streaming/streams.js), склеивает
// и выгружает utils/recording.js. Видео принимает страница загрузки
// (routes/streaming/upload.js), пережимает utils/galleryVideo.js. Подборка —
// utils/recommend.js.

const crypto = require('crypto');
const restriction = require('../utils/restrict');
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const Recording = require('../models/Recording');
const GalleryVideo = require('../models/GalleryVideo');
const RecordingReaction = require('../models/RecordingReaction');
const RecordingComment = require('../models/RecordingComment');
const RecordingView = require('../models/RecordingView');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { requireAuth, requireAuthApi, requireOwner, requireNotBanned, canModerate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { commonDataMiddleware } = require('./streaming/shared');
const recording = require('../utils/recording');
const galleryVideo = require('../utils/galleryVideo');
const recommend = require('../utils/recommend');
const userView = require('../utils/userView');
const { audit } = require('../utils/audit');

const OBJECT_ID = /^[a-f\d]{24}$/i;
const COMMENTS_PAGE = 20;
// Пределы названия и описания одни у записи и видео.
const { TITLE_MAX, DESCRIPTION_MAX } = galleryVideo;
const COMMENT_MAX = 2000;

// kind — имя в жалобах (models/Report.js), подборке и журнале; i18n —
// префикс строк страницы (rec.* или video.*); back — куда уйти после удаления.
const KINDS = {
  recording: {
    Model: Recording,
    i18n: 'rec',
    notFound: 'Запись не найдена',
    // У записи без названия не бывает: его даёт эфир.
    titleRequired: true,
    back: (userId) => `/userPage/${userId}#recordings`,
    // Пока запись склеивается, удалять нечего: файлов ещё нет, а склейка
    // допишет документ.
    busy: (doc) => (doc.status === 'processing' ? 'Запись ещё сохраняется, удалить можно после' : ''),
    remove: (doc) => recording.remove(doc),
    src: (doc) => (doc.hls && doc.hls.url) || doc.video.url,
    date: (doc) => doc.recordedAt || doc.createdAt,
  },
  video: {
    Model: GalleryVideo,
    i18n: 'video',
    notFound: 'Видео не найдено',
    titleRequired: false,
    back: (userId) => `/userPage/${userId}/gallery`,
    // Пока видео пережимается, удалить можно: обработка увидит, что записи
    // нет, и уберёт выгруженное за собой (utils/galleryVideo.js).
    busy: () => '',
    remove: (doc) => galleryVideo.remove(doc),
    src: (doc) => doc.video.url,
    date: (doc) => doc.createdAt,
  },
};

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

// Автор комментария для ленты: имя и аватар — как везде на сайте.
function commentView(c, me, ownerId, moderator) {
  const u = c.userId || {};
  const name = userView.displayName(u);
  const mine = !!me && String(u._id) === String(me);
  return {
    _id: String(c._id),
    text: c.text,
    createdAt: c.createdAt,
    author: { _id: u._id ? String(u._id) : '', name, avatar: userView.avatarStyle(u, name) },
    mine,
    canDelete: mine || String(ownerId) === String(me) || moderator,
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

function mount(kind) {
  const K = KINDS[kind];
  const path = `/${kind}/:id`;

  const checkId = (req, res, next) => (OBJECT_ID.test(req.params.id) ? next() : res.status(404).json({ message: K.notFound }));

  // Готовое, что этот человек вправе смотреть: для оценок, комментариев
  // и просмотров. Чужое незаконченное — «нет такого».
  async function readyItem(req, res) {
    const item = await K.Model.findById(req.params.id).select('userId status isAdult title').lean();
    if (!item || item.status !== 'ready') {
      res.status(404).json({ message: K.notFound });
      return null;
    }
    // Ограниченному закрыта страница — закрыты и комментарии, оценки,
    // просмотры: иначе комментарий под роликом оставался каналом травли,
    // и автору ещё и приходило о нём уведомление.
    const me = req.session.userId;
    if (await restriction.isRestricted(item.userId, me)) {
      res.status(403).json({ message: 'Автор ограничил вам доступ к своему каналу' });
      return null;
    }
    // 18+ (бывает только у записи) — тот же гейт, что у страницы: автору
    // и подтвердившим возраст.
    if (item.isAdult && String(item.userId) !== String(me)) {
      const u = me ? await User.findById(me).select('adultConfirmedAt').lean() : null;
      if (!u || !u.adultConfirmedAt) {
        res.status(403).json({ message: 'Запись для 18+: подтвердите возраст' });
        return null;
      }
    }
    return item;
  }

  // Страница. Чужому — только готовое; метка 18+ — через тот же гейт, что
  // у эфира: подтверждение возраста хранится в аккаунте, гостя гейт зовёт войти.
  router.get(path, commonDataMiddleware, async (req, res) => {
    const item = OBJECT_ID.test(req.params.id)
      ? await K.Model.findById(req.params.id).populate('userId', 'nickname login email avatar').lean()
      : null;
    const me = req.session.userId;
    const isOwner = !!item && !!item.userId && String(item.userId._id) === String(me);
    if (!item || !item.userId || (item.status !== 'ready' && !isOwner)) {
      return res.status(404).render('streamNotFound');
    }
    // Видео, которое ещё грузится или ждёт «Опубликовать», живёт на странице загрузки.
    if (item.status === 'uploading' || item.status === 'draft') return res.redirect(`/upload#v${item._id}`);
    const blocked = await restriction.isRestricted(item.userId._id, me);
    res.locals.pageOwner = { id: String(item.userId._id), scope: 'content', access: blocked ? 'them' : '' };
    if (blocked) return res.status(403).render('streamNotFound', { restricted: true });
    const current = res.locals.currentUser;
    const adultOk = isOwner || !!(current && current.adultConfirmedAt);
    if (item.isAdult && !adultOk) {
      return res.render('ageGate');
    }

    const [moderator, mine, comments, related] = await Promise.all([
      isModerator(req),
      me ? RecordingReaction.findOne({ recordingId: item._id, userId: me }).select('value').lean() : null,
      commentsPage(item._id),
      recommend.forItem(item, kind, { adultOk: !!(current && current.adultConfirmedAt) }),
    ]);

    const displayName = userView.displayName(item.userId);
    const ready = item.status === 'ready';
    res.render('watch', {
      kind,
      k: K.i18n,
      base: `/${kind}/${item._id}`,
      back: K.back(item.userId._id),
      rec: item,
      ready,
      src: ready ? K.src(item) : '',
      at: K.date(item),
      isOwner,
      myReaction: mine ? mine.value : 0,
      comments: comments.slice(0, COMMENTS_PAGE).map((c) => commentView(c, me, item.userId._id, moderator)),
      moreComments: comments.length > COMMENTS_PAGE,
      related,
      limits: { title: TITLE_MAX, description: DESCRIPTION_MAX, comment: COMMENT_MAX },
      author: { _id: item.userId._id, displayName, avatarStyle: userView.avatarStyle(item.userId, displayName) },
    });
  });

  // Просмотр: плеер шлёт его, когда ролик действительно смотрят (tk-watch.js).
  // Раз в сутки на зрителя; свои просмотры автор не накручивает. Гость —
  // хеш адреса и браузера: сам адрес в базе не хранится.
  router.post(`${path}/view`, checkId, async (req, res) => {
    const item = await readyItem(req, res);
    if (!item) return;
    const me = req.session.userId;
    if (me && String(item.userId) === String(me)) return res.json({ counted: false });

    const viewer = me ? 'u:' + me : 'g:' + crypto.createHash('sha256')
      .update((req.ip || '') + '|' + (req.get('user-agent') || '') + '|' + (process.env.SESSION_SECRET || ''))
      .digest('hex').slice(0, 32);
    const r = await RecordingView.updateOne(
      { recordingId: item._id, viewer },
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    ).catch((e) => (e.code === 11000 ? { upsertedCount: 0 } : Promise.reject(e)));
    if (r.upsertedCount) await K.Model.updateOne({ _id: item._id }, { $inc: { views: 1 } });
    res.json({ counted: !!r.upsertedCount });
  });

  // Оценка: 1 — нравится, -1 — не нравится, 0 — снять. Повтор той же оценки
  // с клиента приходит как 0 (кнопка отжимается). Дизлайки в ответе — только автору.
  router.post(`${path}/reaction`, requireAuthApi, requireNotBanned, checkId, validate({
    value: { type: 'int', required: true, values: [1, -1, 0], label: 'Оценка' },
  }), async (req, res) => {
    const item = await readyItem(req, res);
    if (!item) return;
    const me = req.session.userId;
    const value = req.body.value;

    const key = { recordingId: item._id, userId: me };
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
      ? await K.Model.findOneAndUpdate({ _id: item._id }, { $inc: inc }, { returnDocument: 'after' }).select('likes dislikes userId').lean()
      : await K.Model.findById(item._id).select('likes dislikes userId').lean();
    const isOwner = String(after.userId) === String(me);
    res.json({
      mine: value,
      likes: Math.max(0, after.likes),
      dislikes: isOwner ? Math.max(0, after.dislikes) : undefined,
    });
  });

  // Название и описание — правит автор (и администратор, как у удаления).
  router.patch(path, requireAuth, checkId, requireOwner(K.Model, { field: 'userId' }), validate({
    title: { type: 'string', required: K.titleRequired, allowEmpty: !K.titleRequired, max: TITLE_MAX, label: 'Название' },
    description: { type: 'string', max: DESCRIPTION_MAX, allowEmpty: true, label: 'Описание' },
  }), async (req, res) => {
    const set = { title: req.body.title || '', description: req.body.description || '' };
    await K.Model.updateOne({ _id: req.resource._id }, { $set: set });
    audit(req, `${kind}.edit`, { targetType: kind, target: req.resource, meta: { title: set.title } });
    res.json({ success: true, ...set });
  });

  // Лента комментариев порциями: before — время последнего показанного.
  router.get(`${path}/comments`, checkId, async (req, res) => {
    const item = await readyItem(req, res);
    if (!item) return;
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    if (before && isNaN(before)) return res.status(400).json({ message: 'Некорректная дата' });
    const [list, moderator] = await Promise.all([commentsPage(item._id, before), isModerator(req)]);
    res.json({
      items: list.slice(0, COMMENTS_PAGE).map((c) => commentView(c, req.session.userId, item.userId, moderator)),
      more: list.length > COMMENTS_PAGE,
    });
  });

  router.post(`${path}/comments`, requireAuthApi, requireNotBanned, checkId, commentLimiter, validate({
    text: { type: 'string', required: true, max: COMMENT_MAX, label: 'Комментарий' },
  }), async (req, res) => {
    const item = await readyItem(req, res);
    if (!item) return;
    const me = req.session.userId;
    const c = await RecordingComment.create({ recordingId: item._id, userId: me, text: req.body.text });
    await K.Model.updateOne({ _id: item._id }, { $inc: { comments: 1 } });

    // Автору — уведомление в колокольчик; сам себе он не пишет.
    if (String(item.userId) !== String(me)) {
      Notification.create({
        recipient: item.userId,
        sender: me,
        type: 'comment',
        content: req.body.text.slice(0, 140),
        link: `/${kind}/${item._id}#c-${c._id}`,
      }).catch(() => {});
      const io = req.app.get('io');
      if (io) io.to(`user:${item.userId}`).emit('notification:new', { type: 'comment' });
    }
    audit(req, `${kind}.comment`, { targetType: kind, target: item, meta: { comment: String(c._id) } });

    const full = await RecordingComment.findById(c._id).populate('userId', 'nickname login email avatar').lean();
    res.status(201).json(commentView(full, me, item.userId, false));
  });

  // Удаляют автор комментария, автор ролика и модератор.
  router.delete(`${path}/comments/:cid`, requireAuthApi, checkId, async (req, res) => {
    if (!OBJECT_ID.test(req.params.cid)) return res.status(404).json({ message: 'Комментарий не найден' });
    const [c, item] = await Promise.all([
      RecordingComment.findOne({ _id: req.params.cid, recordingId: req.params.id }).lean(),
      K.Model.findById(req.params.id).select('userId title').lean(),
    ]);
    if (!c || !item) return res.status(404).json({ message: 'Комментарий не найден' });
    const me = String(req.session.userId);
    const allowed = String(c.userId) === me || String(item.userId) === me || await isModerator(req);
    if (!allowed) return res.status(403).json({ message: 'Нет прав на этот комментарий' });

    const { deletedCount } = await RecordingComment.deleteOne({ _id: c._id });
    if (deletedCount) await K.Model.updateOne({ _id: item._id, comments: { $gt: 0 } }, { $inc: { comments: -1 } });
    audit(req, `${kind}.uncomment`, { targetType: kind, target: item, meta: { comment: String(c._id), author: String(c.userId) } });
    res.json({ success: true });
  });

  // Удаляет автор (и администратор — так устроен requireOwner).
  router.delete(path, requireAuth, checkId, requireOwner(K.Model, { field: 'userId' }), async (req, res) => {
    const busy = K.busy(req.resource);
    if (busy) return res.status(409).json({ message: busy });
    await K.remove(req.resource);
    audit(req, `${kind}.delete`, {
      targetType: kind,
      target: req.resource,
      meta: { duration: req.resource.duration, size: req.resource.size },
    });
    res.json({ success: true });
  });
}

Object.keys(KINDS).forEach(mount);

module.exports = router;
