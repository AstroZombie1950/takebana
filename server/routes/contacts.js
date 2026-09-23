// Контакты: личная записная книжка (models/Contact.js). Вкладка на странице
// переписки, кнопки «в контакты» — в меню строки диалога, в журнале звонков
// и на странице пользователя.
//
// Список односторонний: добавили — записали себе, собеседник об этом не
// узнаёт. Уведомлений здесь нет намеренно (решение 23.09).

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router);
const { requireAuthApi, requireNotBanned } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const User = require('../models/User');
const userView = require('../utils/userView');
const restriction = require('../utils/restrict');
const { rankPeers } = require('../utils/recentPeers');

const FIELDS = 'nickname login email avatar isOnline lastSeen';

function person(user, extra) {
  const displayName = userView.displayName(user);
  return {
    id: String(user._id),
    displayName,
    avatarStyle: userView.avatarStyle(user, displayName),
    isOnline: !!user.isOnline,
    ...extra,
  };
}

// Избранные сверху, дальше по алфавиту на языке имени: так список читается
// одинаково и на десятке контактов, и на сотне.
function order(a, b) {
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
  return a.displayName.localeCompare(b.displayName, ['ru', 'en'], { sensitivity: 'base' });
}

// Список для вкладки. Пока никого не добавили — подсказываем, с кем человек
// общается чаще всего (utils/recentPeers.js): первый контакт заводится
// в один тап, но сам по себе в список никто не попадает.
//
// suggest=1 просит эти подсказки — их считают по всей переписке, поэтому
// страница переписки при открытии их не спрашивает: ей нужен только список,
// чтобы знать, кто уже записан (public/chats.js).
router.get('/api/contacts', requireAuthApi, async (req, res) => {
  const me = String(req.session.userId);
  const rows = await Contact.find({ owner: me }).populate('peer', FIELDS).lean();
  const contacts = rows
    .filter((c) => c.peer) // человек удалил аккаунт
    .map((c) => person(c.peer, { favorite: !!c.favorite, note: c.note || '', addedAt: c.addedAt }))
    .sort(order);

  if (contacts.length || req.query.suggest !== '1') return res.json({ contacts, suggest: [] });

  const conversations = await Conversation.find({ $or: [{ userOne: me }, { userTwo: me }], hiddenFor: { $ne: me } })
    .select('userOne userTwo')
    .lean();
  const ids = await rankPeers(me, conversations);
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select(FIELDS).lean() : [];
  const by = new Map(users.map((u) => [String(u._id), u]));
  res.json({ contacts, suggest: ids.map((id) => by.get(id)).filter(Boolean).map((u) => person(u)) });
});

// Добавить. Повторное добавление — не ошибка: кнопка могла нажаться дважды.
// Ограничение доступа закрывает и записную книжку: звонить и писать такому
// человеку всё равно нельзя (utils/restrict.js).
router.post('/api/contacts/add', requireAuthApi, requireNotBanned, validate({
  peerId: { type: 'objectId', required: true, label: 'Собеседник' },
  source: { type: 'string', values: ['profile', 'call', 'search', 'chat', 'recent'], default: 'profile', label: 'Откуда' },
}), async (req, res) => {
  const me = String(req.session.userId);
  const { peerId, source } = req.body;
  if (peerId === me) return res.status(400).json({ message: 'Себя в контакты добавить нельзя' });

  const barred = await restriction.between(me, peerId);
  if (barred) return res.status(403).json({ restricted: barred, message: restriction.BLOCKED[barred] });

  const peer = await User.findById(peerId).select(FIELDS).lean();
  if (!peer) return res.status(404).json({ message: 'Пользователь не найден' });

  await Contact.updateOne(
    { owner: me, peer: peerId },
    { $setOnInsert: { addedAt: new Date(), source } },
    { upsert: true }
  );
  res.json({ success: true, contact: person(peer, { favorite: false, note: '' }) });
});

router.post('/api/contacts/remove', requireAuthApi, validate({
  peerId: { type: 'objectId', required: true, label: 'Собеседник' },
}), async (req, res) => {
  const me = String(req.session.userId);
  const { deletedCount } = await Contact.deleteOne({ owner: me, peer: req.body.peerId });
  res.json({ success: true, removed: deletedCount });
});

router.post('/api/contacts/favorite', requireAuthApi, validate({
  peerId: { type: 'objectId', required: true, label: 'Собеседник' },
  on: { type: 'bool', required: true, label: 'Избранное' },
}), async (req, res) => {
  const me = String(req.session.userId);
  const { peerId, on } = req.body;
  const { matchedCount } = await Contact.updateOne({ owner: me, peer: peerId }, { $set: { favorite: on } });
  if (!matchedCount) return res.status(404).json({ message: 'Контакт не найден' });
  res.json({ success: true, favorite: on });
});

module.exports = router;
