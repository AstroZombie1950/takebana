// Данные, которые нужны сразу нескольким страницам: текущий пользователь,
// его подписки, непрочитанные, список эфиров в шапке.
//
// commonDataMiddleware кладёт всё это в res.locals, поэтому обработчику страницы
// остаётся только отрисовать шаблон.

const mongoose = require('mongoose');
const User = require('../../models/User');
const Subscription = require('../../models/Subscription');
const Stream = require('../../models/Stream');
const Notification = require('../../models/Notification');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');

const getRandomGradient = () => {
  const gradients = [
    'linear-gradient(to right, #ff7e5f, #feb47b)',
    'linear-gradient(to right, #6a11cb, #2575fc)',
    'linear-gradient(to right, #ff9966, #ff5e62)',
    'linear-gradient(to right, #00c6ff, #0072ff)',
    'linear-gradient(to right, #f7971e, #ffd200)',
    'linear-gradient(to right, #7F00FF, #E100FF)',
    'linear-gradient(to right, #fc00ff, #00dbde)',
  ];
  return gradients[Math.floor(Math.random() * gradients.length)];
};
/**
 * Функция для получения и обработки случайных пользователей
 * @returns {Array} - Массив модифицированных пользователей с количеством подписчиков
 */
const getStreamUsers = async () => {
  // Получение 4 случайных пользователей
  const randomUsers = await User.aggregate([{ $sample: { size: 4 } }]);

  // Преобразуем список ID пользователей в ObjectId
  const userIds = randomUsers.map(user => new mongoose.Types.ObjectId(user._id.toString()));

  // Получение количества подписчиков для каждого пользователя
  const subscribersCount = await Subscription.aggregate([
    { $match: { subscribedToId: { $in: userIds } } },
    { $group: { _id: "$subscribedToId", count: { $sum: 1 } } }
  ]);

  // Преобразуем результат в удобный формат для быстрого поиска
  const subscribersMap = {};
  subscribersCount.forEach(sub => {
    subscribersMap[sub._id.toString()] = sub.count;
  });

  // Модификация данных пользователей для шаблона
  const modifiedUsers = randomUsers.map(user => {
    const displayName = user.login || (user.email ? user.email.split('@')[0] : 'Неизвестный пользователь');
    const avatarStyle = user.avatar
      ? { url: user.avatar }
      : { gradient: getRandomGradient(), initial: displayName.charAt(0).toUpperCase() };
    const followersCount = subscribersMap[user._id.toString()] || 0; // Количество подписчиков для каждого пользователя

    return { ...user, displayName, avatarStyle, followersCount };
  });

  return modifiedUsers;
};


const commonDataMiddleware = async (req, res, next) => {
  try {
      const currentUserId = req.session.userId; // Получаем текущий ID пользователя из сессии

      if (!currentUserId) {
          return next(); // Если пользователь не авторизован, пропускаем middleware
      }

      // Получение данных текущего пользователя
      // (lean/select) чтобы уменьшить нагрузку при каждом F5
      const currentUser = await User.findById(currentUserId)
        .select('login email avatar gallery streamKey isStreaming')
        .lean();
      if (!currentUser) throw new Error('Пользователь не найден');

      // Определение отображаемой информации для текущего пользователя
      const currentUserDisplayName = currentUser.login || (currentUser.email ? currentUser.email.split('@')[0] : 'Неизвестный пользователь');
      const currentUserAvatarStyle = currentUser.avatar
          ? { url: currentUser.avatar }
          : { gradient: getRandomGradient(), initial: currentUserDisplayName.charAt(0).toUpperCase() };

      // Получение подписок текущего пользователя (ограничиваем 4) + непрочитанные уведомления (параллельно)
      const [userSubscriptions, unreadNotificationsCount] = await Promise.all([
        Subscription.find({ subscriberId: new mongoose.Types.ObjectId(currentUserId) })
          .select('subscribedToId')
          .limit(4)
          .lean(),
        Notification.countDocuments({ recipient: currentUserId, isRead: false })
      ]);

      // Получение данных о подписанных пользователях
      const subscribedUserIds = (userSubscriptions || []).map(sub => sub.subscribedToId);
      const subscribedUsers = subscribedUserIds.length
        ? await User.find({ _id: { $in: subscribedUserIds } })
            .select('login email avatar isStreaming')
            .lean()
        : [];

      // Модификация данных о подписках для шаблона
      const subscriptions = subscribedUsers.map(user => {
          const displayName = user.login || (user.email ? user.email.split('@')[0] : 'Неизвестный пользователь');
          const avatarStyle = user.avatar
              ? { url: user.avatar }
              : { gradient: getRandomGradient(), initial: displayName.charAt(0).toUpperCase() };

          const status = user.isStreaming ? 'online' : 'offline';

          return {
              id: user._id,
              displayName,
              avatarStyle,
              status
          };
      });

      // Проверка наличия любого стрима (активного или на паузе).
      //
      // Условие `deleted: { $ne: true }` убрано: поля `deleted` нет в схеме Stream
      // и его никто нигде не выставляет. Отсутствующее поле не равно true, поэтому
      // условие проходило всегда — мягкого удаления в проекте не существует,
      // а строка создавала впечатление, что оно есть.
      const stream = await Stream.findOne({ userId: currentUserId })
        .select('_id isActive')
        .lean();

      if (stream) {
          res.locals.currentUser = {
              _id: currentUser._id,
              displayName: currentUserDisplayName,
              avatarStyle: currentUserAvatarStyle,
              hasActiveStream: true, // Есть стрим (активный или на паузе)
              isPaused: !stream.isActive, // true, если стрим на паузе
              activeStreamId: stream._id.toString(), // ID текущего стрима
              gallery: Array.isArray(currentUser.gallery) ? currentUser.gallery : []
          };
      } else {
          res.locals.currentUser = {
              _id: currentUser._id,
              displayName: currentUserDisplayName,
              avatarStyle: currentUserAvatarStyle,
              hasActiveStream: false, // Нет активного или паузного стрима
              isPaused: false,
              activeStreamId: null,
              gallery: Array.isArray(currentUser.gallery) ? currentUser.gallery : []
          };
      }

      res.locals.subscriptions = subscriptions;

      res.locals.notifications = { // НОВОЕ: Данные об уведомлениях
        unreadCount: unreadNotificationsCount,
        hasUnread: unreadNotificationsCount > 0,
      };

      console.log('currentUser.hasActiveStream:', res.locals.currentUser.hasActiveStream);
      console.log('currentUser.isPaused:', res.locals.currentUser.isPaused);
      console.log('currentUser.activeStreamId:', res.locals.currentUser.activeStreamId);

      next(); // Передаем управление следующему middleware или маршруту
  } catch (error) {
      console.error('Ошибка в middleware получения общих данных:', error);
      next(error); // Передаем ошибку обработчику ошибок
  }
};

async function getActiveStreamsCount() {
  return await Stream.countDocuments({ isActive: true });
}

module.exports = { getRandomGradient, getStreamUsers, commonDataMiddleware, getActiveStreamsCount };
