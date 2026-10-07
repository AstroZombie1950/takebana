// Приватность: кто может писать, звонить, добавлять в группы, видеть
// «в сети» и время последнего визита, комментировать; виден ли человек
// в поиске (решение 24.09.2026; время визита — 06.10).
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

const DEFAULTS = { messages: 'all', calls: 'all', groups: 'all', presence: 'all', lastSeen: 'all', comments: 'all', searchable: true };
const OPTIONS = {
  // requests — пишут все, но незнакомые попадают в «Заявки»
  messages: ['all', 'requests', 'contacts', 'nobody'],
  calls: ['all', 'contacts', 'nobody'],
  groups: ['all', 'contacts', 'nobody'],
  presence: ['all', 'contacts', 'nobody'],
  lastSeen: ['all', 'contacts', 'nobody'],
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

// Время последнего визита ступенькой под «в сети» (решение Ивана 06.10):
// оно не бывает видно шире, чем само «в сети», — иначе время входа
// выдавало бы невидимку. «В сети» видят контакты — время визита видят
// контакты или никто; никто — никто. Хранится выбор человека как есть,
// действует более строгое из двух.
const RANK = { all: 0, contacts: 1, nobody: 2 };
function lastSeenRule(p) {
  return RANK[p.lastSeen] > RANK[p.presence] ? p.lastSeen : p.presence;
}

// Отказ — русский текст для ответа (перевод — utils/i18n.js).
const REFUSED = {
  messages: { contacts: 'Пользователь принимает сообщения только от своих контактов', nobody: 'Пользователь не принимает новые сообщения' },
  calls: { contacts: 'Пользователь принимает звонки только от своих контактов', nobody: 'Пользователь не принимает звонки' },
  groups: { contacts: 'Добавить в группу этого пользователя могут только его контакты', nobody: 'Этот пользователь не разрешает добавлять себя в группы' },
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

// Кого из людей viewer видит «в сети» и чьё время визита. Остальным
// isOnline и lastSeen стираются прямо в переданных документах — дальше их
// рисует кто угодно: скрытое «в сети» — presenceHidden, скрытое только
// время — lastSeenHidden. Гость (viewer пуст) — не контакт никому.
async function maskPresence(viewer, users) {
  const list = (users || []).filter(Boolean);
  if (!list.length) return users;
  const ids = list.map((u) => u._id).filter((id) => !viewer || !same(id, viewer));
  if (!ids.length) return users;
  const closed = await User.find({
    _id: { $in: ids },
    $or: [{ 'privacy.presence': { $in: ['contacts', 'nobody'] } }, { 'privacy.lastSeen': { $in: ['contacts', 'nobody'] } }],
  }).select('privacy.presence privacy.lastSeen').lean();
  if (!closed.length) return users;
  const rules = closed.map((u) => { const p = of(u); return { id: String(u._id), presence: p.presence, last: lastSeenRule(p) }; });
  const byContacts = rules.filter((r) => r.presence === 'contacts' || r.last === 'contacts').map((r) => r.id);
  const known = new Set(viewer && byContacts.length
    ? (await Contact.find({ owner: { $in: byContacts }, peer: viewer }).select('owner').lean()).map((c) => String(c.owner))
    : []);
  const sees = (rule, id) => rule === 'all' || (rule === 'contacts' && known.has(id));
  const hidden = new Set(), noTime = new Set();
  for (const r of rules) {
    if (!sees(r.presence, r.id)) hidden.add(r.id);
    else if (!sees(r.last, r.id)) noTime.add(r.id);
  }
  for (const u of list) {
    const id = String(u._id);
    if (hidden.has(id)) {
      u.isOnline = false;
      u.lastSeen = null;
      u.presenceHidden = true;
    } else if (noTime.has(id)) {
      u.lastSeen = null;
      u.lastSeenHidden = true;
    }
  }
  return users;
}

// Что из присутствия людей ids viewer видит — для подписки сокета:
// [{ id, time }] — «в сети» виден, time — видно ли и время визита.
async function presenceVisible(viewer, ids) {
  const docs = ids.map((id) => ({ _id: id }));
  await maskPresence(viewer, docs);
  return docs.filter((d) => !d.presenceHidden).map((d) => ({ id: String(d._id), time: !d.lastSeenHidden }));
}

// Правило «в сети» или времени визита сменилось, человек убран из
// контактов: подписка сокета проверялась только при входе в комнату
// (sockets/index.js, presence:subscribe), и уже открытые страницы
// продолжали получать presence:update — скрытое утекало до их перезагрузки.
// Здесь комнату presence:<owner> пересматриваем: кому теперь «в сети»
// нельзя — гасим точку и выводим из комнаты; кому нельзя только время —
// кладём в комнату nolast:<owner>, туда событие уходит без времени
// (sockets/index.js, syncPresence). Открыл обратно — новые подписчики
// войдут сами, прежние — при следующем подключении сокета.
async function recheckPresence(io, ownerId) {
  if (!io || !ownerId) return;
  const room = 'presence:' + ownerId;
  const quiet = 'nolast:' + ownerId;
  const sockets = await io.in(room).fetchSockets();
  if (!sockets.length) return;
  const p = of(await User.findById(ownerId).select('privacy').lean());
  const rule = { presence: p.presence, last: lastSeenRule(p) };
  const viewers = [...new Set(sockets.map((s) => s.data.userId).filter(Boolean).map(String))];
  const known = new Set(viewers.length && (rule.presence === 'contacts' || rule.last === 'contacts')
    ? (await Contact.find({ owner: ownerId, peer: { $in: viewers } }).select('peer').lean()).map((c) => String(c.peer))
    : []);
  const sees = (r, v) => r === 'all' || (r === 'contacts' && known.has(v));
  for (const s of sockets) {
    const v = s.data.userId ? String(s.data.userId) : '';
    if (v === String(ownerId)) continue;
    if (!sees(rule.presence, v)) {
      s.emit('presence:update', { userId: String(ownerId), isOnline: false, lastSeen: null });
      s.leave(room);
      s.leave(quiet);
    } else if (sees(rule.last, v)) s.leave(quiet);
    else s.join(quiet);
  }
}

// Условие выборки «виден в поиске и подборках людей».
const SEARCHABLE = { 'privacy.searchable': { $ne: false } };

module.exports = { DEFAULTS, OPTIONS, of, lastSeenRule, isOfficial, decide, messageGate, maskPresence, presenceVisible, recheckPresence, SEARCHABLE };
