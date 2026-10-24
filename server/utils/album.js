// Альбом переписки (23.10): фото и видео одной пачкой. Каждый файл — своё
// сообщение (загрузка, пережатие и «Повторить» у каждого свои), а общая
// метка album собирает их в ленте в мозаику (public/chats.js). Так же
// устроены альбомы в Telegram.
//
// Метку ставит браузер — при загрузке с устройства файлы уходят по одному,
// и сервер не знает, что они из одной пачки. Из галереи и при пересылке
// метку ставит сервер сам.

const crypto = require('crypto');
const Message = require('../models/Message');

// Больше в альбоме не бывает: лишнее браузер кладёт в следующий.
const MAX = 10;
const KINDS = new Set(['image', 'video']);
const ID = /^[\w-]{8,32}$/;

// Метка из запроса: чужая форма — без альбома, а не отказ.
const parse = (raw) => (typeof raw === 'string' && ID.test(raw) ? raw : undefined);

const fresh = () => crypto.randomBytes(9).toString('base64url');

// Будить ли телефон: пуш — у первого сообщения альбома, остальные идут
// молча (их ведёт тот же tag msg-<отправитель>, но пять звонков подряд
// на одну пачку незачем). Спрашивать до создания сообщения.
async function opens(conversationId, album) {
  if (!album) return true;
  return !(await Message.exists({ conversationId, album }));
}

// Пересылка: у пересланного альбома своя метка — иначе он склеился бы
// с исходным, если его пересылают в тот же диалог.
function remap() {
  const ids = new Map();
  return (m) => {
    if (!m.album) return undefined;
    if (!ids.has(m.album)) ids.set(m.album, fresh());
    return ids.get(m.album);
  };
}

module.exports = { MAX, KINDS, parse, fresh, opens, remap };
