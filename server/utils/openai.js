// OpenAI по API (24.10.2026): перевод текста и расшифровка речи
// (docs/TRANSLATE.md). Ключ — OPENAI_API_KEY в .env; без него функции
// перевода выключены, а не сломаны.
//
// Только fetch, без пакета openai: два маршрута, библиотека ради них — лишний
// вес. Ошибка поставщика — исключение с status и текстом ответа; ловит
// и пишет в журнал тот, кто вызывал.

const API = 'https://api.openai.com/v1';
const TIMEOUT_MS = 30 * 1000;
const AUDIO_TIMEOUT_MS = 90 * 1000;

const configured = () => Boolean(process.env.OPENAI_API_KEY);

// Лимит частоты (429) и сбой у поставщика (5xx) — ещё две попытки
// с паузой, как просит retry-after, иначе 1 и 2 с.
const RETRIES = 2;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, body, timeout) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body instanceof FormData ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
      const after = Number(res.headers.get('retry-after'));
      await wait(after > 0 && after < 30 ? after * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    return parse(path, res);
  }
}

async function parse(path, res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`OpenAI ${path}: ${res.status} ${(data.error && data.error.message) || ''}`.trim());
    err.status = res.status;
    throw err;
  }
  return data;
}

// effort — reasoning_effort у моделей с рассуждением ('none', у gpt-5 —
// 'minimal'); у прочих не передаётся: они на него отвечают ошибкой.
// Рассуждение оплачивается как выход и входит в completion_tokens.
async function chat({ model, system, user, effort }) {
  const t0 = Date.now();
  const data = await call('/chat/completions', {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    ...(effort ? { reasoning_effort: effort } : {}),
  }, TIMEOUT_MS);
  const u = data.usage || {};
  return {
    text: String((data.choices && data.choices[0] && data.choices[0].message.content) || '').trim(),
    tokensIn: u.prompt_tokens || 0,
    tokensOut: u.completion_tokens || 0,
    ms: Date.now() - t0,
  };
}

// Расшифровка файла. usage у моделей gpt-4o-* — в токенах
// ({ type: 'tokens', input_tokens, output_tokens }), у прочих — в секундах
// или нет вовсе; цену из него считает вызывающий.
async function transcribe({ model, buffer, filename, mime }) {
  const t0 = Date.now();
  const form = new FormData();
  form.append('model', model);
  form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);
  form.append('response_format', 'json');
  const data = await call('/audio/transcriptions', form, AUDIO_TIMEOUT_MS);
  return { text: String(data.text || '').trim(), usage: data.usage || null, ms: Date.now() - t0 };
}

module.exports = { configured, chat, transcribe };
