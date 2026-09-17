// Вкладки «Сводка», «Расходы» и «Система».
//
// Сводка открывается первой и должна отвечать быстро, поэтому в ней только
// счётчики по индексам и два прохода по отрезкам эфиров — ничего, что
// перебирает коллекции целиком.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const fs = require('fs');
const mongoose = require('mongoose');
const User = require('../../models/User');
const Stream = require('../../models/Stream');
const StreamSession = require('../../models/StreamSession');
const Recording = require('../../models/Recording');
const Report = require('../../models/Report');
const Establishments = require('../../models/Establishments');
const Call = require('../../models/Call');
const AuditLog = require('../../models/AuditLog');
const ErrorLog = require('../../models/ErrorLog');
const { requireAdmin, requireModerator, sendCsv } = require('./shared');
const usage = require('../../utils/usage');
const health = require('../../utils/health');

const DAY = 86400000;
const since = (ms) => new Date(Date.now() - ms);
// Даты регистрации в схеме нет, но она есть в самом идентификаторе: первые
// четыре байта ObjectId — время создания. Отсюда «сколько пришло за сутки»
// без единого лишнего поля.
const idSince = (ms) => mongoose.Types.ObjectId.createFromTime(Math.floor((Date.now() - ms) / 1000));

const hours = (seconds) => Math.round((seconds || 0) / 360) / 10;

router.get('/summary', requireModerator, async (req, res) => {
  const isAdmin = req.userRole === 'admin';

  const [live, venuesOnline, online, users, usersDay, usersWeek, reportsNew,
         day, week, recordings, errors, loginFails] = await Promise.all([
    Stream.aggregate([{ $match: { isActive: true } }, { $group: { _id: null, n: { $sum: 1 }, viewers: { $sum: '$viewers' } } }]),
    Establishments.countDocuments({ online: true }),
    User.countDocuments({ isOnline: true }),
    User.estimatedDocumentCount(),
    User.countDocuments({ _id: { $gte: idSince(DAY) } }),
    User.countDocuments({ _id: { $gte: idSince(7 * DAY) } }),
    Report.countDocuments({ status: 'new' }),
    StreamSession.aggregate([
      { $match: { startedAt: { $gte: since(DAY) } } },
      { $group: { _id: null, n: { $sum: 1 }, seconds: { $sum: '$duration' }, peak: { $max: '$peakViewers' } } },
    ]),
    StreamSession.aggregate([
      { $match: { startedAt: { $gte: since(7 * DAY) } } },
      { $group: { _id: null, n: { $sum: 1 }, seconds: { $sum: '$duration' }, viewerSeconds: { $sum: '$viewerSeconds' } } },
    ]),
    Recording.aggregate([{ $group: {
      _id: null, n: { $sum: 1 }, bytes: { $sum: '$size' },
      processing: { $sum: { $cond: [{ $eq: ['$status', 'processing'] }, 1, 0] } },
      failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
    } }]),
    isAdmin ? ErrorLog.aggregate([
      { $match: { resolved: false } },
      { $group: { _id: null, groups: { $sum: 1 }, cases: { $sum: '$count' }, fresh: { $sum: { $cond: [{ $gte: ['$lastAt', since(DAY)] }, 1, 0] } } } },
    ]) : [],
    isAdmin ? AuditLog.countDocuments({ action: 'auth.login.fail', at: { $gte: since(DAY) } }) : 0,
  ]);

  const one = (rows) => (rows && rows[0]) || {};
  const l = one(live);
  const d = one(day);
  const w = one(week);
  const r = one(recordings);
  const e = one(errors);

  res.json({
    live: { streams: l.n || 0, viewers: l.viewers || 0, venues: venuesOnline },
    people: { online, total: users, day: usersDay, week: usersWeek },
    reports: { new: reportsNew },
    streams: {
      day: { count: d.n || 0, hours: hours(d.seconds), peak: d.peak || 0 },
      week: { count: w.n || 0, hours: hours(w.seconds), viewerHours: hours(w.viewerSeconds) },
    },
    recordings: { count: r.n || 0, bytes: r.bytes || 0, processing: r.processing || 0, failed: r.failed || 0 },
    errors: isAdmin ? { groups: e.groups || 0, cases: e.cases || 0, fresh: e.fresh || 0, loginFails } : null,
  });
});

