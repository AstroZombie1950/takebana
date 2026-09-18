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
const { saveImage, saveImages, BadImageError } = require('../../utils/image');
const { commonDataMiddleware } = require('./shared');
const bcrypt = require('bcrypt');
const { PASSWORD_PROVIDER, PASSWORD_MAX } = require('../../utils/password');
const { authLimiter } = require('../../middleware/rateLimit');
const { validate } = require('../../middleware/validate');
const { removeUser } = require('../../utils/userDelete');
const userView = require('../../utils/userView');
const { audit } = require('../../utils/audit');

// Страница настроек: имя, фото, язык, галерея, пароль. Раньше — окно поверх
// любой страницы кабинета, и его разметка со скриптом ехали с каждой из них.
router.get('/settings', requireAuth, commonDataMiddleware, async (req, res) => {
  // Роль — ради блока удаления аккаунта: у администратора его нет. Общий
  // commonDataMiddleware роль не тянет, и ради одной страницы добавлять её
  // в выборку каждой страницы кабинета незачем.
  const user = await User.findById(req.session.userId).select('provider role').lean();
  res.render('settings', {
    hasPassword: !!user && (user.provider || '') === PASSWORD_PROVIDER,
    canDelete: !!user && user.role !== 'admin',
  });
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
  // Удалять нечего: файл ещё в памяти, на диск он ложится строкой ниже.
  if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });

  let name;
  try {
    name = await saveImage(req.file.buffer, 'avatar', path.join(UPLOADS, 'avatars'));
  } catch (e) {
    if (!(e instanceof BadImageError)) throw e;
    return res.status(400).json({ success: false, message: e.message });
  }

  const old = user.avatar;
  user.avatar = `/uploads/avatars/${name}`;
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

  let names;
  try {
    names = await saveImages(req.files || [], 'gallery', path.join(UPLOADS, 'gallery', String(req.session.userId)));
  } catch (e) {
    if (!(e instanceof BadImageError)) throw e;
    return res.status(400).json({ success: false, message: e.message });
  }

  const basePath = `/uploads/gallery/${req.session.userId}/`;
  const urls = names.map(n => basePath + n);
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

// Удаление своего аккаунта. Право на удаление данных человек применяет сам,
// а не письмом в поддержку: удаляется ровно то же, что при удалении из панели
// (utils/userDelete.js) — эфиры, записи, заведения, переписка, файлы.
// В журнале действий остаётся строка о самом удалении: она нужна на случай
// спора и живёт столько же, сколько остальной журнал.
router.post('/profile/delete', authLimiter, requireAuth, validate({
  // Пароля нет у входа через Google: там подтверждением служит сам сеанс.
  password: { type: 'string', max: PASSWORD_MAX, trim: false, label: 'Пароль' },
}), async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });

  // Администратор себя не удаляет: панель осталась бы без владельца, а вместе
  // с аккаунтом ушли бы чужие жалобы и разборы. Сначала сменить роль.
  if (user.role === 'admin') {
    return res.status(403).json({ success: false, message: 'Аккаунт администратора удаляется только из панели' });
  }

  if ((user.provider || '') === PASSWORD_PROVIDER) {
    const match = req.body.password ? await bcrypt.compare(req.body.password, user.password) : false;
    if (!match) {
      audit(req, 'profile.delete', { result: 'fail', targetType: 'user', target: user });
      return res.status(400).json({ success: false, message: 'Неверный пароль' });
    }
  }

  // Запись до удаления: после него имени и почты для журнала уже не будет.
  audit(req, 'profile.delete', { targetType: 'user', target: user });
  const removed = await removeUser(user, req.app.get('io'));

  // Сеансы человека removeUser уже удалил из коллекции, но при resave: true
  // express-session записал бы нынешний обратно в конце запроса — и браузер
  // ходил бы с ключом на удалённого пользователя. Поэтому явный destroy.
  await new Promise((resolve) => req.session.destroy(resolve));
  res.clearCookie('connect.sid');
  res.json({ success: true, removed });
});

module.exports = router;
