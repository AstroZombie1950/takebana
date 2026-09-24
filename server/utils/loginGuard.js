// Защита от подбора пароля.
//
// Лимит на адрес (middleware/rateLimit.js) не видит подбора одного аккаунта
// с сотни адресов и не отличает «ошибся трижды» от «перебирает». Здесь —
// счётчики ошибок (models/LoginAttempt.js) и две ступени:
//
//  1. После трёх ошибок — невидимая проверка: браузер ищет число, с которым
//     SHA-256 от выданной строки начинается с нужного числа нулевых бит
//     (public/tk-auth.js). Человек видит полсекунды «Проверяем…», скрипту
//     каждая попытка стоит процессорного времени. С новыми ошибками аккаунта
//     задача тяжелеет. Ошибки адреса (перебор разных почт) только включают
//     её: за одним адресом мобильного оператора сидят тысячи людей, и
//     тяжёлая задача досталась бы всем.
//  2. После пяти ошибок подряд — пауза 1, 5, затем 15 минут. Паузу ставим
//     на пару «аккаунт + адрес», а не на аккаунт целиком: иначе кто угодно
//     держал бы чужой аккаунт запертым, нарочно ошибаясь. По аккаунту в целом
//     включается только проверка. Сброс пароля по почте снимает всё.
//
// Несуществующая почта считается так же, как настоящая: иначе пауза
// или проверка выдавали бы, что аккаунт есть.

const crypto = require('crypto');
const { ipKeyGenerator } = require('express-rate-limit');
const LoginAttempt = require('../models/LoginAttempt');
const { clientIp } = require('./audit');
const { langOf, tr } = require('./i18n');

const FREE = 3;                  // ошибок без проверки
const STREAK = 5;                // ошибок подряд до паузы
const PAUSE_MIN = [1, 5, 15];    // после 5-й, 10-й, 15-й и дальше
const BITS = [16, 19];           // сложность: от ~0,1 с на компьютере и ~0,5 с на телефоне до в 8 раз дольше
const TASK_TTL = 10 * 60 * 1000;

// Ключ подписи задач живёт, пока живёт процесс: после перезапуска старые
// задачи недействительны, браузер получит новую и решит её сам.
const KEY = crypto.randomBytes(32);
// Решённые задачи: одна задача — одна попытка. Процесс один
// (ops/ecosystem.config.js), так что хватает памяти.
const spent = new Map();

const bitsFor = (fails) => Math.min(BITS[0] + Math.max(fails - FREE, 0), BITS[1]);
const sign = (task, email) => crypto.createHmac('sha256', KEY).update(task + '|' + email).digest('base64url').slice(0, 22);

function issue(email, bits) {
  const task = `${Date.now() + TASK_TTL}.${bits}.${crypto.randomBytes(9).toString('base64url')}`;
  return task + '.' + sign(task, email);
}

function zeroBits(hash) {
  let n = 0;
  for (const b of hash) {
    if (b) return n + Math.clz32(b) - 24;
    n += 8;
  }
  return n;
}

// Ответ браузера: «задача:число».
function solved(answer, email, need) {
  const m = /^((\d{13})\.(\d{2})\.([\w-]{12}))\.([\w-]{22}):(\d{1,12})$/.exec(answer || '');
  if (!m) return false;
  const [, task, exp, bits, id, sig] = m;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(task, email)))) return false;
  const now = Date.now();
  if (Number(exp) < now || Number(bits) < need || spent.has(id)) return false;
  if (zeroBits(crypto.createHash('sha256').update(answer).digest()) < Number(bits)) return false;
  for (const [k, until] of spent) if (until < now) spent.delete(k);
  spent.set(id, Number(exp));
  return true;
}

function pauseText(req, until) {
  const min = Math.ceil((until - Date.now()) / 60000);
  return tr(langOf(req), 'Слишком много неудачных попыток. Попробуйте через {min} мин. или восстановите пароль', { min });
}

const bump = (key, by, at) => LoginAttempt.findOneAndUpdate(
  { key }, { $inc: { fails: by }, $set: { updatedAt: at } }, { upsert: true, returnDocument: 'after' },
).lean();

// Перед проверкой пароля. Вернула null — ответ уже отправлен (пауза или
// нужна проверка). Иначе — попытка, у которой после сверки пароля зовут
// fail(сообщение) или ok(). task: false — без проверки, только пауза:
// для форм внутри кабинета, где пароль спрашивают у вошедшего.
async function start(req, res, email, { task = true } = {}) {
  const ip = ipKeyGenerator(clientIp(req));
  const pair = `p:${email}|${ip}`, acct = `a:${email}`, addr = `i:${ip}`;
  const now = new Date();

  const paused = await LoginAttempt.findOne({ key: pair, lockedUntil: { $gt: now } }).select('lockedUntil').lean();
  if (paused) {
    res.locals.guardSoft = true;
    res.status(429).json({ message: pauseText(req, paused.lockedUntil) });
    return null;
  }

  // Пару считаем до сверки пароля: одновременные запросы получают разные
  // номера, и пачка параллельных не проскакивает мимо проверки. Аккаунт
  // и адрес — только после ошибки: удачный вход их не трогает и не продлевает.
  const [p, a, i] = await Promise.all([
    bump(pair, 1, now),
    LoginAttempt.findOne({ key: acct }).select('fails').lean(),
    LoginAttempt.findOne({ key: addr }).select('fails').lean(),
  ]);
  const own = Math.max(p.fails - 1, a ? a.fails : 0);
  const any = Math.max(own, i ? i.fails : 0);

  if (task && any >= FREE && !solved(req.body.task, email, bitsFor(own))) {
    await bump(pair, -1, now);
    res.locals.guardSoft = true;
    res.status(428).json({ message: 'Подтвердите, что вы не робот', task: issue(email, bitsFor(own)) });
    return null;
  }

  return {
    async fail(message) {
      await Promise.all([bump(acct, 1, now), bump(addr, 1, now)]);
      if (p.fails % STREAK === 0) {
        const until = new Date(Date.now() + PAUSE_MIN[Math.min(p.fails / STREAK, PAUSE_MIN.length) - 1] * 60000);
        await LoginAttempt.updateOne({ key: pair }, { $set: { lockedUntil: until } });
        return res.status(429).json({ message: pauseText(req, until) });
      }
      const lang = langOf(req);
      const left = STREAK - p.fails % STREAK;
      const body = { message: tr(lang, message) };
      if (left === 2) body.message += ' ' + tr(lang, 'Осталось две попытки, потом вход приостановится');
      if (left === 1) body.message += ' ' + tr(lang, 'Осталась одна попытка, потом вход приостановится');
      // Задача на следующую попытку — сразу: браузер решает её, пока человек
      // набирает пароль заново.
      if (task && any + 1 >= FREE) body.task = issue(email, bitsFor(own + 1));
      return res.status(400).json(body);
    },
    // Вход удался: ошибки аккаунта забыты. Счётчик адреса остаётся —
    // иначе вход в свой аккаунт обнулял бы перебор чужих.
    ok: () => LoginAttempt.deleteMany({ key: { $in: [pair, acct] } }),
  };
}

// Пароль сброшен по ссылке из письма — ошибки по аккаунту со всех адресов.
function forget(email) {
  const prefix = ('p:' + email + '|').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return LoginAttempt.deleteMany({ $or: [{ key: 'a:' + email }, { key: { $regex: '^' + prefix } }] });
}

module.exports = { start, forget };
