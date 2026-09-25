// Данные, которые нужны сразу нескольким страницам: текущий пользователь,
// его подписки, непрочитанные.
//
// commonDataMiddleware кладёт всё это в res.locals, поэтому обработчику страницы
// остаётся только отрисовать шаблон.

const mongoose = require('mongoose');
const User = require('../../models/User');
const Subscription = require('../../models/Subscription');
const Stream = require('../../models/Stream');
const Notification = require('../../models/Notification');
const { unreadTotal } = require('../../utils/groups');
const userView = require('../../utils/userView');
const callLog = require('../../utils/callLog');
const errorLog = require('../../utils/errorLog');
const { langOf } = require('../../utils/i18n');

const commonDataMiddleware = async (req, res, next) => {
  try {
      const currentUserId = req.session.userId; // Получаем текущий ID пользователя из сессии

      // Гость: шапка и панель рисуются гостевыми по умолчаниям из app.js.
      if (!currentUserId) {
          return next();
      }

      // Всё — параллельно, одним заходом: страница вошедшего раньше ждала
      // базу пять раз подряд (пользователь, затем счётчики, затем подписки).
      // Подписки вместе с их эфирами — одним агрегатом. «В эфире» считаем
      // по идущим эфирам: поля isStreaming у User нет. Дальше статус ведёт
      // сокет: author:live (utils/liveSignal.js).
      const me = new mongoose.Types.ObjectId(String(currentUserId));
      const [currentUser, subscribedUsers, unreadNotificationsCount, missedCalls, unreadMessages] = await Promise.all([
        User.findById(currentUserId)
          .select('nickname login email avatar streamKey banned banReason adultConfirmedAt lang')
          .lean(),
        Subscription.aggregate([
          { $match: { subscriberId: me } },
          { $limit: 4 },
          { $lookup: { from: User.collection.name, localField: 'subscribedToId', foreignField: '_id', as: 'user',
              pipeline: [{ $project: { nickname: 1, login: 1, email: 1, avatar: 1 } }] } },
          { $unwind: '$user' },
          { $lookup: { from: Stream.collection.name, localField: 'subscribedToId', foreignField: 'userId', as: 'live',
              pipeline: [{ $match: { isActive: true } }, { $limit: 1 }, { $project: { _id: 1 } }] } },
          { $replaceWith: { $mergeObjects: ['$user', { live: { $gt: [{ $size: '$live' }, 0] } }] } },
        ]),
        // Сообщения в колокольчик не пишутся — их счётчик у иконки переписки.
        // Старые уведомления о сообщениях (до 18.09.2026) не считаем.
        Notification.countDocuments({ recipient: currentUserId, isRead: false, type: { $ne: 'message' } }),
        callLog.missedCount(currentUserId),
        unreadTotal(currentUserId), // личные и в группах (utils/groups.js)
      ]);
      // Пользователя уже нет: он удалил себя сам или его удалил администратор,
      // а вкладка осталась открытой. Это не ошибка сервера — гасим сеанс
      // и показываем страницу гостю, вместо 500 на каждой странице кабинета.
      if (!currentUser) {
        return req.session.destroy(() => {
          res.clearCookie('connect.sid');
          next();
        });
      }

      // Язык, которым человек пользуется, — в аккаунт: рассылкам поддержки
      // (utils/support.js) его не у кого спросить. Пишется только при смене.
      const lang = langOf(req);
      if (currentUser.lang !== lang) {
        User.updateOne({ _id: currentUser._id }, { $set: { lang } }).catch((e) => errorLog.server(e, 'user.lang'));
      }

      // Определение отображаемой информации для текущего пользователя
      const currentUserDisplayName = userView.displayName(currentUser);
      const currentUserAvatarStyle = userView.avatarStyle(currentUser, currentUserDisplayName);

      // Подписки для левой панели
      const subscriptions = subscribedUsers.map(user => {
          const displayName = userView.displayName(user);
          return {
              id: user._id,
              displayName,
              avatarStyle: userView.avatarStyle(user, displayName),
              status: user.live ? 'online' : 'offline'
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

      // Левой панели: сколько пропущенных звонков.
      res.locals.missedCalls = missedCalls;
      res.locals.unreadMessages = unreadMessages;

      next(); // Передаем управление следующему middleware или маршруту
  } catch (error) {
      errorLog.server(error, 'commonData', { path: req.path });
      next(error); // Передаем ошибку обработчику ошибок
  }
};

async function getActiveStreamsCount() {
  return await Stream.countDocuments({ isActive: true });
}

module.exports = { commonDataMiddleware, getActiveStreamsCount };
