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
const userView = require('../../utils/userView');
const callLog = require('../../utils/callLog');

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
    const displayName = userView.displayName(user);
    const avatarStyle = userView.avatarStyle(user, displayName);
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
        .select('login email avatar gallery streamKey isStreaming banned banReason adultConfirmedAt')
        .lean();
      if (!currentUser) throw new Error('Пользователь не найден');

      // Определение отображаемой информации для текущего пользователя
      const currentUserDisplayName = userView.displayName(currentUser);
      const currentUserAvatarStyle = userView.avatarStyle(currentUser, currentUserDisplayName);

      // Получение подписок текущего пользователя (ограничиваем 4) + непрочитанные уведомления (параллельно)
      const [userSubscriptions, unreadNotificationsCount, missedCalls] = await Promise.all([
        Subscription.find({ subscriberId: new mongoose.Types.ObjectId(currentUserId) })
          .select('subscribedToId')
          .limit(4)
          .lean(),
        Notification.countDocuments({ recipient: currentUserId, isRead: false }),
        callLog.missedCount(currentUserId)
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
          const displayName = userView.displayName(user);
          const avatarStyle = userView.avatarStyle(user, displayName);

          const status = user.isStreaming ? 'online' : 'offline';

          return {
              id: user._id,
              displayName,
              avatarStyle,
              status
          };
      });

      // Есть ли у человека эфир, каждой странице кабинета больше знать не
      // нужно: это решает студия (/studio), куда ведёт «Запустить эфир».
      // Раньше на каждый запрос кабинета уходил поиск эфира ради окна настроек.
      res.locals.currentUser = {
          _id: currentUser._id,
          displayName: currentUserDisplayName,
          email: currentUser.email || '',
          avatarStyle: currentUserAvatarStyle,
          gallery: Array.isArray(currentUser.gallery) ? currentUser.gallery : [],
          // Модерация: гейт 18+ и ограничение аккаунта
          adultConfirmedAt: currentUser.adultConfirmedAt || null,
          banned: !!currentUser.banned,
          banReason: currentUser.banReason || ''
      };

      res.locals.subscriptions = subscriptions;

      res.locals.notifications = { // НОВОЕ: Данные об уведомлениях
        unreadCount: unreadNotificationsCount,
        hasUnread: unreadNotificationsCount > 0,
      };

      // Левой панели: какая личная ссылка подсвечена и сколько пропущенных звонков.
      res.locals.path = req.path;
      res.locals.missedCalls = missedCalls;

      next(); // Передаем управление следующему middleware или маршруту
  } catch (error) {
      console.error('Ошибка в middleware получения общих данных:', error);
      next(error); // Передаем ошибку обработчику ошибок
  }
};

async function getActiveStreamsCount() {
  return await Stream.countDocuments({ isActive: true });
}

module.exports = { getStreamUsers, commonDataMiddleware, getActiveStreamsCount };
