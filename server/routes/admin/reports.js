// Вкладка «Жалобы». Список с пагинацией и фильтрами; разбор (закрыть, бан,
// стоп-эфир) остаётся в routes/moderation.js — это действия, а не чтение,
// и они нужны не только панели.
//
// Цель жалобы лежит в трёх разных коллекциях, поэтому populate тут не работает:
// добираем одним запросом на тип, а не по запросу на жалобу — сотня жалоб
// на один эфир иначе означала бы сотню одинаковых чтений.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const Report = require('../../models/Report');
const User = require('../../models/User');
const Stream = require('../../models/Stream');
const ChatMessage = require('../../models/ChatMessage');
const Recording = require('../../models/Recording');
const RecordingComment = require('../../models/RecordingComment');
const { requireModerator, paging, list, period, namesFor, csvRoute, nameOf } = require('./shared');

const STATUSES = ['new', 'resolved', 'rejected'];
const REASONS = ['spam', 'abuse', 'adult', 'violence', 'copyright', 'other'];
const TARGETS = ['stream', 'user', 'message', 'recording', 'comment'];

async function loadReports(req) {
  const p = paging(req);
  const filter = { ...period(req, 'createdAt') };

  filter.status = STATUSES.includes(req.query.status) ? req.query.status : 'new';
  if (REASONS.includes(req.query.reason)) filter.reason = req.query.reason;
  if (TARGETS.includes(req.query.targetType)) filter.targetType = req.query.targetType;

  const [reports, total, counts] = await Promise.all([
    Report.find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.perPage).lean(),
    Report.countDocuments(filter),
    // Счётчики вкладок: сколько новых, разобранных, отклонённых.
    Report.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);

  const ids = { user: [], stream: [], message: [], recording: [], comment: [] };
  for (const r of reports) ids[r.targetType].push(r.targetId);

  const [users, streams, messages, recordings, comments, names, sameTarget] = await Promise.all([
    ids.user.length ? User.find({ _id: { $in: ids.user } }).select('login email banned role').lean() : [],
    ids.stream.length ? Stream.find({ _id: { $in: ids.stream } }).select('title isActive userId stoppedByModeration isAdult').lean() : [],
    ids.message.length ? ChatMessage.find({ _id: { $in: ids.message } }).select('message userId streamId').lean() : [],
    ids.recording.length ? Recording.find({ _id: { $in: ids.recording } }).select('title userId').lean() : [],
    ids.comment.length ? RecordingComment.find({ _id: { $in: ids.comment } }).select('text userId recordingId').lean() : [],
    namesFor([...reports.map((r) => r.reporter), ...reports.map((r) => r.resolvedBy)]),
    // Сколько всего жалоб на те же объекты: одна жалоба и двадцатая на один
    // эфир разбираются по-разному.
    Report.aggregate([
      { $match: { targetId: { $in: reports.map((r) => r.targetId) } } },
      { $group: { _id: '$targetId', n: { $sum: 1 } } },
    ]),
  ]);

  const target = new Map();
  for (const u of users) target.set(String(u._id), { kind: 'user', title: u.login || u.email || '', banned: !!u.banned, role: u.role, ownerId: String(u._id) });
  for (const s of streams) target.set(String(s._id), { kind: 'stream', title: s.title, isActive: !!s.isActive, stopped: !!s.stoppedByModeration, isAdult: !!s.isAdult, ownerId: String(s.userId) });
  for (const m of messages) target.set(String(m._id), { kind: 'message', title: m.message, ownerId: String(m.userId), streamId: m.streamId ? String(m.streamId) : null });
  for (const r of recordings) target.set(String(r._id), { kind: 'recording', title: r.title, ownerId: String(r.userId) });
  for (const c of comments) target.set(String(c._id), { kind: 'comment', title: c.text, ownerId: String(c.userId), recordingId: String(c.recordingId) });

  const total4 = new Map(sameTarget.map((t) => [String(t._id), t.n]));

  return {
    ...list(reports.map((r) => ({
      id: String(r._id),
      createdAt: r.createdAt,
      status: r.status,
      reason: r.reason,
      comment: r.comment || '',
      targetType: r.targetType,
      targetId: String(r.targetId),
      // Цели может уже не быть: эфир закончился, сообщение удалили.
      target: target.get(String(r.targetId)) || null,
      onTarget: total4.get(String(r.targetId)) || 1,
      reporter: names.get(String(r.reporter)) || null,
      action: r.action || '',
      resolvedAt: r.resolvedAt || null,
      resolvedBy: names.get(String(r.resolvedBy)) || null,
    })), total, p),
    counts: counts.reduce((acc, row) => ({ ...acc, [row._id]: row.n }), {}),
  };
}

router.get('/reports', requireModerator, async (req, res) => res.json(await loadReports(req)));
csvRoute(router, '/reports', requireModerator, 'reports', loadReports, [
  ['Подана', (r) => r.createdAt],
  ['Состояние', (r) => ({ new: 'новая', resolved: 'разобрана', rejected: 'отклонена' }[r.status])],
  ['Причина', (r) => r.reason],
  ['Комментарий', (r) => r.comment],
  ['Объект', (r) => r.targetType],
  ['Идентификатор объекта', (r) => r.targetId],
  ['Название объекта', (r) => (r.target ? r.target.title : 'удалён')],
  ['Жалоб на объект', (r) => r.onTarget],
  ['Кто пожаловался', (r) => nameOf(r.reporter)],
  ['Решение', (r) => r.action],
  ['Разобрал', (r) => nameOf(r.resolvedBy)],
  ['Когда разобрал', (r) => r.resolvedAt],
]);

module.exports = router;
