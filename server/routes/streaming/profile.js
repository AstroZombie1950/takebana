// Профиль: страница настроек, аватар, галерея, поиск людей. Смена логина
// и пароля — в routes/userRoutes.js.

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
const { UPLOADS, uploadAvatar, uploadGallery } = require('./uploads');
const { commonDataMiddleware } = require('./shared');
const { PASSWORD_PROVIDER } = require('../../utils/password');
const userView = require('../../utils/userView');
const { audit } = require('../../utils/audit');

// Страница настроек: имя, фото, язык, галерея, пароль. Раньше — окно поверх
// любой страницы кабинета, и его разметка со скриптом ехали с каждой из них.
router.get('/settings', requireAuth, commonDataMiddleware, async (req, res) => {
  const user = await User.findById(req.session.userId).select('provider').lean();
  res.render('settings', { hasPassword: !!user && (user.provider || '') === PASSWORD_PROVIDER });
});

// Файл аватара удаляем, только если он наш: у входа через Google в поле
// лежит внешний адрес.
function removeAvatarFile(url) {
  const prefix = '/uploads/avatars/';
  if (typeof url !== 'string' || !url.startsWith(prefix)) return;
  const name = url.slice(prefix.length);
  const file = isPlainFileName(name) && resolveWithin(path.join(UPLOADS, 'avatars'), name);
  if (file) fs.unlink(file, () => {});
}

// Ответ после смены фото: как теперь выглядит аватар везде — фото или
// градиент с буквой.
const avatarOf = (user) => userView.avatarStyle(user);

// Загрузка аватарки профиля. Прежнее фото с диска удаляется.
// requireAuth стоит ПЕРЕД multer намеренно: иначе файл успевал лечь на диск
// до проверки сессии — аноним получал 401, но место на диске уже занял.
router.post('/profile/avatar', requireAuth, uploadAvatar.single('avatar'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Файл не передан' });
  }
  const user = await User.findById(req.session.userId);
  if (!user) {
    fs.unlink(req.file.path, () => {});
    return res.status(404).json({ success: false, message: 'Пользователь не найден' });
  }

  const old = user.avatar;
  user.avatar = `/uploads/avatars/${req.file.filename}`;
  await user.save();
  removeAvatarFile(old);

  audit(req, 'profile.avatar', { targetType: 'user', target: user });
  res.json({ success: true, url: user.avatar, avatar: avatarOf(user) });
});

// Удаление фото профиля: остаётся градиент с первой буквой имени.
router.delete('/profile/avatar', requireAuth, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });

  const old = user.avatar;
  user.avatar = null;
  await user.save();
  removeAvatarFile(old);

  audit(req, 'profile.avatar.delete', { targetType: 'user', target: user });
  res.json({ success: true, avatar: avatarOf(user) });
});

// Загрузка фотографий в галерею (до 100 суммарно).
// requireAuth перед multer — см. комментарий у /profile/avatar.
router.post('/profile/gallery', requireAuth, uploadGallery.array('photos', 100), async (req, res) => {
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

  audit(req, 'profile.gallery.add', { targetType: 'user', target: user, meta: { added: urls.length, total: user.gallery.length } });
  return res.json({ success: true, urls: urls, total: user.gallery.length });
});

// Удаление фото из галереи
router.delete('/profile/gallery/:name', requireAuth, async (req, res) => {
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
  const galleryDir = path.join(UPLOADS, 'gallery', String(req.session.userId));
  const filePath = resolveWithin(galleryDir, fileName);
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  audit(req, 'profile.gallery.delete', { targetType: 'user', target: user, meta: { file: fileName } });
  return res.json({ success: true });
});

module.exports = router;
