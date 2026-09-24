// Приватность: кто может писать, звонить, добавлять в группы, видеть
// «в сети» и комментировать; виден ли человек в поиске (решение 24.09.2026).
// Настройки — в User.privacy, меняются на /settings (routes/userRoutes.js).
//
// «Контакты» — те, кого человек сам записал себе (models/Contact.js): связь
// односторонняя, как в телефонной книжке. Значит, «звонить могут контакты» —
// это «могут те, кого я записал», а не те, кто записал меня.
//
// Рядом живёт ограничение доступа (utils/restrict.js) — это про отдельного
// человека. Здесь — правило для всех сразу; проверяются оба.
//
// Официальные аккаунты — администраторы — настройкам не подчиняются: иначе
// поддержке не ответить тому, кто закрыл личку, и рассылка дойдёт не до всех.

const User = require('../models/User');
const Contact = require('../models/Contact');
const Subscription = require('../models/Subscription');

const DEFAULTS = { messages: 'all', calls: 'all', groups: 'all', presence: 'all', comments: 'all', searchable: true };
const OPTIONS = {
  // requests — пишут все, но незнакомые попадают в «Заявки»
  messages: ['all', 'requests', 'contacts', 'nobody'],
  calls: ['all', 'contacts', 'nobody'],
  groups: ['all', 'contacts', 'nobody'],
  presence: ['all', 'contacts', 'nobody'],
  comments: ['all', 'followers', 'nobody'],
};

const same = (a, b) => String(a) === String(b);
const isOfficial = (user) => !!user && user.role === 'admin';

function of(user) {
  const p = (user && user.privacy) || {};
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = p[key] == null ? DEFAULTS[key] : p[key];
  return out;
}

// Отказ — русский текст для ответа (перевод — utils/i18n.js).
const REFUSED = {
  messages: { contacts: 'Человек принимает сообщения только от своих контактов', nobody: 'Человек не принимает новые сообщения' },
  calls: { contacts: 'Человек принимает звонки только от своих контактов', nobody: 'Человек не принимает звонки' },
  groups: { contacts: 'Добавить в группу этого человека могут только его контакты', nobody: 'Этот человек не разрешает добавлять себя в группы' },
  comments: { followers: 'Автор принимает комментарии только от подписчиков', nobody: 'Автор закрыл комментарии' },
};

// Решение по одному действию: actor хочет написать, позвонить, добавить
// или прокомментировать owner. Ответ:
//   { ok: true }                  — можно;
//   { ok: true, request: true }   — можно, но заявкой (только messages);
//   { ok: false, rule, message }  — нельзя, rule — какое правило не пустило.
// owner и actor — id; оба читаются одним запросом.
async function decide(kind, ownerId, actorId) {
  if (!ownerId || !actorId || same(ownerId, actorId)) return { ok: true };
  const both = await User.find({ _id: { $in: [ownerId, actorId] } }).select('privacy role').lean();
  const o = both.find((u) => same(u._id, ownerId));
  const a = both.find((u) => same(u._id, actorId));
  if (!o) return { ok: true }; // кого нет — ответит сам маршрут, 404
  if (isOfficial(a)) return { ok: true };
  const rule = of(o)[kind];
  if (rule === 'all') return { ok: true };
  if (rule !== 'nobody') {
    const known = rule === 'followers'
      ? await Subscription.exists({ subscriberId: actorId, subscribedToId: o._id })
      : await Contact.exists({ owner: o._id, peer: actorId });
    if (known) return { ok: true };
    if (rule === 'requests') return { ok: true, request: true };
  }
  return { ok: false, rule, message: REFUSED[kind][rule] };
}

// Можно ли писать в эту переписку. Начатую не трогаем (решение 24.09):
// правило действует на новых собеседников. Начатая — та, где уже есть
// сообщения и нет заявки. Ответ получателя заявку принимает (поле снимает
// вызывающий, routes/streaming/messages.js). Её автору правило читается
// заново: получатель мог записать его в контакты или открыть личку —
// тогда заявка принимается сама; мог и закрыть — тогда отказ.
async function messageGate(conversation, senderId, recipientId) {
  if (conversation && conversation.requestFor) {
    if (!same(conversation.requestFor, recipientId)) return { ok: true, accept: true };
    const now = await decide('messages', recipientId, senderId);
    if (!now.ok) return now;
    return now.request ? { ok: true, request: true } : { ok: true, accept: true };
  }
  if (conversation && conversation.lastMessage) return { ok: true };
  return decide('messages', recipientId, senderId);
}

// Кого из людей viewer видит «в сети». Остальным isOnline и lastSeen
// стираются прямо в переданных документах — дальше их рисует кто угодно.
// Гость (viewer пуст) — не контакт никому.
async function maskPresence(viewer, users) {
  const list = (users || []).filter(Boolean);
  if (!list.length) return users;
  const ids = list.map((u) => u._id).filter((id) => !viewer || !same(id, viewer));
  if (!ids.length) return users;
  const closed = await User.find({ _id: { $in: ids }, 'privacy.presence': { $in: ['contacts', 'nobody'] } })
    .select('privacy.presence').lean();
  if (!closed.length) return users;
  const byContacts = closed.filter((u) => u.privacy.presence === 'contacts').map((u) => u._id);
  const open = new Set(viewer && byContacts.length
    ? (await Contact.find({ owner: { $in: byContacts }, peer: viewer }).select('owner').lean()).map((c) => String(c.owner))
    : []);
  const hidden = new Set(closed.map((u) => String(u._id)).filter((id) => !open.has(id)));
  for (const u of list) {
    if (!hidden.has(String(u._id))) continue;
    u.isOnline = false;
    u.lastSeen = null;
    u.presenceHidden = true;
  }
  return users;
}

// Кого из ids viewer может видеть «в сети» — для подписки сокета.
async function presenceVisible(viewer, ids) {
  const docs = ids.map((id) => ({ _id: id }));
  await maskPresence(viewer, docs);
  return docs.filter((d) => !d.presenceHidden).map((d) => String(d._id));
}

// Условие выборки «виден в поиске и подборках людей».
const SEARCHABLE = { 'privacy.searchable': { $ne: false } };

module.exports = { DEFAULTS, OPTIONS, of, isOfficial, decide, messageGate, maskPresence, presenceVisible, SEARCHABLE };
