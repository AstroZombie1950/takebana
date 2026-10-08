// Ссылки на людей в описаниях фото, видео и записей (07.10, решение Ивана):
// @ник становится ссылкой на страницу человека на Takebana. Длинные
// описания пишут ради поиска, а ссылки между страницами сайта — та
// перелинковка, без которой они остаются сиротами.
//
// Ссылок на другие сайты в описаниях нет: адрес с http(s):// или www.
// сохранение не принимает (foreign). Адрес профиля на самом Takebana
// (takebana.com/@ник) принимается и хранится как @ник — показывается так же.
// Голое «site.ru» остаётся текстом: ссылкой его не делаем.
const User = require('../models/User');
// Экранирование — то же, что у шаблонов (<%= %>).
const { escapeXML: escapeHtml } = require('ejs');

const NICK = '[a-z][a-z0-9_]{2,19}'; // utils/nickname.js, RULE
const OWN_URL = new RegExp(`(?:https?://)?(?:www\\.)?takebana\\.com/@(${NICK})(?![a-z0-9_])/?`, 'gi');
const FOREIGN = /(?:https?:\/\/|\bwww\.)\S/i;
// Перед @ — не буква и не точка: в почте (anna@mail.ru) упоминания нет.
const MENTION = new RegExp(`(^|[^a-z0-9_@./])@(${NICK})(?![a-z0-9_])`, 'gi');

// Текст к сохранению: адреса профилей — в @ник; foreign — есть чужая ссылка.
function clean(text) {
  const out = String(text || '').replace(OWN_URL, (m, nick) => '@' + nick.toLowerCase());
  return { text: out, foreign: FOREIGN.test(out) };
}

// Текст в HTML для страницы: всё экранировано, @ник существующего
// человека — ссылкой (прежний ник — на нынешнюю страницу). Заблокированных
// не связываем: их страниц в индексе нет.
async function render(text) {
  const src = String(text || '');
  const nicks = new Set();
  for (const m of src.matchAll(MENTION)) nicks.add(m[2].toLowerCase());
  const href = new Map();
  if (nicks.size) {
    const list = [...nicks];
    const users = await User.find({ $or: [{ nickname: { $in: list } }, { formerNicknames: { $in: list } }], banned: { $ne: true } })
      .select('nickname formerNicknames').lean();
    for (const u of users) if (u.nickname) href.set(u.nickname, u.nickname);
    for (const u of users) for (const old of u.formerNicknames || []) if (nicks.has(old) && !href.has(old)) href.set(old, u.nickname);
  }
  let html = '';
  let at = 0;
  for (const m of src.matchAll(MENTION)) {
    const to = href.get(m[2].toLowerCase());
    if (!to) continue;
    const start = m.index + m[1].length;
    html += escapeHtml(src.slice(at, start)) + `<a href="/@${to}" class="tk-mention">@${escapeHtml(m[2])}</a>`;
    at = start + 1 + m[2].length;
  }
  return html + escapeHtml(src.slice(at));
}

module.exports = { clean, render, FOREIGN_MESSAGE: 'Ссылки в описании — только на людей Takebana: @ник' };
