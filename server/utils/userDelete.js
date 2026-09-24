// Удаление аккаунта целиком и удаление заведения — со всем, что за ними
// тянется: файлами, комнатами Daily, идущим вещанием.
//
// Удалить только документ мало: эфир продолжил бы идти через медиасервер
// и Daily, фото остались бы на диске, записи — в Bunny, а в переписке
// и подписках висели бы ссылки на человека, которого нет.
//
// Журнал действий не трогаем: подписи в нём — снимок на момент действия
// (utils/audit.js), и след удаления должен пережить сам аккаунт.

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const User = require('../models/User');
const Stream = require('../models/Stream');
const StreamSession = require('../models/StreamSession');
const Recording = require('../models/Recording');
const GalleryVideo = require('../models/GalleryVideo');
const galleryVideo = require('./galleryVideo');
const galleryPhotos = require('./galleryPhotos');
const storage = require('./storage');
const attachments = require('./attachments');
const groups = require('./groups');
const Establishments = require('../models/Establishments');
const Rating = require('../models/Rating');
const Report = require('../models/Report');
const Subscription = require('../models/Subscription');
const Notification = require('../models/Notification');
const Conversation = require('../models/Conversation');
const ChatMessage = require('../models/ChatMessage');
const Call = require('../models/Call');

const daily = require('./daily');
const hls = require('./hls');
const webLive = require('./webLive');
const recording = require('./recording');
const engagement = require('./engagement');
const streamLog = require('./streamLog');
const errorLog = require('./errorLog');
const { forget } = require('./audit');
const { resolveWithin, isPlainFileName } = require('./safePath');
const { roomName: venueRoom } = require('../routes/venueLive');

const UPLOADS = path.join(__dirname, '..', 'public', 'uploads');

// Файл загрузки — только по имени и только внутри своей папки.
function unlinkFile(folder, name) {
  const file = isPlainFileName(name) && resolveWithin(path.join(UPLOADS, folder), name);
  if (file) fs.promises.unlink(file).catch(() => {}); // файла может уже не быть
}

// Адрес вида /uploads/<папка>/<имя>. Чужой не трогаем: у входа через Google
// в аватаре лежит внешний адрес.
function unlinkUpload(url, folder) {
  const prefix = `/uploads/${folder}/`;
  if (typeof url === 'string' && url.startsWith(prefix)) unlinkFile(folder, url.slice(prefix.length));
}

const dropRoom = (name, why) => name && daily.deleteRoom(name).catch((err) => errorLog.external(err, 'daily.deleteRoom', { roomName: name, by: why }));

// Заведение: камера, оценки, фотографии, сам документ.
async function removeVenue(venue) {
  if (venue.online) await dropRoom(venueRoom(venue._id), 'venue.delete');
  await Rating.deleteMany({ establishment: venue._id });
  for (const url of venue.photos || []) unlinkFile('establishments', path.basename(String(url)));
  await Establishments.deleteOne({ _id: venue._id });
}

// Аккаунт. Возвращает, сколько чего ушло, — это подробности записи в журнале.
async function removeUser(user, io) {
  const id = user._id;
  const idStr = String(id);

  // Сначала — всё, что идёт вживую: эфиры и камеры заведений.
  const streams = await Stream.find({ userId: id }).lean();
  for (const s of streams) {
    if (s.dailyRoomName) {
      webLive.stop(s).catch(() => {});
      await dropRoom(s.dailyRoomName, 'user.delete');
    }
    if (s.isActive) {
      require('../mediaServer').dropPublisher(s.streamKey, 'аккаунт удалён');
      hls.stop(s.streamKey);
      await hls.stopped(s.streamKey);
      await streamLog.close(s.streamKey, { endedBy: 'moderation', reason: 'аккаунт удалён', streamId: s._id });
      if (io) io.to(`stream:${s.streamKey}`).emit('stream:update', { streamKey: s.streamKey, isActive: false, ended: true });
    }
    await recording.discard(s.streamKey);
    unlinkUpload(s.thumbnail, 'thumbnails');
  }

  const venues = await Establishments.find({ owner: id });
  for (const v of venues) await removeVenue(v);

  // Записи лежат в хранилище: по одной, потому что у каждой свои файлы.
  const recordings = await Recording.find({ userId: id }).lean();
  for (const r of recordings) {
    await recording.remove(r).catch((err) => errorLog.external(err, 'recording.remove', { recording: String(r._id) }));
  }

  // Видео галереи — тоже в хранилище, по одному.
  const videos = await GalleryVideo.find({ userId: id }).lean();
  for (const v of videos) {
    await galleryVideo.remove(v).catch((err) => errorLog.external(err, 'gallery.video.remove', { video: String(v._id) }));
  }
  // Оценки и комментарии под чужими записями и видео — со счётчиками у них.
  await engagement.forgetUser(user._id);

  // Жалобы на сам аккаунт, на его эфиры и сообщения чата — у них больше
  // нет предмета.
  // Из групп — молча, владение переходит преемнику, опустевшая удаляется
  // (utils/groups.js). Его сообщения в группах уходят ниже, вместе с личными.
  await groups.forgetUser(id, attachments.deleteMessages);
  const chatIds = await ChatMessage.distinct('_id', { userId: id });
  const conversations = await Conversation.find({ $or: [{ userOne: id }, { userTwo: id }] }).select('_id').lean();

  const [reports, messages, chat, subs, calls] = await Promise.all([
    Report.deleteMany({ $or: [
      { reporter: id },
      { targetType: 'user', targetId: id },
      { targetType: 'stream', targetId: { $in: streams.map((s) => s._id) } },
      { targetType: 'message', targetId: { $in: chatIds } },
    ] }),
    // Вложения переписки уходят из хранилища вместе с сообщениями.
    attachments.deleteMessages({ $or: [{ sender: id }, { recipient: id }, { conversationId: { $in: conversations.map((c) => c._id) } }] }),
    ChatMessage.deleteMany({ userId: id }),
    Subscription.deleteMany({ $or: [{ subscriberId: id }, { subscribedToId: id }] }),
    Call.deleteMany({ $or: [{ caller: id }, { callee: id }] }),
    Conversation.deleteMany({ _id: { $in: conversations.map((c) => c._id) } }),
    Notification.deleteMany({ $or: [{ recipient: id }, { sender: id }] }),
    Rating.deleteMany({ user: id }),
    StreamSession.deleteMany({ user: id }),
    Stream.deleteMany({ userId: id }),
    mongoose.connection.collection('mySessions').deleteMany({ 'session.userId': idStr }),
  ]);

  unlinkUpload(user.avatar, 'avatars');
  if (user.ogCard && user.ogCard.key) await storage.remove(user.ogCard.key).catch(() => {});
  // Фото галереи — из Bunny и из папки на сервере (загруженные до переезда).
  await galleryPhotos.removeAll(idStr, user.gallery);

  await User.deleteOne({ _id: id });
  forget(idStr);

  // Открытые вкладки человека отключаются сразу, а не при следующем запросе.
  if (io) io.in(`user:${idStr}`).disconnectSockets(true);

  return {
    streams: streams.length,
    venues: venues.length,
    recordings: recordings.length,
    reports: reports.deletedCount,
    messages: messages.deletedCount + chat.deletedCount,
    subscriptions: subs.deletedCount,
    calls: calls.deletedCount,
  };
}

module.exports = { removeUser, removeVenue };
