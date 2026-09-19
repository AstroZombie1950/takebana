// Сообщение переписки в том виде, в каком его получает браузер. Общее
// у маршрутов (routes/streaming/messages.js) и уборки сообщений
// с ограничением (utils/messageLimit.js).

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

function view(m) {
  const sealed = !!(m.limit && m.limit.mode);
  return {
    _id: String(m._id),
    sender: String(m.sender),
    recipient: String(m.recipient),
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
  };
}

module.exports = { view };
