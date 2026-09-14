// Письма сайта: пока только восстановление пароля.
//
// Отправка — через HTTP API Resend (рекомендован заказчику, temp/SERVICES.md):
// один POST, без пакета и без SMTP. Сменить поставщика — переписать sendMail.
//
// Без RESEND_API_KEY:
//   на бою (START_SERVER=prod или NODE_ENV=production) почта считается
//   не настроенной, и ссылки «Забыли пароль?» на странице входа нет —
//   нерабочая ссылка хуже отсутствующей, как и кнопка Google без ключей;
//   локально письмо печатается в консоль сервера, чтобы проверить путь целиком.

const PROD = process.env.START_SERVER === 'prod' || process.env.NODE_ENV === 'production';
const API_KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.MAIL_FROM || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// Адрес в письме берётся из настройки, а не из заголовка Host запроса:
// иначе подставной Host превращает письмо со ссылкой в ссылку на чужой сайт.
const mailConfigured = PROD ? Boolean(API_KEY && FROM && PUBLIC_URL) : true;

if (PROD && !mailConfigured) {
  console.warn('Почта не настроена: нет RESEND_API_KEY / MAIL_FROM / PUBLIC_URL. Восстановление пароля отключено.');
}

function siteUrl(path) {
  return (PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 3000}`) + path;
}

async function sendMail({ to, subject, text, html }) {
  if (!API_KEY) {
    console.log(`[mail] RESEND_API_KEY не задан, письмо не отправлено\n  кому: ${to}\n  тема: ${subject}\n${text}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Resend ответил ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

module.exports = { mailConfigured, siteUrl, sendMail };
