const express = require('express');
const User = require('../models/User');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const path = require('path'); // Добавьте эту строку
const multer = require('multer');
const fs = require('fs');
const Subscription = require('../models/Subscription');
const Conversation = require('../models/Conversation'); // Импортируем модель Conversation
const Stream = require('../models/Stream');
const Notification = require('../models/Notification');
const ChatMessage = require('../models/ChatMessage');
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });
const Message = require('../models/Message');
const { stopPlaylistUpdates } = require('../utils/playlistUtils'); // Импортируем функцию остановки плейлиста
const router = express.Router();


// Настройка хранилища для Multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/uploads/thumbnails'); // Папка для хранения заглавных картинок
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname)); // Уникальное имя файла
  }
});


// Фильтр для проверки типа файла
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);
  
  if (mimetype && extname) {
    return cb(null, true);
  } else {
    cb(new Error('Только изображения форматов JPEG, JPG, PNG разрешены.'));
  }
};

// Инициализация Multer
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // Ограничение размера файла: 5MB
  fileFilter: fileFilter
});

// Хранилище для аватаров пользователей
const avatarStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    try {
      const dest = path.join('public', 'uploads', 'avatars');
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }
      cb(null, dest);
    } catch (e) {
      cb(e);
    }
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileFilter
});

// Хранилище для галереи пользователей
const galleryStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    try {
      if (!req.session || !req.session.userId) return cb(new Error('Необходима авторизация'));
      const dest = path.join('public', 'uploads', 'gallery', String(req.session.userId));
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    } catch (e) { cb(e); }
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const uploadGallery = multer({
  storage: galleryStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB на фото
  fileFilter: fileFilter
});

// Загрузка аватарки профиля
router.post('/profile/avatar', uploadAvatar.single('avatar'), async (req, res) => {
  try {
    console.log('Запрос на загрузку аватара:', {
      hasSession: !!req.session,
      userId: req.session?.userId,
      hasFile: !!req.file,
      fileInfo: req.file ? {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        filename: req.file.filename
      } : null
    });

    if (!req.session || !req.session.userId) {
      console.error('Ошибка: нет сессии или userId');
      return res.status(401).json({ success: false, message: 'Необходима авторизация' });
    }
    if (!req.file) {
      console.error('Ошибка: файл не передан');
      return res.status(400).json({ success: false, message: 'Файл не передан' });
    }

    const user = await User.findById(req.session.userId);
    if (!user) {
      console.error('Ошибка: пользователь не найден, userId:', req.session.userId);
      return res.status(404).json({ success: false, message: 'Пользователь не найден' });
    }

    const publicUrl = `/uploads/avatars/${req.file.filename}`;
    const oldAvatar = user.avatar;
    user.avatar = publicUrl;
    await user.save();

    console.log('Аватар успешно загружен и сохранен:', {
      filename: req.file.filename,
      path: req.file.path,
      url: publicUrl,
      userId: req.session.userId,
      oldAvatar: oldAvatar,
      newAvatar: user.avatar
    });

    // Проверяем, что файл действительно существует
    const filePath = path.join(__dirname, '..', 'public', 'uploads', 'avatars', req.file.filename);
    const fileExists = fs.existsSync(filePath);
    console.log('Файл существует на диске:', fileExists, 'по пути:', filePath);

    return res.json({ success: true, url: publicUrl });
  } catch (err) {
    console.error('Ошибка загрузки аватара:', err);
    return res.status(500).json({ success: false, message: err.message || 'Ошибка сервера' });
  }
});

