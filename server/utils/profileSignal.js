// Живые изменения профиля: числа подписчиков и ограничение доступа.
//
// До 21.09.2026 и то и другое менялось только перезагрузкой. Заказчик убирал
// подписчика с телефона, а на компьютере его профиль так и показывал старое
// число; ограничивал доступ — а ограниченный продолжал смотреть эфир
// и записи, пока сам не обновит страницу.
//
//   profile:counts  — в комнату `presence:<id>`: на неё уже подписана каждая
//                     страница, где этот человек на экране (public/tk-app.js
//                     собирает id из [data-presence-user] и счётчиков
//                     [data-count-followers]). Новой машинерии подписок нет.
//
//   follow:changed  — вкладкам подписчика: подписка появилась или пропала.
//
//   access:changed  — обеим сторонам ограничения, в `user:<id>`. Страница
//                     чужого канала, чьё состояние доступа устарело,
//                     перезагружается (сервер уже отдаёт её с отказом или
//                     без); переписка закрывает или открывает поле ввода.

const Subscription = require('../models/Subscription');
const errorLog = require('./errorLog');
const io = require('./io');

async function counts(userIds) {
  const server = io.get();
  if (!server) return;
  try {
    await Promise.all([...new Set(userIds.map(String))].map(async (id) => {
      const [followers, following] = await Promise.all([
        Subscription.countDocuments({ subscribedToId: id }),
        Subscription.countDocuments({ subscriberId: id }),
      ]);
      server.to(`presence:${id}`).emit('profile:counts', { userId: id, followers, following });
    }));
  } catch (e) {
    errorLog.server(e, 'profileSignal.counts');
  }
}

// ownerId ограничил userId (restricted) или вернул доступ.
function access(ownerId, userId, restricted) {
  const server = io.get();
  if (!server) return;
  server.to(`user:${userId}`).emit('access:changed', { peerId: String(ownerId), by: 'them', restricted: !!restricted });
  server.to(`user:${ownerId}`).emit('access:changed', { peerId: String(userId), by: 'me', restricted: !!restricted });
}

// Подписка subscriberId на targetId появилась или пропала — вкладкам
// подписчика: кнопка «Подписаться» и левая панель. Главный случай — автор
// убрал его из подписчиков, а у него всё ещё «Отписаться».
function follow(subscriberId, targetId, subscribed) {
  const server = io.get();
  if (server) server.to(`user:${subscriberId}`).emit('follow:changed', { peerId: String(targetId), subscribed: !!subscribed });
}

module.exports = { counts, access, follow };
