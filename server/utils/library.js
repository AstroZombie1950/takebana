// Свои фото и видео — во вложения переписки без новой загрузки (09.10.2026,
// решение заказчика): скрепка → «Мои фото и видео» (public/chats.js).
//
// Вложение ссылается на тот же файл в хранилище, что и галерея, с пометкой
// lib: переписка такой файл не стирает (utils/attachments.js, release) —
// он принадлежит галерее. Удалили фото или видео из галереи, а в переписке
// оно есть — файл остаётся, и с этой минуты им владеет переписка: пометка
// снимается, последнее сообщение с ним уберёт и файл (handOver).
// Исчезающими такие сообщения не бывают: исчезая, сообщение стирает файлы.

const GalleryPhoto = require('../models/GalleryPhoto');
const GalleryVideo = require('../models/GalleryVideo');
const Message = require('../models/Message');

const PAGE = 30;
// Сколько из галереи за раз — как вложений с устройства в одной пачке.
const SEND_MAX = 10;

// Галерея человека, новые сверху: личное — без снятого от имени заведения,
// видео — только готовые. before — дата последнего показанного.
async function list(userId, before) {
  const at = before ? { createdAt: { $lt: before } } : {};
  const [photos, videos] = await Promise.all([
    GalleryPhoto.find({ userId, ...at }).sort({ createdAt: -1 }).limit(PAGE + 1).select('url createdAt').lean(),
    GalleryVideo.find({ userId, venue: null, status: 'ready', ...at }).sort({ createdAt: -1 }).limit(PAGE + 1).select('thumb duration createdAt').lean(),
  ]);
  const all = photos.map((p) => ({ kind: 'photo', id: String(p._id), thumb: p.url, at: p.createdAt }))
    .concat(videos.map((v) => ({ kind: 'video', id: String(v._id), thumb: (v.thumb && v.thumb.url) || '', duration: v.duration || 0, at: v.createdAt })))
    .sort((a, b) => b.at - a.at);
  const items = all.slice(0, PAGE);
  return { items, next: all.length > PAGE ? items[items.length - 1].at.toISOString() : null };
}

// Ключ файла в хранилище по адресу: gallery/<userId>/<имя>. У фото,
// загруженных до переезда в Bunny, адрес на нашем диске — ключом сам путь.
const keyOf = (url) => {
  const m = /\/(gallery\/[a-f\d]{24}\/[^/?#]+)$/.exec(url);
  return m ? m[1] : url;
};

// Вложение из своего фото или видео; null — нет такого у этого человека.
async function attachment(userId, { kind, id }) {
  if (kind === 'photo') {
    const p = await GalleryPhoto.findOne({ _id: id, userId }).select('url width height').lean();
    return p && { kind: 'image', key: keyOf(p.url), url: p.url, preview: p.url, width: p.width, height: p.height, mime: 'image/webp', lib: true };
  }
  if (kind === 'video') {
    const v = await GalleryVideo.findOne({ _id: id, userId, status: 'ready' }).select('video thumb duration size').lean();
    return v && { kind: 'video', key: v.video.key, url: v.video.url, preview: v.thumb && v.thumb.url, previewKey: v.thumb && v.thumb.key,
      duration: v.duration, size: v.size, mime: 'video/mp4', lib: true };
  }
  return null;
}

// Файл уходит из галереи. Есть в переписке — остаётся там: пометку lib
// снимаем, и файл живёт, пока на него ссылается хоть одно сообщение.
// → true — файл держит переписка, стирать его нельзя.
async function handOver(url) {
  if (!url || !(await Message.exists({ 'attachments.url': url }))) return false;
  await Message.updateMany({ 'attachments.url': url }, { $set: { 'attachments.$[a].lib': false } }, { arrayFilters: [{ 'a.url': url }] });
  return true;
}

module.exports = { PAGE, SEND_MAX, list, attachment, handOver };
