// «Поделиться» (05.10.2026, решение Ивана): фото, видео, запись эфира или
// (с 09.10) пост
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
const Post = require('../models/Post');
const userView = require('./userView');
const restriction = require('./restrict');
const { VENUE_AUTHOR, venueAuthor } = require('./venueAuthor');

const KINDS = {
  photo: { Model: GalleryPhoto, fields: 'url caption userId', ready: () => true },
  video: { Model: GalleryVideo, fields: 'title thumb status userId venue', ready: (d) => d.status === 'ready' },
  recording: { Model: Recording, fields: 'title thumb status isAdult userId venue', ready: (d) => d.status === 'ready' },
  // Пост (09.10): картинка — первое его фото или обложка первого видео.
  post: { Model: Post, fields: 'text media status userId', ready: (d) => d.status === 'ready' },
};

// Картинка поста для карточки.
async function postImage(post) {
  const first = post.media[0];
  if (!first) return '';
  if (first.kind === 'photo') return ((await GalleryPhoto.findById(first.ref).select('url').lean()) || {}).url || '';
  const v = await GalleryVideo.findById(first.ref).select('thumb').lean();
  return (v && v.thumb && v.thumb.url) || '';
}

const TITLE_MAX = 140;

// null — нечем делиться: нет такого, не готово или закрыто от этого человека.
async function snapshot(kind, id, viewer) {
  const K = KINDS[kind];
  if (!K) return null;
  let q = K.Model.findById(id).select(K.fields).populate('userId', 'nickname login email banned');
  if (kind !== 'photo' && kind !== 'post') q = q.populate('venue', VENUE_AUTHOR);
  const doc = await q.lean();
  if (!doc || !doc.userId || doc.userId.banned || !K.ready(doc)) return null;
  if (await restriction.isRestricted(doc.userId._id, viewer)) return null;
  const venue = kind === 'photo' || kind === 'post' ? null : venueAuthor(doc.venue);
  const text = String((kind === 'photo' ? doc.caption : kind === 'post' ? doc.text : doc.title) || '').trim();
  return {
    kind,
    ref: doc._id,
    url: `/${kind}/${doc._id}`,
    // Пусто — карточка подпишет видом: «Фото», «Видео», «Запись эфира».
    title: text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1) + '…' : text,
    image: doc.isAdult ? '' : kind === 'photo' ? doc.url : kind === 'post' ? await postImage(doc) : (doc.thumb && doc.thumb.url) || '',
    author: venue ? venue.displayName : userView.displayName(doc.userId),
  };
}

module.exports = { snapshot, KINDS: Object.keys(KINDS) };
