// Панель диалога (17.10): медиа, файлы, голосовые и публикации одного
// диалога, поиск по переписке, закреплённое сообщение, «без звука».
// Одно и то же у личного диалога (models/Conversation.js) и группы
// (models/Group.js): у сообщений обоих conversationId — id диалога.
// Маршруты — routes/chatInfo.js, страница — public/tk-chatinfo.js.
//
// Сюда же — страница ленты по времени в обе стороны (historyPage): переход
// к найденному или закреплённому сообщению загружает ленту вокруг него,
// а не листает историю назад страницами, пока не дойдёт.
//
// Чего во вкладках и поиске нет никогда: исчезающих (их содержимое закрыто
// до открытия, utils/messageLimit.js — вкладка открыла бы его в обход
// счёта просмотров), исчезнувших, служебных строк групп и удалённого «у меня».

const Message = require('../models/Message');
const { attachmentView, replyView, QUOTED } = require('./messageView');

// Что в какой вкладке. «Файлы» — документы и музыка: и то и другое
// скачивают, а не смотрят.
const TABS = {
  media: ['image', 'video'],
  files: ['file', 'audio'],
  voice: ['voice', 'round'],
};
const TAB_PAGE = { media: 45, files: 30, voice: 30, shares: 30 };
const SEARCH_PAGE = 30;
const QUERY_MAX = 100;
// Поиск — обычным выражением по тексту одного диалога, по индексу диалога.
// Длинная переписка без совпадений просматривается целиком; потолок
// времени не даёт одному запросу занять базу.
const SEARCH_MS = 4000;

function visible(conversationId, me) {
  return {
    conversationId,
    deletedFor: { $ne: me },
    'limit.mode': { $exists: false },
    expiredAt: null,
    system: { $exists: false },
  };
}

// Текст запроса — в выражение: спецсимволы буквально, без регистра,
// «е» и «ё» — одна буква (как в поиске контактов, public/chats.js).
function pattern(q) {
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[её]/gi, '[её]');
  return new RegExp(safe, 'i');
}

// Кусок текста вокруг совпадения: найденное слово не должно уходить за край.
function snippet(text, rx) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const at = s.search(rx);
  if (at < 50 || s.length <= 160) return s.length <= 160 ? s : s.slice(0, 159) + '…';
  const from = Math.max(0, at - 40);
  const cut = s.slice(from, from + 160);
  return '…' + cut + (from + 160 < s.length ? '…' : '');
}

function cutBefore(query, before) {
  return before ? { ...query, sentAt: { $lt: before } } : query;
}

// Вкладка панели: страница от свежих к старым. before — время последнего
// показанного. q — поиск по имени файла во вкладке «Файлы».
async function tab(conversationId, me, name, { before, q } = {}) {
  const size = TAB_PAGE[name];
  let query = visible(conversationId, me);
  if (name === 'shares') query['share.kind'] = { $exists: true };
  else query['attachments.kind'] = { $in: TABS[name] };
  if (name === 'files' && q) query['attachments.name'] = pattern(q);
  query = cutBefore(query, before);

  const rows = await Message.find(query).sort({ sentAt: -1 }).limit(size + 1)
    .select('sender sentAt attachments share').lean();
  const more = rows.length > size;
  if (more) rows.pop();
  const kinds = TABS[name] || [];
  const items = [];
  for (const m of rows) {
    const base = { id: String(m._id), sender: String(m.sender), sentAt: m.sentAt };
    if (name === 'shares') {
      const s = m.share;
      items.push({ ...base, share: { kind: s.kind, url: s.url, title: s.title || '', image: s.image || '', author: s.author || '' } });
      continue;
    }
    for (const a of m.attachments) if (kinds.includes(a.kind)) items.push({ ...base, a: attachmentView(a, false) });
  }
  return { items, before: more ? rows[rows.length - 1].sentAt : null };
}

