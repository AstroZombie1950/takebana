// Вкладки «Эфиры» и «Записи».
//
// «Сейчас в эфире» и архив — разные источники. Идущий эфир живёт в Stream,
// и там же его текущее число зрителей (его пишет сэмплер сокетов). Всё, что
// кончилось, живёт только в отрезках StreamSession: документ Stream после
// завершения удаляется, и других следов у эфира нет.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const Stream = require('../../models/Stream');
const StreamSession = require('../../models/StreamSession');
const Recording = require('../../models/Recording');
const Establishments = require('../../models/Establishments');
const { requireModerator, paging, list, needle, period, namesFor, csvRoute, nameOf } = require('./shared');

// ── Сейчас в эфире ───────────────────────────────────────────────────────────
router.get('/live', requireModerator, async (req, res) => {
  const [streams, venues] = await Promise.all([
    Stream.find({ isActive: true })
      .select('title category subcategory city viewers userId streamProvider isAdult startedAt firstLiveAt streamKey stoppedByModeration')
      .sort({ viewers: -1, startedAt: 1 })
      .lean(),
    // Камера заведения — тоже вещание, и гасить её приходится тем же порядком.
    Establishments.find({ online: true }).select('name city owner').lean(),
  ]);

  const names = await namesFor([...streams.map((s) => s.userId), ...venues.map((v) => v.owner)]);

  // Пик с начала отрезка: в Stream его нет, он копится в журнале эфиров.
  const open = await StreamSession.find({ streamKey: { $in: streams.map((s) => s.streamKey) }, endedAt: null })
    .select('streamKey peakViewers viewerSeconds startedAt')
    .lean();
  const byKey = new Map(open.map((o) => [o.streamKey, o]));

  res.json({
    streams: streams.map((s) => {
      const session = byKey.get(s.streamKey);
      return {
        id: String(s._id),
        title: s.title || '',
        category: s.category || '',
        subcategory: s.subcategory || '',
        city: s.city || '',
        viewers: s.viewers || 0,
        peakViewers: session ? session.peakViewers : 0,
        source: s.streamProvider === 'obs' ? 'obs' : 'web',
        isAdult: !!s.isAdult,
        // startedAt сбрасывается паузой, firstLiveAt — нет: по нему видно,
        // когда эфир вообще начался.
        startedAt: s.startedAt || null,
        firstLiveAt: s.firstLiveAt || null,
        owner: names.get(String(s.userId)) || null,
      };
    }),
    venues: venues.map((v) => ({
      id: String(v._id),
      name: v.name || '',
      city: v.city || '',
      owner: names.get(String(v.owner)) || null,
    })),
  });
});

// ── Архив эфиров ─────────────────────────────────────────────────────────────
async function loadStreams(req) {
  const p = paging(req);
  const filter = { endedAt: { $ne: null }, ...period(req, 'startedAt') };

  const q = needle(req.query.q);
  if (q) filter.title = q;
  if (req.query.user) filter.user = req.query.user;
  if (['web', 'obs'].includes(req.query.source)) filter.source = req.query.source;
  if (['owner', 'moderation', 'cleanup', 'restart'].includes(req.query.endedBy)) filter.endedBy = req.query.endedBy;
  // Отрезки короче минуты — это чаще всего оборвавшееся подключение, а не эфир.
  if (req.query.real === '1') filter.duration = { $gte: 60 };

  const [sessions, total, totals] = await Promise.all([
    StreamSession.find(filter).sort({ startedAt: -1 }).skip(p.skip).limit(p.perPage).lean(),
    StreamSession.countDocuments(filter),
    // Итог по всей выборке, а не по странице: часы эфира за период — это
    // то, ради чего вкладку открывают.
    StreamSession.aggregate([
      { $match: filter },
      { $group: { _id: null, seconds: { $sum: '$duration' }, viewerSeconds: { $sum: '$viewerSeconds' }, peak: { $max: '$peakViewers' } } },
    ]),
  ]);

  const names = await namesFor(sessions.map((s) => s.user));
  const sum = totals[0] || {};

  return {
    ...list(sessions.map((s) => ({
      id: String(s._id),
      title: s.title || '',
      category: s.category || '',
      city: s.city || '',
      source: s.source,
      isAdult: !!s.isAdult,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      duration: s.duration || 0,
      peakViewers: s.peakViewers || 0,
      viewerSeconds: s.viewerSeconds || 0,
      chatMessages: s.chatMessages || 0,
      endedBy: s.endedBy || '',
      stopReason: s.stopReason || '',
      recording: s.recording ? String(s.recording) : null,
      recordingSize: s.recordingSize || 0,
      owner: names.get(String(s.user)) || null,
    })), total, p),
    totals: { seconds: sum.seconds || 0, viewerSeconds: sum.viewerSeconds || 0, peak: sum.peak || 0 },
  };
}

