// Полигон перевода (utils/translateLab.js, 24.10.2026): страница
// /lab/translate и её запросы. Только администратору, как /calc: остальным —
// «нет такой». Каждый запрос тратит деньги на OpenAI, поэтому частота
// ограничена, а длина текста и голосового — тоже.

const express = require('express');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { asyncify } = require('../middleware/asyncRouter');
const User = require('../models/User');
const lab = require('../utils/translateLab');
const openai = require('../utils/openai');
const { contentLang } = require('../utils/contentLang');
const { MAX_CHARS } = require('../utils/translate');

const router = express.Router();
asyncify(router);

const MAX_AUDIO_SEC = 120;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

async function adminOnly(req, res, next) {
  const id = req.session && req.session.userId;
  const me = id ? await User.findById(id).select('role').lean() : null;
  if (me && me.role === 'admin') return next();
  if (req.path.startsWith('/api/')) return res.status(404).json({ message: 'Не найдено' });
  return next('router');
}

const tryLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  keyGenerator: (req) => 'u:' + req.session.userId,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Слишком часто — подождите несколько минут.' },
});

// Модели из запроса — только из списка полигона; пусто — все.
function pick(list, ids) {
  const want = [].concat(ids || []).map(String);
  const got = list.filter((m) => want.includes(m.id));
  return got.length ? got : list;
}

const notReady = (res) => res.status(503).json({ message: 'Ключ OpenAI не задан на сервере (OPENAI_API_KEY).' });

router.get('/lab/translate', adminOnly, (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(__dirname, '..', 'views', 'translateLab.html'));
});

router.get('/api/lab/translate/state', adminOnly, async (req, res) => {
  res.json(await lab.state());
});

router.get('/api/lab/translate/job', adminOnly, (req, res) => {
  res.json(lab.runStatus());
});

router.post('/api/lab/translate/run', adminOnly, async (req, res) => {
  if (!openai.configured()) return notReady(res);
  const started = await lab.runSet(req.session.userId);
  res.json({ started, job: lab.runStatus() });
});

router.post('/api/lab/translate/text', adminOnly, tryLimiter, async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ message: 'Пустой текст' });
  if (text.length > MAX_CHARS) return res.status(400).json({ message: `Не длиннее ${MAX_CHARS} знаков` });
  if (!openai.configured()) return notReady(res);
  const lang = contentLang(text);
  const { results, usd } = await lab.translateAll(text, lang, pick(lab.TEXT_MODELS, req.body.models));
  await lab.addSpent(usd, req.session.userId, 'text', text);
  res.json({ lang, results, usd, money: await lab.spent() });
});

// Голосовое: каждой выбранной моделью распознавания, расшифровка первой —
// выбранными моделями перевода.
router.post('/api/lab/translate/voice', adminOnly, tryLimiter, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Нет записи' });
  const sec = Number(req.body.seconds);
  if (!(sec > 0) || sec > MAX_AUDIO_SEC) return res.status(400).json({ message: `Голосовое — до ${MAX_AUDIO_SEC} секунд` });
  if (!openai.configured()) return notReady(res);
  const speech = pick(lab.SPEECH_MODELS, String(req.body.speech || '').split(','));
  const text = pick(lab.TEXT_MODELS, String(req.body.models || '').split(','));
  const mime = req.file.mimetype;
  const ext = /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /mpeg|mp3/.test(mime) ? 'mp3' : /wav/.test(mime) ? 'wav' : 'webm';
  const heard = await lab.transcribeAll(req.file.buffer, `voice.${ext}`, mime, sec, speech);
  const base = heard.results[speech[0].id];
  let lang = '';
  let translated = {};
  let usd = heard.usd;
  if (base.text) {
    lang = contentLang(base.text);
    const tr = await lab.translateAll(base.text, lang, text);
    translated = tr.results;
    usd += tr.usd;
  }
  await lab.addSpent(usd, req.session.userId, 'voice', `${Math.round(sec)} с: ${base.text || '—'}`);
  res.json({ heard: heard.results, base: speech[0].id, lang, translated, usd, money: await lab.spent() });
});

module.exports = router;