// Загрузка фотографий в галерею (до 100 суммарно)
router.post('/profile/gallery', uploadGallery.array('photos', 100), async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ success: false, message: 'Необходима авторизация' });
    }
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });

    const existing = Array.isArray(user.gallery) ? user.gallery.length : 0;
    const incoming = (req.files || []).length;
    if (existing >= 100) return res.status(400).json({ success: false, message: 'Лимит 100 фото уже достигнут' });
    if (existing + incoming > 100) {
      // Обрезаем до допустимого
      req.files = req.files.slice(0, 100 - existing);
    }

    const basePath = `/uploads/gallery/${req.session.userId}/`;
    const urls = (req.files || []).map(f => basePath + f.filename);
    user.gallery = [...(user.gallery || []), ...urls];
    await user.save();

    return res.json({ success: true, urls: urls, total: user.gallery.length });
  } catch (err) {
    console.error('Ошибка загрузки галереи:', err);
    return res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// Удаление фото из галереи
router.delete('/profile/gallery/:name', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ success: false, message: 'Необходима авторизация' });
    }
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });

    const fileName = req.params.name; // только имя файла
    const urlPrefix = `/uploads/gallery/${req.session.userId}/`;
    const fullUrl = urlPrefix + fileName;

    // Удаляем из массива
    user.gallery = (user.gallery || []).filter(u => u !== fullUrl);
    await user.save();

    // Удаляем из файловой системы
    const filePath = path.join('public', 'uploads', 'gallery', String(req.session.userId), fileName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Ошибка удаления фото из галереи:', err);
    return res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// Маршрут для установки значения в сессии и перенаправления
router.get('/set-next', (req, res) => {
  const next = req.query.next || 'default'; // Получаем желаемый маршрут из параметров запроса
  req.session.next = next; // Сохраняем его в сессии
  console.log('req.session.next')
  console.log(req.session)

  // Перенаправляем на страницу входа или регистрации
  res.redirect('/login'); // Или '/register' в зависимости от вашей логики
});






// Функция для генерации случайного градиента из массива градиентов
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

      // Проверка наличия любого стрима (активного или на паузе)
      const stream = await Stream.findOne({ userId: currentUserId, deleted: { $ne: true } })
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

router.get('/video', (req, res) => {
  res.render('video');
})

router.get('/api/notifications', async (req, res) => {
  const userId = req.session.userId;

  if (!userId) {
    return res.status(401).json({ message: 'Необходима авторизация' });
  }

  try {
    // Получаем последние 5 непрочитанных уведомлений, сортируем от новых к старым
    const notifications = await Notification.find({ recipient: userId })
      .sort({ createdAt: -1 }) // Сортировка по времени создания
      .limit(5) // Ограничиваем до 5 уведомлений
      .populate('sender', 'login email'); // Подгружаем имя отправителя

    res.json(notifications);
  } catch (error) {
    console.error('Ошибка при получении уведомлений:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});





router.put('/api/notifications/markAsRead', async (req, res) => {
  const { senderId } = req.body; // ID отправителя, с которым открыт диалог
  const userId = req.session.userId; // ID текущего пользователя

  if (!senderId || !userId) {
    return res.status(400).json({ message: 'Недостаточно данных' });
  }

  try {
    // Помечаем все уведомления от этого отправителя как прочитанные
    await Notification.updateMany(
      { recipient: userId, sender: senderId, isRead: false },
      { isRead: true }
    );
    res.json({ message: 'Уведомления помечены как прочитанные' });
  } catch (error) {
    console.error('Ошибка при обновлении уведомлений:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Удаление уведомлений о чате при входе в диалог
router.post('/removeChatNotifications', async (req, res) => {
  const { recipientId } = req.body; // ID собеседника
  const userId = req.session.userId; // ID текущего пользователя

  if (!recipientId || !userId) {
    return res.status(400).json({ message: 'Недостаточно данных' });
  }

  try {
    // Удаляем все уведомления от этого пользователя
    await Notification.deleteMany({
      recipient: userId,
      sender: recipientId,
      type: 'message'
    });
    
    res.json({ message: 'Уведомления о чате удалены' });
  } catch (error) {
    console.error('Ошибка при удалении уведомлений о чате:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});








// Оптимизированный единый роут для всех категорий стриминга
router.get('/streaming/:category?', commonDataMiddleware, async (req, res) => {
  const _t0 = Date.now();
  console.log('🚀 NEW STREAMING ROUTE HIT! Category:', req.params.category);
  
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















router.post('/streaming/update-profile', async (req, res) => {
  const userId = req.session.userId;

  if (!userId) {
    return res.status(400).json({ message: 'User ID is required' });
  }

  try {
    const user = await User.findById(userId);

    if (!user) {
      return res.status(400).json({ message: 'User not found' });
    }

    const { action } = req.body;

    if (action === 'updatePassword') {
      const { oldPassword, newPassword } = req.body;

      if (!oldPassword || !newPassword) {
        return res.status(400).json({ message: 'Старый и новый пароль обязательны.' });
      }

      // Проверяем старый пароль
      const match = await bcrypt.compare(oldPassword, user.password);
      if (!match) {
        return res.status(400).json({ message: 'Неверный старый пароль.' });
      }

      // Дополнительная валидация нового пароля
      if (newPassword.length < 6) {
        return res.status(400).json({ message: 'Новый пароль должен быть не менее 6 символов.' });
      }

      // Обновляем пароль
      user.password = await bcrypt.hash(newPassword, 10);
      await user.save();

      res.status(200).json({ message: 'Пароль успешно обновлен.' });
    } else if (action === 'updateProfile') {
      const { login } = req.body;

      if (!login) {
        return res.status(400).json({ message: 'Имя пользователя обязательно.' });
      }

      // Обновляем логин
      user.login = login;
      await user.save();

      res.status(200).json({ message: 'Профиль успешно обновлен.' });
    } else {
      res.status(400).json({ message: 'Некорректное действие.' });
    }
  } catch (error) {
    console.error('Ошибка при обновлении профиля:', error);
    res.status(500).json({ message: 'Ошибка сервера.' });
  }
});




// Маршрут для подписки на пользователя
router.post('/subscribe', async (req, res) => {
  const { userId } = req.body; // Получаем ID пользователя для подписки
  const subscriberId = req.session.userId; // Предполагаем, что ID текущего пользователя хранится в сессии

  if (!subscriberId) {
    return res.status(401).json({ message: 'Необходимо войти в систему для подписки' });
  }

  try {
    // Проверка, существует ли уже такая подписка
    const existingSubscription = await Subscription.findOne({ subscriberId, subscribedToId: userId });

    if (existingSubscription) {
      return res.status(400).json({ message: 'Вы уже подписаны на этого пользователя' });
    }

    // Создание новой подписки
    const subscription = new Subscription({ subscriberId, subscribedToId: userId });
    await subscription.save();

    res.status(200).json({ message: 'Подписка успешно оформлена' });
  } catch (error) {
    console.error('Ошибка при подписке:', error);
    res.status(500).json({ message: 'Ошибка сервера при попытке подписаться' });
  }
});




// Маршрут для отписки от пользователя
router.delete('/unsubscribe', async (req, res) => {
  const { userId } = req.body; // ID стримера, от которого отписываемся
  const subscriberId = req.session.userId; // ID текущего пользователя из сессии

  if (!subscriberId) {
    return res.status(401).json({ message: 'Необходимо войти в систему для отписки' });
  }

  try {
    // Поиск и удаление подписки
    const subscription = await Subscription.findOneAndDelete({ subscriberId, subscribedToId: userId });

    if (!subscription) {
      return res.status(400).json({ message: 'Вы не подписаны на этого пользователя' });
    }

    res.status(200).json({ message: 'Отписка успешно выполнена' });
  } catch (error) {
    console.error('Ошибка при отписке:', error);
    res.status(500).json({ message: 'Ошибка сервера при попытке отписаться' });
  }
});



// Маршрут для страницы профиля пользователя /userPage/:id
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
function timeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  let interval = seconds / 31536000;

  if (interval > 1) {
    return Math.floor(interval) + ' years ago';
  }
  interval = seconds / 2592000;
  if (interval > 1) {
    return Math.floor(interval) + ' months ago';
  }
  interval = seconds / 86400;
  if (interval > 1) {
    return Math.floor(interval) + ' days ago';
  }
  interval = seconds / 3600;
  if (interval > 1) {
    return Math.floor(interval) + ' hours ago';
  }
  interval = seconds / 60;
  if (interval > 1) {
    return Math.floor(interval) + ' minutes ago';
  }
  return Math.floor(seconds) + ' seconds ago';
}

router.get('/video', (req, res) => {
  res.render('video'); // ejs будет искать stream.ejs в папке views
});

router.get('/chatsPage', commonDataMiddleware, async (req, res) => {
  if (!req.session.userId) { // Проверка авторизации
    return res.redirect('/');
  }

  try {
    // Проверяем, авторизован ли пользователь
    const currentUserId = res.locals.currentUser ? res.locals.currentUser._id : null;

    if (!currentUserId) {
      return res.status(401).send('Необходима авторизация');
    }

    // Получение всех диалогов текущего пользователя
    const conversations = await Conversation.find({
      $or: [{ userOne: currentUserId }, { userTwo: currentUserId }]
    })
      .populate('userOne userTwo lastMessage') // Подгружаем участников и последнее сообщение
      .lean(); // Используем lean() для облегчения работы с объектами

    // Получаем все непрочитанные уведомления для текущего пользователя
    const unreadNotifications = await Notification.find({
      recipient: currentUserId, // Уведомления для текущего пользователя
      isRead: false, // Только непрочитанные
      type: 'message' // Только уведомления о сообщениях
    }).lean();

    // Добавляем свойство `hasUnreadMessages` в диалоги на основе уведомлений
    conversations.forEach(conversation => {
      const interlocutor = conversation.userOne._id.toString() === currentUserId.toString() 
        ? conversation.userTwo 
        : conversation.userOne;

      const displayName = interlocutor.login || 
        (interlocutor.email ? interlocutor.email.split('@')[0] : 'Неизвестный пользователь');
      const avatarStyle = interlocutor.avatar
        ? { url: interlocutor.avatar }
        : { gradient: getRandomGradient(), initial: displayName.charAt(0).toUpperCase() };

      // Добавляем интерлокутора и последнюю активность
      conversation.interlocutor = {
        _id: interlocutor._id,
        displayName,
        avatarStyle,
        isOnline: !!interlocutor.isOnline,
        lastSeen: interlocutor.lastSeen || null
      };

      // Проверяем, есть ли непрочитанные уведомления от собеседника
      conversation.hasUnreadMessages = unreadNotifications.some(
        (notification) => notification.sender.toString() === interlocutor._id.toString()
      );

      // Определяем последнюю активность для сортировки
      conversation.lastActivity = conversation.lastMessage 
        ? new Date(conversation.lastMessage.sentAt) 
        : new Date(conversation.createdAt);
    });

    // Сортируем диалоги по времени последней активности (от свежих к старым)
    conversations.sort((a, b) => b.lastActivity - a.lastActivity);

    // Передача данных в шаблон
    res.render('chatsPage', {
      title: 'Личные сообщения',
      conversations, // Передаём отсортированный список диалогов
      timeAgo // Передаем функцию в шаблон
    });
  } catch (error) {
    console.error('Ошибка получения данных для страницы чатов:', error);
    res.status(500).send('Ошибка сервера');
  }
});






router.post('/start-conversation', async (req, res) => {
  const currentUserId = req.session.userId; // Получаем ID текущего пользователя из сессии
  const { recipientId } = req.body; // ID получателя передается в теле запроса

  if (!currentUserId) {
    return res.status(401).json({ success: false, message: 'Пользователь не аутентифицирован' });
  }

  try {
    // Проверка существования конверсации
    let conversation = await Conversation.findOne({
      $or: [
        { userOne: currentUserId, userTwo: recipientId },
        { userOne: recipientId, userTwo: currentUserId }
      ]
    });

    if (!conversation) {
      // Если конверсации нет, создаем новую
      conversation = new Conversation({
        userOne: currentUserId,
        userTwo: recipientId
      });
      await conversation.save();
    }

    // Возвращаем JSON с успехом
    res.json({ success: true, conversationId: conversation._id });
  } catch (error) {
    console.error('Ошибка при создании или получении конверсации:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});


router.get('/getMessages', async (req, res) => {
  const { recipientId, offset = 0 } = req.query; // Смещение для пагинации
  const currentUserId = req.session.userId;

  if (!recipientId) {
    return res.status(400).send('Не указан ID получателя.');
  }

  try {
    const conversation = await Conversation.findOne({
      $or: [
        { userOne: currentUserId, userTwo: recipientId },
        { userOne: recipientId, userTwo: currentUserId }
      ]
    });

    if (!conversation) {
      return res.status(404).send('Диалог не найден.');
    }

    // Получение сообщений с учетом смещения и лимита
    const messages = await Message.find({ conversationId: conversation._id })
      .sort({ sentAt: -1 }) // Сортируем по времени отправки в обратном порядке
      .skip(parseInt(offset)) // Пропустить сообщения согласно смещению
      .limit(15); // Ограничиваем количество сообщений

    res.json(messages.reverse()); // Отправляем сообщения клиенту в формате JSON, меняем порядок на прямой
  } catch (error) {
    console.error('Ошибка при получении сообщений:', error);
    res.status(500).send('Ошибка сервера.');
  }
});

router.get('/getNewMessages', async (req, res) => {
  const { recipientId, after } = req.query;
  const currentUserId = req.session.userId;

  if (!recipientId) {
    return res.status(400).send('Не указан ID получателя.');
  }

  try {
    const conversation = await Conversation.findOne({
      $or: [
        { userOne: currentUserId, userTwo: recipientId },
        { userOne: recipientId, userTwo: currentUserId }
      ]
    });

    if (!conversation) {
      return res.status(404).send('Диалог не найден.');
    }

    let query = { conversationId: conversation._id };

    if (after) {
      query.sentAt = { $gt: new Date(after) };
    }

    const newMessages = await Message.find(query)
      .sort({ sentAt: 1 }); // Сортируем по времени отправки

    res.json(newMessages);
  } catch (error) {
    console.error('Ошибка при получении новых сообщений:', error);
    res.status(500).send('Ошибка сервера.');
  }
});




router.post('/sendMessage', async (req, res) => {
  const { recipientId, content } = req.body;
  const senderId = req.session.userId;


  try {
    // Найдем соответствующую конверсацию
    const conversation = await Conversation.findOne({
      $or: [
        { userOne: senderId, userTwo: recipientId },
        { userOne: recipientId, userTwo: senderId }
      ]
    });

    if (!conversation) {
      return res.status(404).send('Диалог не найден.');
    }

    // Создание нового сообщения
    const newMessage = await Message.create({
      conversationId: conversation._id,
      sender: senderId,
      recipient: recipientId,
      content: content,
      sentAt: new Date()
    });

    // Обновляем поле последнего сообщения в разговоре
    conversation.lastMessage = newMessage._id;
    await conversation.save();

    

    // Проверяем наличие существующего непрочитанного уведомления
    const existingNotification = await Notification.findOne({
      recipient: recipientId,
      sender: senderId,
      type: 'message',
      isRead: false
    });

    if (existingNotification) {
      // Обновляем уведомление, если оно уже существует
      await Notification.findByIdAndUpdate(existingNotification._id, {
        $set: {
          content: content, // Обновляем текст сообщения
          createdAt: new Date() // Обновляем время
        }
      });
    } else {
      // Создаём новое уведомление
      await Notification.create({
        recipient: recipientId,
        sender: senderId,
        type: 'message',
        content: content
      });
    }

    // Отправляем только что созданное сообщение клиенту
    res.json(newMessage);
  } catch (error) {
    console.error('Ошибка при отправке сообщения:', error);
    res.status(500).send('Ошибка сервера.');
  }
});


// Маршрут для проверки статуса стрима
router.get('/stream-status/:streamId', async (req, res) => {
  try {
    const stream = await Stream.findById(req.params.streamId);

    if (!stream) {
      return res.status(404).json({ message: 'Стрим не найден' });
    }

    res.status(200).json({ isActive: stream.isActive });
  } catch (error) {
    console.error('Ошибка при проверке статуса стрима:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});


// Маршрут для получения активности стримера
router.post('/stream/active/:streamId', async (req, res) => {
  const { streamId } = req.params;

  try {
      // Обновляем время последней активности стримера
      await Stream.findByIdAndUpdate(streamId, { updatedAt: Date.now() });
      res.sendStatus(200); // Возвращаем успех
  } catch (error) {
      console.error('Ошибка при обновлении активности стримера:', error);
      res.sendStatus(500);
  }
});



// ===== Auto cleanup abandoned streams =====
// Why: old streams (especially isActive:false) never got removed and accumulated in DB.
// Policy:
// - Active streams: if no activity ping updates `updatedAt` for N minutes -> delete
// - Inactive streams: if `updatedAt` older than M days -> delete
const ACTIVE_TTL_MINUTES = Number(process.env.STREAM_CLEANUP_ACTIVE_TTL_MINUTES || 5);
const INACTIVE_TTL_DAYS = Number(process.env.STREAM_CLEANUP_INACTIVE_TTL_DAYS || 30);

const STREAM_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // run every 5 minutes

const cleanupAbandonedStreams = async () => {
  try {
    const now = Date.now();
    const activeCutoff = new Date(now - Math.max(1, ACTIVE_TTL_MINUTES) * 60 * 1000);
    const inactiveCutoff = new Date(now - Math.max(1, INACTIVE_TTL_DAYS) * 24 * 60 * 60 * 1000);

    const query = {
      $or: [
        { isActive: true, updatedAt: { $lt: activeCutoff } },
        { isActive: false, updatedAt: { $lt: inactiveCutoff } }
      ]
    };

    const toDelete = await Stream.find(query).select('_id isActive updatedAt userId streamType').lean();
    if (!toDelete.length) return;

    console.log(`[cleanup] deleting abandoned streams: count=${toDelete.length} activeTTL=${ACTIVE_TTL_MINUTES}m inactiveTTL=${INACTIVE_TTL_DAYS}d`);

    // Bulk delete
    await Stream.deleteMany({ _id: { $in: toDelete.map(s => s._id) } });
  } catch (error) {
    console.error('[cleanup] error while deleting abandoned streams:', error);
  }
};

setInterval(cleanupAbandonedStreams, STREAM_CLEANUP_INTERVAL_MS);





router.get('/stream/:streamId', commonDataMiddleware, async (req, res) => {
  if (!req.session.userId) { // Проверка авторизации
    return res.redirect('/');
  }

  const { streamId } = req.params;

  try {
    // ВЕБ-страница стримера (Daily/WebRTC). Это отдельная страница от OBS.
    const stream = await Stream.findById(streamId).populate('userId');

    

    if (!stream) {
      // Рендерим кастомный шаблон для отсутствующего стрима
      return res.status(404).render('streamNotFound');
    }

    // Определяем, является ли текущий пользователь стримером
    const currentUserId = res.locals.currentUser ? res.locals.currentUser._id.toString() : null;
    const isStreamer = currentUserId && currentUserId === stream.userId._id.toString();

    const io = req.app && req.app.get ? req.app.get('io') : null;

    // Если это стример и он открыл WEB-страницу — фиксируем тип стрима как Daily/WebRTC
    if (isStreamer) {
      try {
        await Stream.updateOne(
          { _id: streamId, userId: stream.userId._id },
          {
            $set: {
              streamType: 'daily-stream',
              streamProvider: 'web-stream',
              // при переходе на WEB-страницу считаем, что WEB-стрим еще не запущен
              isActive: false,
              startedAt: null,
              updatedAt: Date.now()
            }
          }
        );
        // синхронизируем объект для шаблона
        stream.streamType = 'daily-stream';
        stream.streamProvider = 'web-stream';
        stream.isActive = false;
        stream.startedAt = null;

        // Уведомляем зрителей о смене типа (чтобы перезагрузились и сменили плеер)
        try {
          if (io && stream.streamKey) {
            io.to(`stream:${stream.streamKey}`).emit('stream:update', {
              streamKey: stream.streamKey,
              streamType: 'daily-stream',
              streamProvider: 'web-stream',
              isActive: !!stream.isActive
            });
          }
        } catch (_) {}
      } catch (e) {
        console.warn('[stream] failed to set web stream type on page enter', e?.message || e);
      }
    }

    // Подготавливаем данные стримера для шаблона
    const streamerUser = stream.userId;

    const displayName = streamerUser.login || (streamerUser.email ? streamerUser.email.split('@')[0] : 'Неизвестный пользователь');
    const avatarStyle = streamerUser.avatar
      ? { url: streamerUser.avatar }
      : { gradient: getRandomGradient(), initial: displayName.charAt(0).toUpperCase() };

    const user = {
      _id: streamerUser._id,
      displayName,
      avatarStyle
    };

    // Проверка подписки текущего пользователя на стримера через коллекцию subscriptions
    let isSubscribed = false;
    if (currentUserId && !isStreamer) { // Если пользователь не является стримером
      const existingSubscription = await Subscription.findOne({
        subscriberId: currentUserId,
        subscribedToId: streamerUser._id
      });

      if (existingSubscription) {
        isSubscribed = true;
      }
    }

    // streamKey для сокет-комнаты/счетчика зрителей должен быть ЕДИНЫМ для стрима
    // (иначе у стримера и у зрителей будут разные ключи и счетчик не обновится).
    // Источник истины — поле Stream.streamKey.
    let streamKey = stream.streamKey;
    
    // ВАЖНО: Проверяем что streamKey есть, если нет - берем из user.streamKey
    if (!streamKey || streamKey === '') {
      console.warn('[WARNING] Stream.streamKey is empty, using user.streamKey');
      streamKey = stream.userId.streamKey || streamerUser?.streamKey;
      if (!streamKey) {
        console.error('[ERROR] No streamKey found for stream:', stream._id);
      }
    }
    
    console.log('[DEBUG] StreamKey for socket room:', streamKey, 'streamId:', stream._id, 'isStreamer:', isStreamer);
    
    let streamUrl = null; // URL для стрима (OBS: HTTP-FLV; Daily: WebRTC)
    if (!isStreamer) {
      // Генерируем URL для зрителей (OBS: HTTP-FLV) (Node Media Server отдает на порту 8000)
      // Используем streamKey из стрима, а не из user
      streamUrl = `${process.env.PLAYER_VIDEO || 'http://localhost:8000'}/live/${streamKey}.flv`;
      console.log('[DEBUG] OBS/FLV streamUrl for viewer:', streamUrl);
    }

    // На всякий случай синхронизируем user.streamKey если вдруг пустой (стрим уже создан, key есть).
    if (isStreamer && streamerUser && (!streamerUser.streamKey || streamerUser.streamKey === '')) {
      streamerUser.streamKey = stream.streamKey || streamKey;
      await streamerUser.save();
    }

    // Загрузка сообщений для данного стрима
    const chatMessages = await ChatMessage.find({ streamId }).populate('userId').sort({ createdAt: 1 });

    let start_server_env = process.env.START_SERVER;
    // Рендерим шаблон с передачей всех необходимых данных
    if (isStreamer) {
      res.render('streamPage', {
        stream,
        user, // Данные о стримере
        isStreamer,
        isSubscribed, // Статус подписки
        streamKey, // Передаем streamKey ВСЕМ (и стримеру, и зрителям) для счетчика
        streamUrl, // Передаем URL HLS потока для зрителей
        chatMessages, // Передаем сообщения в шаблон
        start_server_env,
        obsOnly: false
      });
    } else {
      res.render('streamPageViewer', {
        stream,
        user, // Данные о стримере
        isStreamer,
        isSubscribed, // Статус подписки
        streamKey, // Передаем streamKey ВСЕМ (и стримеру, и зрителям) для счетчика
        streamUrl, // Передаем URL HLS потока для зрителей
        chatMessages, // Передаем сообщения в шаблон
        start_server_env
      });
    }
  } catch (error) {
    console.error('Ошибка при получении стрима:', error);
    res.status(500).send('Ошибка сервера');
  }
});

// OBS-страница стримера (отдельная от WEB/Daily)
router.get('/stream-obs/:streamId', commonDataMiddleware, async (req, res) => {
  if (!req.session.userId) return res.redirect('/');

  const { streamId } = req.params;
  try {
    const stream = await Stream.findById(streamId).populate('userId');
    if (!stream) return res.status(404).render('streamNotFound');

    const currentUserId = res.locals.currentUser ? res.locals.currentUser._id.toString() : null;
    const isStreamer = currentUserId && currentUserId === stream.userId._id.toString();
    if (!isStreamer) {
      // зритель всегда на обычной странице просмотра
      return res.redirect(`/stream/${streamId}`);
    }

    // При входе на OBS-страницу сразу фиксируем тип
    await Stream.updateOne(
      { _id: streamId, userId: stream.userId._id },
      { $set: { streamType: 'obs-stream', streamProvider: 'obs', updatedAt: Date.now() } }
    );
    stream.streamType = 'obs-stream';
    stream.streamProvider = 'obs';

    // Уведомляем зрителей о смене типа
    try {
      const io = req.app && req.app.get ? req.app.get('io') : null;
      if (io && stream.streamKey) {
        io.to(`stream:${stream.streamKey}`).emit('stream:update', {
          streamKey: stream.streamKey,
          streamType: 'obs-stream',
          streamProvider: 'obs',
          isActive: !!stream.isActive
        });
      }
    } catch (_) {}

    const streamerUser = stream.userId;
    const displayName = streamerUser.login || (streamerUser.email ? streamerUser.email.split('@')[0] : 'Неизвестный пользователь');
    const avatarStyle = streamerUser.avatar
      ? { url: streamerUser.avatar }
      : { gradient: getRandomGradient(), initial: displayName.charAt(0).toUpperCase() };

    const user = { _id: streamerUser._id, displayName, avatarStyle };

    // streamKey
    let streamKey = stream.streamKey || streamerUser?.streamKey;
    let start_server_env = process.env.START_SERVER;

    res.render('streamPage', {
      stream,
      user,
      isStreamer: true,
      isSubscribed: false,
      streamKey,
      streamUrl: null,
      chatMessages: [],
      start_server_env,
      obsOnly: true
    });
  } catch (e) {
    console.error('Ошибка при открытии OBS страницы:', e);
    res.status(500).send('Ошибка сервера');
  }
});

const { v4: uuidv4 } = require('uuid');

// Маршрут для запуска стрима
router.post('/start-stream', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: 'Пользователь не авторизован' });
  }

  const { title, category, subcategory, description } = req.body;

  // Валидация
  if (!title || !category || !subcategory) {
    return res.status(400).json({ message: 'Название, категория и подкатегория обязательны' });
  }

  try {
    // Проверка на наличие активного стрима - улучшенная логика
    const existingStream = await Stream.findOne({ 
      userId: userId, 
      $or: [
        { isActive: true },
        { dailyRoom: { $exists: true, $ne: null } } // Проверяем также наличие Daily.co комнаты
      ]
    });
    
    if (existingStream) {
      // Если есть активный стрим или комната Daily.co, но стрим неактивен
      if (existingStream.isActive) {
        return res.status(400).json({ message: 'У вас уже есть активный стрим.' });
      } else if (existingStream.dailyRoom && existingStream.dailyRoom.name) {
        // Очищаем зависшую Daily.co комнату
        console.log('🧹 Очищаем зависшую Daily.co комнату для пользователя:', userId);
        await Stream.findByIdAndDelete(existingStream._id);
      }
    }

    // Получение пользователя из базы
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'Пользователь не найден' });
    }

    // Проверка на наличие streamKey
    if (!user.streamKey || user.streamKey === '') {
      // Генерация нового streamKey
      user.streamKey = uuidv4();
      await user.save(); // Сохранение ключа в базе
    }



  // Создание новой трансляции и запись streamKey
  const newStream = new Stream({
    userId,
    streamKey: user.streamKey, // Сохранение streamKey в стриме
    title,
    category,
    subcategory,
    description,
    isActive: false
  });

  await newStream.save();





    console.log(user.streamKey)
    console.log(user.streamKey)
    console.log(user.streamKey)
    console.log(user.streamKey)
    console.log(user.streamKey)

    // Отправка streamKey и данных трансляции клиенту
    res.status(200).json({
      message: 'Трансляция запущена',
      streamId: newStream._id.toString(),
      streamKey: user.streamKey
    });
  } catch (error) {
    console.error('Ошибка при запуске трансляции:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});




// Роут для активации стрима (isActive: true)
router.post('/set-active', async (req, res) => {
  const { streamKey } = req.body;

  if (!streamKey) {
    return res.status(400).json({ message: 'streamKey обязателен' });
  }

  try {
    // Находим стрим по streamKey и обновляем isActive на true, устанавливаем время начала
    const stream = await Stream.findOneAndUpdate(
      { streamKey },
      { 
        isActive: true,
        startedAt: new Date() // Устанавливаем время начала стрима
      },
      { new: true } // Возвращаем обновлённый документ
    );

    if (!stream) {
      return res.status(404).json({ message: 'Стрим не найден' });
    }

    // notify viewers (e.g. WEB stream started -> reconnect)
    try {
      const io = req.app && req.app.get ? req.app.get('io') : null;
      if (io && stream && stream.streamKey) {
        io.to(`stream:${stream.streamKey}`).emit('stream:update', {
          streamKey: stream.streamKey,
          streamType: stream.streamType,
          streamProvider: stream.streamProvider,
          isActive: true,
          startedAt: stream.startedAt
        });
      }
    } catch (_) {}

    res.status(200).json({
      message: 'Стрим активирован',
      streamId: stream._id,
      isActive: stream.isActive,
    });
  } catch (err) {
    console.error('Ошибка при активации стрима:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// // Роут для деактивации стрима (isActive: false)
router.post('/set-inactive', async (req, res) => {
  const { streamKey } = req.body;

  if (!streamKey) {
    return res.status(400).json({ message: 'streamKey обязателен' });
  }

  try {
    // Находим стрим по streamKey и обновляем isActive на false, сбрасываем время начала
    const stream = await Stream.findOneAndUpdate(
      { streamKey },
      { 
        isActive: false,
        startedAt: null // Сбрасываем время начала при деактивации
      },
      { new: true } // Возвращаем обновлённый документ
    );

    if (!stream) {
      return res.status(404).json({ message: 'Стрим не найден' });
    }

    // Останавливаем периодическое обновление плейлиста
    try {
      stopPlaylistUpdates(streamKey);
    } catch (playlistError) {
      console.warn('Предупреждение: не удалось остановить обновление плейлиста:', playlistError);
    }

    // notify viewers
    try {
      const io = req.app && req.app.get ? req.app.get('io') : null;
      if (io && stream && stream.streamKey) {
        io.to(`stream:${stream.streamKey}`).emit('stream:update', {
          streamKey: stream.streamKey,
          streamType: stream.streamType,
          streamProvider: stream.streamProvider,
          isActive: false
        });
      }
    } catch (_) {}

    res.status(200).json({
      message: 'Стрим деактивирован',
      streamId: stream._id,
      isActive: stream.isActive,
    });
  } catch (err) {
    console.error('Ошибка при деактивации стрима:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});



// Новые эндпоинты специально для OBS
router.post('/obs-stream-start', async (req, res) => {
  try {
      const { streamKey } = req.body;
      
      const updatedStream = await Stream.findOneAndUpdate(
          { streamKey: streamKey },
          { 
              streamType: 'obs-stream',
              streamProvider: 'obs',
              updatedAt: Date.now() 
          },
          { new: true }
      );

      if (!updatedStream) {
          return res.status(404).json({ error: 'Stream not found' });
      }

      // notify viewers to swap player if needed
      try {
        const io = req.app && req.app.get ? req.app.get('io') : null;
        if (io && updatedStream && updatedStream.streamKey) {
          io.to(`stream:${updatedStream.streamKey}`).emit('stream:update', {
            streamKey: updatedStream.streamKey,
            streamType: updatedStream.streamType,
            streamProvider: updatedStream.streamProvider,
            isActive: !!updatedStream.isActive
          });
        }
      } catch (_) {}

      res.json({ 
          success: true, 
          message: 'OBS stream started',
          stream: updatedStream 
      });
  } catch (error) {
      console.error('Error updating OBS stream status:', error);
      res.status(500).json({ error: 'Server error' });
  }
});

router.post('/obs-stream-end', async (req, res) => {
  try {
      const { streamKey } = req.body;
      
      const updatedStream = await Stream.findOneAndUpdate(
          { streamKey: streamKey },
          { 
              streamType: 'daily-stream',
              streamProvider: 'web-stream',
              updatedAt: Date.now() 
          },
          { new: true }
      );

      if (!updatedStream) {
          return res.status(404).json({ error: 'Stream not found' });
      }

      // Останавливаем периодическое обновление плейлиста
      try {
        stopPlaylistUpdates(streamKey);
      } catch (playlistError) {
        console.warn('Предупреждение: не удалось остановить обновление плейлиста:', playlistError);
      }

      // notify viewers to swap player if needed
      try {
        const io = req.app && req.app.get ? req.app.get('io') : null;
        if (io && updatedStream && updatedStream.streamKey) {
          io.to(`stream:${updatedStream.streamKey}`).emit('stream:update', {
            streamKey: updatedStream.streamKey,
            streamType: updatedStream.streamType,
            streamProvider: updatedStream.streamProvider,
            isActive: !!updatedStream.isActive
          });
        }
      } catch (_) {}

      res.json({ 
          success: true, 
          message: 'OBS stream ended',
          stream: updatedStream 
      });
  } catch (error) {
      console.error('Error updating OBS stream status:', error);
      res.status(500).json({ error: 'Server error' });
  }
});




// Маршрут для загрузки заглавной картинки (thumbnail)
router.post('/upload-thumbnail', upload.single('thumbnail'), async (req, res) => {
  const { streamId, oldThumbnailPath } = req.body;
  const userId = req.session.userId;

  if (!streamId || !userId) {
      return res.status(400).json({ message: 'Недостаточно данных.' });
  }

  try {
      if (!mongoose.Types.ObjectId.isValid(streamId)) {
          return res.status(400).json({ message: 'Некорректный streamId.' });
      }

      // Найдем стрим и проверим, что он принадлежит текущему пользователю
      const stream = await Stream.findOne({ _id: streamId, userId: userId });

      if (!stream) {
          return res.status(404).json({ message: 'Стрим не найден.' });
      }

      if (req.file) {
          // Удаляем старое изображение, если оно существует
          if (oldThumbnailPath) {
              const fullOldPath = path.join(__dirname, '..', 'public', oldThumbnailPath);
              fs.unlink(fullOldPath, (err) => {
                  if (err) {
                      console.error('Ошибка при удалении старого изображения:', err);
                  } else {
                      console.log('Старое изображение успешно удалено.');
                  }
              });
          }

          // Обновляем поле thumbnail в документе Stream
          stream.thumbnail = `/uploads/thumbnails/${req.file.filename}`;
          await stream.save();

          res.status(200).json({ message: 'Заглавная картинка загружена.', thumbnailPath: stream.thumbnail });
      } else {
          res.status(400).json({ message: 'Изображение не загружено.' });
      }
  } catch (error) {
      console.error('Ошибка при загрузке заглавной картинки:', error);
      res.status(500).json({ message: 'Ошибка сервера.' });
  }
});



// Маршрут для постановки стрима на паузу
router.post('/api/pause-stream', async (req, res) => {
  const { streamKey } = req.body;
  const userId = req.session.userId;

  console.log(`Запрос на паузу стрима: streamKey=${streamKey}, userId=${userId}`);

  if (!streamKey || !userId) {
      console.log('Недостаточно данных для постановки стрима на паузу');
      return res.status(400).json({ message: 'Недостаточно данных.' });
  }

  try {
      const stream = await Stream.findOne({ streamKey: streamKey, userId: userId, isActive: true });

      if (!stream) {
          console.log('Активный стрим не найден для паузы');
          return res.status(404).json({ message: 'Активный стрим не найден.' });
      }

      stream.isActive = false;
      stream.startedAt = null; // Сбрасываем время начала при паузе
      await stream.save();

      console.log('Стрим успешно поставлен на паузу:', stream);

      res.json({ message: 'Стрим успешно поставлен на паузу.', stream: stream });
  } catch (error) {
      console.error('Ошибка при постановке стрима на паузу:', error);
      res.status(500).json({ message: 'Ошибка сервера.' });
  }
});

// // Маршрут для возобновления стрима
// router.post('/resume-stream', async (req, res) => {
//   const { streamId } = req.body;
//   const userId = req.session.userId;

//   console.log(`Запрос на возобновление стрима: streamId=${streamId}, userId=${userId}`);

//   if (!streamId || !userId) {
//       console.log('Недостаточно данных для возобновления стрима');
//       return res.status(400).json({ message: 'Недостаточно данных.' });
//   }

//   try {
//       if (!mongoose.Types.ObjectId.isValid(streamId)) {
//           console.log('Некорректный streamId');
//           return res.status(400).json({ message: 'Некорректный streamId.' });
//       }

//       const stream = await Stream.findOne({ _id: streamId, userId: userId, isActive: false });

//       if (!stream) {
//           console.log('Стрим не найден или уже активен');
//           return res.status(404).json({ message: 'Стрим не найден или уже активен.' });
//       }

//       // Проверяем, есть ли уже другой активный стрим
//       const existingStream = await Stream.findOne({ userId: userId, isActive: true });
//       if (existingStream) {
//           return res.status(400).json({ message: 'У вас уже есть активный стрим.' });
//       }

//       stream.isActive = true;
//       await stream.save();

//       console.log('Стрим успешно возобновлен:', stream);

//       res.json({ message: 'Стрим успешно возобновлен.' });
//   } catch (error) {
//       console.error('Ошибка при возобновлении стрима:', error);
//       res.status(500).json({ message: 'Ошибка сервера.' });
//   }
// });

// Маршрут для завершения стрима
router.post('/terminate-stream', async (req, res) => {
  const { streamId } = req.body;
  const userId = req.session.userId;

  console.log(`Запрос на завершение стрима: streamId=${streamId}, userId=${userId}`);

  if (!streamId || !userId) {
      console.log('Недостаточно данных для завершения стрима');
      return res.status(400).json({ message: 'Недостаточно данных.' });
  }

  try {
      if (!mongoose.Types.ObjectId.isValid(streamId)) {
          console.log('Некорректный streamId');
          return res.status(400).json({ message: 'Некорректный streamId.' });
      }

      // Завершаем стрим независимо от его текущего состояния
      const stream = await Stream.findOneAndDelete({ _id: streamId, userId: userId });

      if (!stream) {
          console.log('Стрим не найден или уже завершен');
          return res.status(404).json({ message: 'Стрим не найден или уже завершен.' });
      }

      console.log('Стрим успешно завершен и удален:', stream);

      res.json({ message: 'Стрим успешно завершен и удален.' });
  } catch (error) {
      console.error('Ошибка при завершении стрима:', error);
      res.status(500).json({ message: 'Ошибка сервера.' });
  }
});




// Эндпоинт для отправки сообщений
router.post('/chat/message', async (req, res) => {
  try {
      const { streamId, userId, username, message } = req.body;

      if (!streamId || !userId || !message || !username) {
          return res.status(400).json({ message: 'Неправильные данные' });
      }

      // Создаём новое сообщение
      const chatMessage = new ChatMessage({
          streamId,
          userId,
          username,
          message
      });

      // Сохраняем сообщение в базу данных
      await chatMessage.save();

      return res.status(200).json({ message: 'Сообщение успешно отправлено и сохранено' });
  } catch (error) {
      console.error('Ошибка при сохранении сообщения:', error);
      return res.status(500).json({ message: 'Ошибка сервера' });
  }
});


router.get('/api/chat/messages/new', async (req, res) => {
  const { streamId, lastMessageTime } = req.query;

  // console.log("📡 API запрос новых сообщений");
  // console.log("📡 Полученный streamId:", streamId);
  // console.log("📡 Полученное время последнего сообщения:", lastMessageTime);

  try {
    const query = { streamId };

    // Если передано время последнего сообщения, возвращаем сообщения позже этого времени
    if (lastMessageTime && !isNaN(new Date(lastMessageTime).getTime())) {
      query.createdAt = { $gt: new Date(lastMessageTime) }; // Только сообщения, которые новее последнего сообщения
      // console.log("Запрос новых сообщений после времени:", lastMessageTime);
    }

    const newMessages = await ChatMessage.find(query)
      .sort({ createdAt: 1 }) // Сортируем по времени
      .populate('userId');

    // console.log("📨 Найденные новые сообщения:", newMessages.length, "штук");
    // if (newMessages.length > 0) {
    //   console.log("📨 Первое сообщение:", newMessages[0]);
    // }

    res.json(newMessages);
  } catch (error) {
    console.error('Ошибка при получении новых сообщений:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});











// Маршрут для поиска пользователей
router.get('/search-users', async (req, res) => {
  const query = req.query.q;

  // Если нет запроса, возвращаем пустой массив
  if (!query) {
      return res.json([]);
  }

  try {
      // Ищем пользователей по имени или email (ограничиваем 7 результатами)
      const users = await User.find({
          $or: [
              { login: new RegExp(query, 'i') }, // Поиск по имени
              { email: new RegExp(query, 'i') }  // Поиск по email
          ]
      }).limit(7);

      // Для каждого пользователя считаем количество подписчиков
      const usersWithFollowers = await Promise.all(users.map(async user => {
          const followersCount = await Subscription.countDocuments({ subscribedToId: user._id });
          const displayName = user.login || (user.email ? user.email.split('@')[0] : 'Неизвестный пользователь');
          const avatarStyle = user.avatar
              ? { url: user.avatar }
              : { gradient: getRandomGradient(), initial: displayName.charAt(0).toUpperCase() };

          return {
              _id: user._id,
              displayName,
              avatarStyle, // Аватарка или градиент с буквой
              followersCount
          };
      }));

      // Возвращаем результат на фронтенд
      res.json(usersWithFollowers);
  } catch (error) {
      console.error('Ошибка при поиске пользователей:', error);
      res.status(500).json({ message: 'Ошибка сервера при поиске пользователей' });
  }
});


// Маршрут для "Terms Of Service"
router.get('/terms_of_service', (req, res) => {
  res.render('terms/terms_of_service');
});

// Маршрут для "Пользовательского соглашения"
router.get('/user_agreement', (req, res) => {
  res.render('terms/user_agreement');
});

// Маршрут для "Политики обработки персональных данных"
router.get('/personal_data_processing', (req, res) => {
  res.render('terms/personal_data_processing');
});






module.exports = router;