// Поиск по тексту и подписям к вложениям. Пересланное — тоже: это текст
// переписки. Совпадения — от свежих.
async function search(conversationId, me, q, before) {
  const rx = pattern(q);
  const rows = await Message.find(cutBefore({ ...visible(conversationId, me), content: rx }, before))
    .sort({ sentAt: -1 }).limit(SEARCH_PAGE + 1)
    .select('sender sentAt content attachments share')
    .maxTimeMS(SEARCH_MS)
    .lean();
  const more = rows.length > SEARCH_PAGE;
  if (more) rows.pop();
  return {
    hits: rows.map((m) => ({
      id: String(m._id),
      sender: String(m.sender),
      sentAt: m.sentAt,
      text: snippet(m.content, rx),
      kind: m.attachments && m.attachments[0] ? m.attachments[0].kind : m.share && m.share.kind ? 'share' : '',
    })),
    before: more ? rows[rows.length - 1].sentAt : null,
  };
}

// ── Лента по времени ─────────────────────────────────────────────────────
// Один из трёх видов страницы:
//   before — старше этого времени (без него — последние): прокрутка вверх;
//   after  — новее этого времени: прокрутка вниз после перехода;
//   around — сообщение и по странице с каждой стороны: переход к нему.
// older/newer — есть ли ещё в ту сторону; from/to — отрезок для звонков
// двоих в ленте (utils/callLog.js, between: from включительно, to — нет).
// null — сообщения around в диалоге нет (удалено или чужое).
async function historyPage(conversationId, me, { before, after, around } = {}, size) {
  const base = { conversationId, deletedFor: { $ne: me } };
  if (around) {
    const target = await Message.findOne({ ...base, _id: around }).select('sentAt').lean();
    if (!target) return null;
    const [older, newer] = await Promise.all([
      Message.find({ ...base, sentAt: { $lt: target.sentAt } }).sort({ sentAt: -1 }).limit(size).lean(),
      Message.find({ ...base, sentAt: { $gte: target.sentAt } }).sort({ sentAt: 1 }).limit(size + 1).lean(),
    ]);
    const extra = newer.length > size ? newer.pop() : null;
    return {
      list: older.reverse().concat(newer),
      older: older.length === size,
      newer: !!extra,
      from: older.length === size ? older[0].sentAt : null,
      to: extra ? extra.sentAt : null,
    };
  }
  if (after) {
    const rows = await Message.find({ ...base, sentAt: { $gt: after } }).sort({ sentAt: 1 }).limit(size + 1).lean();
    const extra = rows.length > size ? rows.pop() : null;
    return { list: rows, older: true, newer: !!extra, from: after, to: extra ? extra.sentAt : null };
  }
  const rows = await Message.find(cutBefore(base, before)).sort({ sentAt: -1 }).limit(size).lean();
  return {
    list: rows.reverse(),
    older: rows.length === size,
    newer: false,
    from: rows.length === size ? rows[0].sentAt : null,
    to: before || null,
  };
}

// ── Закреплённое ─────────────────────────────────────────────────────────
// Закрепить можно обычное сообщение: не исчезающее (его текст закрыт),
// не служебную строку и не удалённое у себя.
function pinnable(conversationId, me, id) {
  return Message.findOne({ ...visible(conversationId, me), _id: id }).select(QUOTED).lean();
}

// Полоса над лентой — в виде цитаты ответа (utils/messageView.js). Удалили
// «у всех» или удалили у себя — полосы нет.
async function pinnedView(conversationId, me, id) {
  if (!id) return null;
  const m = await Message.findOne({ conversationId, _id: id, deletedFor: { $ne: me } }).select(QUOTED).lean();
  const out = m && replyView(id, m);
  return out && !out.gone ? out : null;
}

// ── Без звука ────────────────────────────────────────────────────────────
// Срок у каждого свой (models/Conversation.js, muted). Варианты — те же,
// что в панели (public/tk-chatinfo.js): час, 8 часов, двое суток, «пока
// не включу» — год.
const MUTE_HOURS = [0, 1, 8, 48, 24 * 365];

function mutedUntil(conversation, userId) {
  const row = (conversation && conversation.muted || []).find((m) => String(m.user) === String(userId));
  return row && row.until > new Date() ? row.until : null;
}

module.exports = { TABS, TAB_PAGE, QUERY_MAX, MUTE_HOURS, tab, search, historyPage, pinnable, pinnedView, mutedUntil };