const ENDED_BY = { owner: 'завершён', moderation: 'погашен', cleanup: 'брошен', restart: 'перезапуск' };

router.get('/streams', requireModerator, async (req, res) => res.json(await loadStreams(req)));
csvRoute(router, '/streams', requireModerator, 'streams', loadStreams, [
  ['Эфир', (s) => s.title],
  ['Кто', (s) => nameOf(s.owner)],
  ['Источник', (s) => (s.source === 'obs' ? 'OBS' : 'веб')],
  ['Раздел', (s) => s.category],
  ['Город', (s) => s.city],
  ['18+', (s) => (s.isAdult ? 'да' : '')],
  ['Начало', (s) => s.startedAt],
  ['Конец', (s) => s.endedAt],
  ['Длительность, с', (s) => s.duration],
  ['Пик зрителей', (s) => s.peakViewers],
  ['Зрителе-секунды', (s) => s.viewerSeconds],
  ['Сообщений в чате', (s) => s.chatMessages],
  ['Итог', (s) => ENDED_BY[s.endedBy] || ''],
  ['Причина', (s) => s.stopReason],
  ['Запись', (s) => s.recording || ''],
]);

// ── Записи ───────────────────────────────────────────────────────────────────
//
// Удаление записи отдельного маршрута здесь не требует: DELETE /recording/:id
// пускает владельца и администратора (requireOwner) и пишет в журнал.
async function loadRecordings(req) {
  const p = paging(req);
  const filter = { ...period(req, 'createdAt') };

  const q = needle(req.query.q);
  if (q) filter.title = q;
  if (['processing', 'ready', 'failed'].includes(req.query.status)) filter.status = req.query.status;
  if (req.query.user) filter.userId = req.query.user;
  if (req.query.adult === '1') filter.isAdult = true;

  const [recordings, total, totals] = await Promise.all([
    Recording.find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.perPage).lean(),
    Recording.countDocuments(filter),
    // Байты — это деньги за хранение, поэтому сумма по всей выборке.
    Recording.aggregate([
      { $match: filter },
      { $group: { _id: null, bytes: { $sum: '$size' }, seconds: { $sum: '$duration' } } },
    ]),
  ]);

  const names = await namesFor(recordings.map((r) => r.userId));
  const sum = totals[0] || {};

  return {
    ...list(recordings.map((r) => ({
      id: String(r._id),
      title: r.title || '',
      category: r.category || '',
      city: r.city || '',
      status: r.status,
      isAdult: !!r.isAdult,
      duration: r.duration || 0,
      size: r.size || 0,
      createdAt: r.createdAt,
      recordedAt: r.recordedAt || null,
      // Ключ в хранилище нужен, когда файл ищут руками в Bunny.
      // После пережатия в HLS MP4 нет: ключ — папка качеств, адрес — плейлист.
      key: (r.hls && r.hls.url) ? `recordings/${r.userId}/${r._id}/hls/` : (r.video && r.video.key) || '',
      url: (r.hls && r.hls.url) || (r.video && r.video.url) || '',
      owner: names.get(String(r.userId)) || null,
    })), total, p),
    totals: { bytes: sum.bytes || 0, seconds: sum.seconds || 0 },
  };
}

router.get('/recordings', requireModerator, async (req, res) => res.json(await loadRecordings(req)));
csvRoute(router, '/recordings', requireModerator, 'recordings', loadRecordings, [
  ['Запись', (r) => r.title],
  ['Кто', (r) => nameOf(r.owner)],
  ['Состояние', (r) => ({ ready: 'готова', processing: 'склеивается', failed: 'не вышла' }[r.status] || r.status)],
  ['Раздел', (r) => r.category],
  ['Город', (r) => r.city],
  ['18+', (r) => (r.isAdult ? 'да' : '')],
  ['Длительность, с', (r) => r.duration],
  ['Размер, байт', (r) => r.size],
  ['Записан', (r) => r.recordedAt || r.createdAt],
  ['Ключ в хранилище', (r) => r.key],
  ['Адрес', (r) => r.url],
]);

module.exports = router;
