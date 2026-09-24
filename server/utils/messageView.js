// Сообщение переписки в том виде, в каком его получает браузер. Общее
// у маршрутов (routes/streaming/messages.js) и уборки сообщений
// с ограничением (utils/messageLimit.js).

const Message = require('../models/Message');

// Поля оригинала, из которых собирается цитата ответа.
const QUOTED = 'sender content attachments limit expiredAt';

// Вложение: без ключей хранилища. sealed — сообщение с ограничением: ни адреса
// файла, ни превью, пока его не открыли (их выдаёт /messages/:id/open).
function attachmentView(a, sealed) {
  const out = { kind: a.kind, name: a.name || '', size: a.size || 0 };
  if (!sealed) {
    out.url = a.url;
    if (a.preview) out.preview = a.preview;
  }
  if (a.width) { out.width = a.width; out.height = a.height; }
  if (a.duration) out.duration = a.duration;
  if (a.wave && a.wave.length) out.wave = a.wave;
  return out;
}

// Условия и сколько осталось — видят оба, содержимого здесь нет.
function limitView(l) {
  return {
    mode: l.mode,
    n: l.n || 0,
    seconds: l.seconds || 0,
    used: l.used || 0,
    opened: !!l.openedAt,
    until: l.mode === 'timer' && l.openedAt ? l.expiresAt : null,
  };
}

// Цитата ответа. Оригинала нет (удалён) или он исчез — только отметка.
// У сообщения с ограничением — лишь вид: текст и превью закрыты, как и в
// самой ленте. thumb — превью фото или кадр видео для значка в цитате.
function replyView(id, o) {
  if (!o || o.expiredAt) return { id: String(id), gone: true };
  const sealed = !!(o.limit && o.limit.mode);
  const a = o.attachments && o.attachments[0];
  const out = { id: String(o._id), sender: String(o.sender), text: sealed ? '' : String(o.content || '').slice(0, 140), kind: a ? a.kind : '', sealed };
  const thumb = !sealed && a && (a.preview || (a.kind === 'image' && a.url));
  if (thumb) out.thumb = thumb;
  return out;
}

// original — сообщение, на которое это отвечает, если оно есть (replyTo).
function view(m, original) {
  const sealed = !!(m.limit && m.limit.mode);
  return {
    _id: String(m._id),
    sender: String(m.sender),
    recipient: m.recipient ? String(m.recipient) : null,
    // Текст сообщения с ограничением — тоже только при открытии.
    content: sealed ? '' : m.content || '',
    attachments: (m.attachments || []).map((a) => attachmentView(a, sealed)),
    limit: sealed ? limitView(m.limit) : null,
    expired: !!m.expiredAt,
    sentAt: m.sentAt,
    deliveredAt: m.deliveredAt || null,
    readAt: m.readAt || null,
    forwardedFrom: m.forwardedFrom && m.forwardedFrom.name
      ? { name: m.forwardedFrom.name, sentAt: m.forwardedFrom.sentAt || null, batch: m.forwardedFrom.batch || null }
      : null,
    reply: m.replyTo ? replyView(m.replyTo, original) : null,
    system: m.system && m.system.kind ? {
      kind: m.system.kind, actor: m.system.actor ? String(m.system.actor) : null, actorName: m.system.actorName || '',
      target: m.system.target ? String(m.system.target) : null, targetName: m.system.targetName || '', text: m.system.text || '',
    } : null,
  };
}

// Страница ленты: цитаты всех ответов — одним запросом.
async function viewAll(list) {
  const ids = list.map((m) => m.replyTo).filter(Boolean);
  const originals = ids.length ? await Message.find({ _id: { $in: ids } }).select(QUOTED).lean() : [];
  const byId = new Map(originals.map((o) => [String(o._id), o]));
  return list.map((m) => view(m, m.replyTo && byId.get(String(m.replyTo))));
}

module.exports = { view, viewAll, QUOTED };