// ── По дням ──────────────────────────────────────────────────────────────────
//
// Ряды для графиков сводки. Сутки — по времени Белграда: заведения и зрители
// там, и «вчера» в панели должно значить их вчера, а не вчера по UTC.
// Пустые дни достраиваются нулями здесь же: иначе столбики графика съезжали
// бы, а провал в активности выглядел бы как отсутствие данных.
const TZ = 'Europe/Belgrade';

const dayKey = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: TZ } });

router.get('/summary/daily', requireModerator, async (req, res) => {
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
  const from = since(days * DAY);
  const isAdmin = req.userRole === 'admin';

  const byDay = (Model, match, field, extra = {}) => Model.aggregate([
    { $match: match },
    { $group: { _id: dayKey(field), n: { $sum: 1 }, ...extra } },
  ]);

  const [users, streams, calls, reports, fails] = await Promise.all([
    // Регистрация — время внутри ObjectId, отдельного поля в схеме нет.
    User.aggregate([
      { $match: { _id: { $gte: idSince(days * DAY) } } },
      { $group: { _id: dayKey({ $toDate: '$_id' }), n: { $sum: 1 } } },
    ]),
    byDay(StreamSession, { startedAt: { $gte: from } }, '$startedAt', { seconds: { $sum: '$duration' }, viewerSeconds: { $sum: '$viewerSeconds' } }),
    byDay(Call, { startedAt: { $gte: from } }, '$startedAt'),
    byDay(Report, { createdAt: { $gte: from } }, '$createdAt'),
    isAdmin ? byDay(AuditLog, { at: { $gte: from }, action: 'auth.login.fail' }, '$at') : [],
  ]);

  // Ось дней — от первого до сегодняшнего, в том же поясе, что группировка.
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const axis = [];
  for (let i = days - 1; i >= 0; i--) axis.push(fmt.format(new Date(Date.now() - i * DAY)));

  const series = (rows, pick = (r) => r.n) => {
    const map = new Map(rows.map((r) => [r._id, pick(r)]));
    return axis.map((d) => map.get(d) || 0);
  };

  res.json({
    days: axis,
    series: {
      registrations: series(users),
      streams: series(streams),
      streamHours: series(streams, (r) => Math.round((r.seconds / 3600) * 10) / 10),
      viewerHours: series(streams, (r) => Math.round((r.viewerSeconds / 3600) * 10) / 10),
      calls: series(calls),
      reports: series(reports),
      ...(isAdmin ? { loginFails: series(fails) } : {}),
    },
  });
});

// ── Система ──────────────────────────────────────────────────────────────────
//
// Значения переменных окружения наружу не отдаются никогда — только факт,
// задана она или нет. Панель за ключами не ходит, и держать их в ответе,
// который уйдёт в браузер, незачем.
const ENV_FLAGS = [
  ['SESSION_SECRET', 'Подпись сессий'],
  ['DAILY_API_KEY', 'Ключ Daily'],
  ['DAILY_DOMAIN', 'Домен Daily'],
  ['GOOGLE_CLIENT_ID', 'Вход через Google'],
  ['RESEND_API_KEY', 'Почта (Resend)'],
  ['RTMP_PUBLISH_SECRET', 'Подпись RTMP'],
  ['BUNNY_STORAGE_KEY', 'Хранилище записей'],
  ['BUNNY_API_KEY', 'Статистика Bunny'],
  ['DAILY_USD_PER_MINUTE', 'Цена минуты Daily'],
  ['RECORDINGS_CDN_URL', 'Раздача записей'],
  ['HLS_BASE_URL', 'CDN для эфиров'],
  ['GEOCODER_URL', 'Поиск адресов'],
];

