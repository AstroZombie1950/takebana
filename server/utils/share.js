// «Поделиться» (05.10.2026, решение Ивана): фото, видео или запись эфира
// уходят сообщением в переписку — карточкой с картинкой, как пересылка поста
// в мессенджере, — а не ссылкой в буфер: человек остаётся на сайте.
// Маршрут — routes/streaming/messages.js (/api/share), окно — public/tk-share.js,
// карточка в ленте переписки — public/chats.js (shareHtml).
//
// Здесь — снимок публикации для Message.share: что показать в карточке.
// Делиться можно тем, что этот человек сам вправе смотреть: готовым, не от
// автора, закрывшего от него канал. У записи 18+ картинки в снимке нет —
// получатель мог не подтверждать возраст, гейт ждёт его на самой странице.

const Recording = require('../models/Recording');
const GalleryVideo = require('../models/GalleryVideo');
const GalleryPhoto = require('../models/GalleryPhoto');
const userView = require('./userView');
const restriction = require('./restrict');
const { VENUE_AUTHOR, venueAuthor } = require('./venueAuthor');

const KINDS = {
  photo: { Model: GalleryPhoto, fields: 'url caption userId', ready: () => true },
  video: { Model: GalleryVideo, fields: 'title thumb status userId venue', ready: (d) => d.status === 'ready' },
  recording: { Model: Recording, fields: 'title thumb status isAdult userId venue', ready: (d) => d.status === 'ready' },
};

const TITLE_MAX = 140;

// null — нечем делиться: нет такого, не готово или закрыто от этого человека.
async function snapshot(kind, id, viewer) {
  const K = KINDS[kind];
  if (!K) return null;
  let q = K.Model.findById(id).select(K.fields).populate('userId', 'nickname login email banned');
  if (kind !== 'photo') q = q.populate('venue', VENUE_AUTHOR);
  const doc = await q.lean();
  if (!doc || !doc.userId || doc.userId.banned || !K.ready(doc)) return null;
  if (await restriction.isRestricted(doc.userId._id, viewer)) return null;
  const venue = kind === 'photo' ? null : venueAuthor(doc.venue);
  const text = String((kind === 'photo' ? doc.caption : doc.title) || '').trim();
  return {
    kind,
    ref: doc._id,
    url: `/${kind}/${doc._id}`,
    // Пусто — карточка подпишет видом: «Фото», «Видео», «Запись эфира».
    title: text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1) + '…' : text,
    image: doc.isAdult ? '' : kind === 'photo' ? doc.url : (doc.thumb && doc.thumb.url) || '',
    author: venue ? venue.displayName : userView.displayName(doc.userId),
  };
}

module.exports = { snapshot, KINDS: Object.keys(KINDS) };
