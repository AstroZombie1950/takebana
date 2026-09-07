// Профиль: аватар, галерея, смена логина и пароля, поиск людей.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const User = require('../../models/User');
const Subscription = require('../../models/Subscription');
const { requireAuth } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { authLimiter } = require('../../middleware/rateLimit');
const { resolveWithin, isPlainFileName } = require('../../utils/safePath');
const { uploadAvatar, uploadGallery } = require('./uploads');
const { getRandomGradient } = require('./shared');

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
    return res.status(500).json({ success: false, message: err.message || 'Ошибка сервера' });
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

// Маршрут для установки значения в сессии и перенаправления

// authLimiter: здесь тоже меняется пароль (action === 'updatePassword'), а значит
// маршрут годится для перебора ровно как /update-password и /admin/updatePassword.
// Схема описывает объединение двух действий: обязательность полей внутри ветки
// проверяет обработчик — схема не умеет «обязательно, только если action такой».
router.post('/streaming/update-profile', requireAuth, authLimiter, validate({
  action: { type: 'string', required: true, values: ['updatePassword', 'updateProfile'], label: 'Действие' },
  oldPassword: { type: 'string', max: 200, trim: false, label: 'Старый пароль' },
  newPassword: { type: 'string', min: 6, max: 200, trim: false, label: 'Новый пароль' },
  login: { type: 'string', max: 64, label: 'Логин' },
}), async (req, res) => {
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
      // Схема сюда не пускает, но без ветки добавленное в неё третье действие
      // означало бы запрос без ответа — висящий, а не отвергнутый.
      res.status(400).json({ message: 'Некорректное действие.' });
    }
  } catch (error) {
    console.error('Ошибка при обновлении профиля:', error);
    res.status(500).json({ message: 'Ошибка сервера.' });
  }
});


// Маршрут для подписки на пользователя

router.get('/search-users', requireAuth, async (req, res) => {
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

module.exports = router;