router.get('/system', requireAdmin, async (req, res) => {
  const { HLS_ROOT } = require('../../utils/hls');

  // statfs — свободное место там, где ffmpeg пишет сегменты эфиров: диск,
  // забитый до нуля, гасит все эфиры разом и выглядит как «сломался HLS».
  let disk = null;
  try {
    const st = await fs.promises.statfs(HLS_ROOT);
    disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch (_) {
    // Папки может не быть на свежей машине — это не повод ронять вкладку.
  }

  const [sessions, collections] = await Promise.all([
    mongoose.connection.collection('mySessions').countDocuments(),
    Promise.all([
      ['Люди', User], ['Эфиры и черновики', Stream], ['Отрезки эфиров', StreamSession],
      ['Записи', Recording], ['Жалобы', Report], ['Заведения', Establishments],
      ['Звонки', Call], ['Журнал действий', AuditLog], ['Ошибки', ErrorLog],
    ].map(async ([title, Model]) => ({ title, count: await Model.estimatedDocumentCount() }))),
  ]);

  const mem = process.memoryUsage();

  res.json({
    process: {
      uptime: Math.round(process.uptime()),
      node: process.version,
      pid: process.pid,
      rss: mem.rss,
      heap: mem.heapUsed,
      mode: process.env.START_SERVER || 'default',
    },
    db: {
      state: mongoose.connection.readyState === 1 ? 'connected' : 'down',
      name: mongoose.connection.name || '',
      collections,
      sessions,
    },
    disk,
    env: ENV_FLAGS.map(([key, title]) => ({ key, title, set: !!process.env[key] })),
  });
});

// Проверка сервисов — отдельным запросом: внешние отвечают до пяти секунд,
// а состояние процесса и базы вкладка должна показать сразу.
router.get('/system/checks', requireAdmin, async (req, res) => res.json(await health.run()));

// ── Расходы ──────────────────────────────────────────────────────────────────
//
// Считаем своими метриками. Daily берёт деньги за участнико-минуты: у звонка
// это двое, у веб-эфира — ведущий и наш же RTMP-выход, через который картинка
// уходит в HLS (utils/webLive.js). Зрители веб-эфира в Daily не заходят, они
// смотрят HLS, и в счёт не идут.
//
// Что посчитать своими силами нельзя, так и помечено: трафик CDN знает только
// Bunny, а сколько человек смотрело камеру заведения — только Daily. Сверка
// по их API — следующим заходом, здесь для неё оставлено место.
const costDays = (req) => Math.min(365, Math.max(1, Number(req.query.days) || 30));

async function loadCosts(days) {
  const from = since(days * DAY);

  const [calls, web, obs, recordings, fresh, venueSwitches] = await Promise.all([
    Call.aggregate([
      { $match: { startedAt: { $gte: from }, status: 'answered' } },
      // Разговоры через свой сервер Daily не стоят; ушедший туда посреди
      // звонка считается целиком своим — минуты до перехода не видны.
      { $group: { _id: { $ifNull: ['$path', 'daily'] }, n: { $sum: 1 }, seconds: { $sum: { $cond: [
        { $and: ['$answeredAt', '$endedAt'] },
        { $divide: [{ $subtract: ['$endedAt', '$answeredAt'] }, 1000] },
        0,
      ] } } } },
    ]),
    StreamSession.aggregate([
      { $match: { startedAt: { $gte: from }, source: 'web' } },
      { $group: { _id: null, n: { $sum: 1 }, seconds: { $sum: '$duration' } } },
    ]),
    StreamSession.aggregate([
      { $match: { startedAt: { $gte: from }, source: 'obs' } },
      { $group: { _id: null, n: { $sum: 1 }, seconds: { $sum: '$duration' } } },
    ]),
    Recording.aggregate([{ $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: '$size' }, seconds: { $sum: '$duration' } } }]),
    Recording.aggregate([{ $match: { createdAt: { $gte: from } } }, { $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: '$size' } } }]),
    AuditLog.countDocuments({ action: 'venue.live.on', at: { $gte: from } }),
  ]);

  const one = (rows) => (rows && rows[0]) || {};
  const c = calls.find((r) => r._id === 'daily') || {};
  const own = calls.find((r) => r._id === 'own') || {};
  const wsec = one(web).seconds || 0;
  const callSec = c.seconds || 0;

  return {
    days,
    daily: {
      // Участнико-минуты: звонок — двое, веб-эфир — ведущий и RTMP-выход.
      callMinutes: Math.round((callSec * 2) / 60),
      streamMinutes: Math.round((wsec * 2) / 60),
      calls: c.n || 0,
      webStreams: one(web).n || 0,
      // Камеру заведений Daily тоже считает, но сколько человек в комнате
      // было — знает только он: включений у нас есть, длительности нет.
      venueSwitchOns: venueSwitches,
    },
    bunny: {
      // Хранение — это накопленный объём, а не объём за период.
      storedBytes: one(recordings).bytes || 0,
      storedCount: one(recordings).n || 0,
      addedBytes: one(fresh).bytes || 0,
      addedCount: one(fresh).n || 0,
      trafficBytes: null, // знает только Bunny
    },
    obs: { streams: one(obs).n || 0, hours: hours(one(obs).seconds) },
    ownCalls: { calls: own.n || 0, minutes: Math.round((own.seconds || 0) / 60) },
    // Что мы не измеряем у себя и почему — чтобы цифры не выглядели полными,
    // когда они оценочные.
    unknown: [
      'Письма Resend — журнал отправки не ведётся',
    ],
  };
}

