// Профиль: аватар, галерея, поиск людей. Смена логина и пароля — в routes/userRoutes.js.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const fs = require('fs');
const path = require('path');
const User = require('../../models/User');
const Subscription = require('../../models/Subscription');
const { requireAuth } = require('../../middleware/auth');
const { resolveWithin, isPlainFileName } = require('../../utils/safePath');
const { uploadAvatar, uploadGallery } = require('./uploads');
const userView = require('../../utils/userView');

// Загрузка аватарки профиля.
// requireAuth стоит ПЕРЕД multer намеренно: иначе файл успевал лечь на диск
// до проверки сессии — аноним получал 401, но место на диске уже занял.
router.post('/profile/avatar', requireAuth, uploadAvatar.single('avatar'), async (req, res) => {
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
    return res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// Загрузка фотографий в галерею (до 100 суммарно).
// requireAuth перед multer — см. комментарий у /profile/avatar.
router.post('/profile/gallery', requireAuth, uploadGallery.array('photos', 100), async (req, res) => {
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
router.delete('/profile/gallery/:name', requireAuth, async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ success: false, message: 'Необходима авторизация' });
    }
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });

    const fileName = req.params.name; // ожидается имя файла, без папок

    // Express раскодирует %2F в параметре маршрута, поэтому сюда приходило
    // `../../app.js`, и unlinkSync сносил любой файл, до которого дотягивался
    // процесс. Воспроизводилось обычным пользователем.
    if (!isPlainFileName(fileName)) {
      return res.status(400).json({ success: false, message: 'Некорректное имя файла' });
    }

    const urlPrefix = `/uploads/gallery/${req.session.userId}/`;
    const fullUrl = urlPrefix + fileName;

    // Удаляем из массива
    user.gallery = (user.gallery || []).filter(u => u !== fullUrl);
    await user.save();

    // Удаляем из файловой системы — строго из папки галереи этого пользователя
    const galleryDir = path.join(__dirname, '..', 'public', 'uploads', 'gallery', String(req.session.userId));
    const filePath = resolveWithin(galleryDir, fileName);
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Ошибка удаления фото из галереи:', err);
    return res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

router.get('/search-users', requireAuth, async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';

  // Если нет запроса, возвращаем пустой массив
  if (!query) {
      return res.json([]);
  }

  // Строка поиска — текст, а не регулярное выражение: без экранирования
  // «(a+)+$» подвешивал бы процесс, а «.*» находил бы всех.
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  try {
      // Ищем пользователей по имени или email (ограничиваем 7 результатами)
      const users = await User.find({
          $or: [
              { login: pattern }, // Поиск по имени
              { email: pattern }  // Поиск по email
          ]
      }).limit(7);

      // Для каждого пользователя считаем количество подписчиков
      const usersWithFollowers = await Promise.all(users.map(async user => {
          const followersCount = await Subscription.countDocuments({ subscribedToId: user._id });
          const displayName = userView.displayName(user);
          const avatarStyle = userView.avatarStyle(user, displayName);

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

module.exports = router;
