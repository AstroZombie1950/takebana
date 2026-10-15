// Баланс Bunny (15.10.2026). Предела объёма у Bunny нет — платим за
// гигабайт, и настоящий предел — деньги на счёте: кончатся — Bunny
// остановит раздачу записей, галереи, переписки и эфиров разом.
//
// Раз в час спрашиваем баланс (api.bunny.net/billing, ключ аккаунта
// BUNNY_API_KEY). Ниже порога из панели (utils/limits.js, bunnyMinUsd;
// 0 — не следить) — строка в «Ошибки» раз в сутки, пока не пополнят;
// вкладка «Хранилище» показывает баланс и порог (state()).

const errorLog = require('./errorLog');
const limits = require('./limits');

const EVERY_MS = 3600 * 1000;
const REPEAT_MS = 24 * 3600 * 1000;

let last = null; // { usd, at } или { error, at }
let warnedAt = 0;

async function check() {
  if (!process.env.BUNNY_API_KEY) return null;
  try {
    const res = await fetch('https://api.bunny.net/billing', {
      headers: { AccessKey: process.env.BUNNY_API_KEY, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Bunny billing ${res.status}`);
    const d = await res.json();
    last = { usd: Math.round((Number(d.Balance) || 0) * 100) / 100, monthUsd: Math.round((Number(d.ThisMonthCharges) || 0) * 100) / 100, at: new Date() };
  } catch (e) {
    last = { error: e.message, at: new Date() };
    errorLog.external(e, 'bunny.balance.read');
    return last;
  }
  const min = limits.get().bunnyMinUsd;
  if (min > 0 && last.usd < min && Date.now() - warnedAt > REPEAT_MS) {
    warnedAt = Date.now();
    errorLog.external(new Error('Баланс Bunny ниже порога — пополните счёт, иначе раздача остановится'), 'bunny.balance', { usd: last.usd, minUsd: min });
  }
  if (last.usd >= min) warnedAt = 0;
  return last;
}

function start() {
  if (!process.env.BUNNY_API_KEY) return;
  setTimeout(check, 30 * 1000).unref();
  setInterval(check, EVERY_MS).unref();
}

// Для «Хранилища»: баланс, порог, ниже ли.
const state = () => ({
  configured: !!process.env.BUNNY_API_KEY,
  ...(last || {}),
  minUsd: limits.get().bunnyMinUsd,
  low: !!(last && last.usd != null && limits.get().bunnyMinUsd > 0 && last.usd < limits.get().bunnyMinUsd),
});

module.exports = { start, check, state };