router.get('/costs', requireAdmin, async (req, res) => res.json(await loadCosts(costDays(req))));

// ── Сверка с поставщиками ───────────────────────────────────────────────────
//
// Отдельным запросом, а не частью /costs: Daily и Bunny отвечают секунды,
// изредка — дольше, и свои цифры вкладка должна показать, не дожидаясь их.
const loadProviders = (days) => Promise.all([usage.daily(since(days * DAY), new Date()), usage.bunny(since(days * DAY), new Date())]);

router.get('/costs/providers', requireAdmin, async (req, res) => {
  const days = costDays(req);
  const [daily, bunny] = await loadProviders(days);
  res.json({ days, daily, bunny });
});

// Выгрузка — те же цифры, что на вкладке, строками «раздел — показатель —
// значение»: и своя оценка, и ответ поставщиков. Не ответил поставщик —
// в файле так и написано, а не пустая строка.
router.get('/costs.csv', requireAdmin, async (req, res) => {
  const days = costDays(req);
  const [c, [daily, bunny]] = await Promise.all([loadCosts(days), loadProviders(days)]);

  const rows = [
    ['Период', 'дней', days, ''],
    ['Daily (наша оценка)', 'Звонки', c.daily.callMinutes, 'участнико-минут'],
    ['Daily (наша оценка)', 'Разговоров', c.daily.calls, ''],
    ['Daily (наша оценка)', 'Веб-эфиры', c.daily.streamMinutes, 'участнико-минут'],
    ['Daily (наша оценка)', 'Веб-эфиров', c.daily.webStreams, ''],
    ['Daily (наша оценка)', 'Включений камер заведений', c.daily.venueSwitchOns, ''],
    ['Свой сервер', 'Звонки мимо Daily', c.ownCalls.minutes, 'минут разговора'],
    ['Свой сервер', 'Разговоров мимо Daily', c.ownCalls.calls, ''],
    ['Bunny (наша оценка)', 'Лежит записей', c.bunny.storedCount, ''],
    ['Bunny (наша оценка)', 'Объём записей', c.bunny.storedBytes, 'байт'],
    ['Bunny (наша оценка)', 'Добавилось записей', c.bunny.addedCount, ''],
    ['Bunny (наша оценка)', 'Добавилось объёма', c.bunny.addedBytes, 'байт'],
    ['Своё железо', 'Эфиров с OBS', c.obs.streams, ''],
    ['Своё железо', 'Транскод OBS', c.obs.hours, 'часов'],
  ];

  if (!daily.configured) rows.push(['Daily (по API)', 'ключ не задан', '', '']);
  else if (daily.error) rows.push(['Daily (по API)', 'не ответил', daily.error, '']);
  else {
    rows.push(['Daily (по API)', 'Всего', daily.minutes, 'участнико-минут']);
    if (daily.usd != null) rows.push(['Daily (по API)', 'Стоимость', daily.usd, 'USD']);
    for (const [kind, v] of Object.entries(daily.kinds)) rows.push(['Daily (по API)', `Комнаты ${kind}`, v.minutes, 'участнико-минут']);
  }

  if (!bunny.configured) rows.push(['Bunny (по API)', 'ключ не задан', '', '']);
  else if (bunny.error) rows.push(['Bunny (по API)', 'не ответил', bunny.error, '']);
  else {
    rows.push(['Bunny (по API)', 'Трафик', bunny.bandwidthBytes, 'байт']);
    rows.push(['Bunny (по API)', 'Запросов', bunny.requests, '']);
    if (bunny.storage) rows.push(['Bunny (по API)', 'Хранилище', bunny.storage.bytes, 'байт']);
    if (bunny.spentUsd != null) rows.push(['Bunny (по API)', 'Списано', bunny.spentUsd, 'USD']);
    if (bunny.balanceUsd != null) rows.push(['Bunny (по API)', 'На счёте', bunny.balanceUsd, 'USD']);
  }

  sendCsv(req, res, 'costs', ['Раздел', 'Показатель', 'Значение', 'Единица'], rows);
});

module.exports = router;
