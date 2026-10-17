// Своё имя для контакта (17.10, models/Contact.js, name): человек
// переименовал собеседника у себя, как в телефонной книжке. Видно только
// ему — в списке диалогов, шапке и панели диалога, контактах, журнале
// звонков, у входящего звонка и в пушах. Ник остаётся под именем
// в панели диалога, его никто не теряет.
//
// Одно место, через которое имя подставляется: выборки людей по всему
// проекту отдают ник (utils/userView.js), здесь он меняется на своё
// имя одним запросом по индексу owner+peer.

const Contact = require('../models/Contact');

const MAX = 64;

// Своё имя по id людей: Map id → имя, только у тех, кому оно задано.
async function namesFor(owner, ids) {
  const list = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!owner || !list.length) return new Map();
  const rows = await Contact.find({ owner, peer: { $in: list }, name: { $gt: '' } }).select('peer name').lean();
  return new Map(rows.map((c) => [String(c.peer), c.name]));
}

async function nameFor(owner, id) {
  return (await namesFor(owner, [id])).get(String(id)) || '';
}

// Карточка человека ({ id, displayName, avatarStyle, … }) под своим именем.
// Буква на аватаре без фото — тоже от него: «Мама» с буквой «I» читается
// как чужой человек.
function rename(person, name) {
  if (!person || !name) return person;
  const a = person.avatarStyle;
  return {
    ...person,
    displayName: name,
    ...(a && a.initial ? { avatarStyle: { ...a, initial: name.charAt(0).toUpperCase() } } : {}),
  };
}

// Список карточек: id берётся из id или _id.
async function applyAll(owner, people) {
  const names = await namesFor(owner, people.map((p) => p && (p.id || p._id)));
  if (!names.size) return people;
  return people.map((p) => (p ? rename(p, names.get(String(p.id || p._id))) : p));
}

module.exports = { MAX, namesFor, nameFor, rename, applyAll };
