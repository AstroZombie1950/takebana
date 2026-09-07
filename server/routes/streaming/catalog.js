// Витрина: список эфиров по категориям и страница пользователя.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const mongoose = require('mongoose');
const User = require('../../models/User');
const Stream = require('../../models/Stream');
const Subscription = require('../../models/Subscription');
const { commonDataMiddleware, getStreamUsers, getActiveStreamsCount, getRandomGradient } = require('./shared');

router.get('/streaming/:category?', commonDataMiddleware, async (req, res) => {
  const _t0 = Date.now();
  
  if (!req.session.userId) {
    return res.redirect('/');
  }

  const category = req.params.category || 'popular';
  console.log('📂 Using category:', category);
  
  // Конфигурация категорий
  const categoryConfig = {
    popular: {
      title: 'ПОПУЛЯРНОЕ',
      filter: {},
      cssClass: 'main__content',
      lng: '90'
    },
    business: {
      title: 'БИЗНЕС', 
      filter: { category: 'business' },
      cssClass: 'main__content-business',
      lng: '105'
    },
    entertainment: {
      title: 'РАЗВЛЕЧЕНИЯ',
      filter: { category: 'entertainment' },
      cssClass: 'main__content-entertainment', 
      lng: '104'
    }
  };

  // Проверяем валидность категории
  if (!categoryConfig[category]) {
    return res.redirect('/streaming');
  }

  try {
    const streamsQuery = (category === 'popular')
      ? Stream.find({ isActive: true })
      : Stream.find({ ...categoryConfig[category].filter, isActive: true });

    // Запросы параллельно (ускоряет F5)
    const [users, totalStreamsCount, streams] = await Promise.all([
      getStreamUsers(),
      getActiveStreamsCount(),
      streamsQuery
        .populate('userId', 'login email avatar')
        .select('title description category subcategory viewers thumbnail userId isActive')
        .limit(4)
        .lean()
    ]);

    const modifiedStreams = (streams || []).map(stream => {
      const user = stream.userId;
      const displayName = user.login || (user.email ? user.email.split('@')[0] : 'Неизвестный пользователь');
      const avatarStyle = user.avatar
        ? { url: user.avatar }
        : { gradient: getRandomGradient(), initial: displayName.charAt(0).toUpperCase() };

      return {
        streamId: stream._id,
        title: stream.title,
        description: stream.description,
        category: stream.category,
        subcategory: stream.subcategory,
        viewers: stream.viewers,
        thumbnail: stream.thumbnail || 'default-thumbnail.png',
        user: {
          displayName,
          avatarStyle
        }
      };
    });

    res.render('streamingMain', {
      title: `${categoryConfig[category].title} Стримы`,
      category: category,
      categoryConfig: categoryConfig[category],
      users: users,
      streams: modifiedStreams,
      totalStreamsCount
    });
    console.log(`[perf] GET /streaming/${category} render in ${Date.now() - _t0}ms`);
  } catch (error) {
    console.error(`Ошибка получения ${category} стримов или пользователей:`, error);
    res.status(500).send('Ошибка сервера');
  }
});


router.get('/userPage/:id', commonDataMiddleware, async (req, res) => {
  if (!req.session.userId) { // Проверка авторизации
    return res.redirect('/');
  }

  try {
    const userId = req.params.id; // ID пользователя, чей профиль просматривается
    const currentUserId = req.session.userId; // ID текущего пользователя из сессии

    // Получаем данные пользователя, чей профиль просматривается
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).send('Пользователь не найден');
    }

    const displayName = user.login || (user.email ? user.email.split('@')[0] : 'Неизвестный пользователь');
    const avatarStyle = user.avatar
      ? { url: user.avatar }
      : { gradient: getRandomGradient(), initial: displayName.charAt(0).toUpperCase() };

    // Получаем количество подписчиков и подписок для отображаемого пользователя
    const followersCount = await Subscription.countDocuments({ subscribedToId: userId });
    const followingCount = await Subscription.countDocuments({ subscriberId: userId });

    // Проверяем активный стрим пользователя
    const activeStream = await Stream.findOne({ userId: userId, isActive: true });

    // Проверяем, подписан ли текущий пользователь на просматриваемого
    let isSubscribed = false;
    if (currentUserId) {
      const existingSubscription = await Subscription.findOne({
        subscriberId: currentUserId,
        subscribedToId: userId
      });
      if (existingSubscription) {
        isSubscribed = true;
      }
    }

    // Передача данных в шаблон
    res.render('userPage', {
      title: `Профиль пользователя ${displayName}`,
      user: {
        displayName,
        avatarStyle,
        _id: user._id,
        followersCount,
        followingCount,
        isSubscribed, // Передаем статус подписки
        isStreaming: !!activeStream,
        activeStreamId: activeStream ? activeStream._id : null,
        gallery: Array.isArray(user.gallery) ? user.gallery : [],
        isOnline: !!user.isOnline,
        lastSeen: user.lastSeen || null
      }
    });
  } catch (error) {
    console.error('Ошибка получения данных пользователя:', error);
    res.status(500).send('Ошибка сервера');
  }
});
// Добавьте другие маршруты, связанные с функционалом стриминга


// Функция для преобразования времени в "назад"

module.exports = router;
