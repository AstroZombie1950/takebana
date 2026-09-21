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
const GalleryVideo = require('../../models/GalleryVideo');
const galleryVideo = require('../../utils/galleryVideo');
const { saveImage, BadImageError } = require('../../utils/image');
const galleryPhotos = require('../../utils/galleryPhotos');
const errorLog = require('../../utils/errorLog');
const { commonDataMiddleware } = require('./shared');
const bcrypt = require('bcrypt');
const { PASSWORD_PROVIDER, PASSWORD_MAX } = require('../../utils/password');
const { authLimiter } = require('../../middleware/rateLimit');
const { validate } = require('../../middleware/validate');
const { removeUser } = require('../../utils/userDelete');
const userView = require('../../utils/userView');
const { audit } = require('../../utils/audit');
const nickname = require('../../utils/nickname');
const { mailConfigured } = require('../../utils/mail');

// Страница настроек: имя и ник, фото, пароль, почта, язык, удаление. Раньше — окно поверх
// любой страницы кабинета, и его разметка со скриптом ехали с каждой из них.
router.get('/settings', requireAuth, commonDataMiddleware, async (req, res) => {
  // Роль — ради блока удаления аккаунта: у администратора его нет. Общий
  // commonDataMiddleware роль не тянет, и ради одной страницы добавлять её
  // в выборку каждой страницы кабинета незачем.
  const user = await User.findById(req.session.userId)
    .select('provider role login nickname nicknameChangedAt email emailChange emailVerifiedAt restricted').lean();
  if (!user) return res.redirect('/login');
  // Кому закрыт канал (utils/restrict.js): здесь доступ можно вернуть.
  const restrictedUsers = (user.restricted || []).length
    ? await User.find({ _id: { $in: user.restricted } }).select('nickname login email avatar').lean()
    : [];
  const restricted = restrictedUsers.map((u) => {
    const displayName = userView.displayName(u);
    return { _id: String(u._id), displayName, avatarStyle: userView.avatarStyle(u, displayName) };
  });
  const pending = user.emailChange && user.emailChange.expiresAt > new Date() ? user.emailChange.email : '';
  res.render('settings', {
    hasPassword: (user.provider || '') === PASSWORD_PROVIDER,
    canDelete: user.role !== 'admin',
    mailOn: mailConfigured,
    restricted,
    profile: {
      login: user.login || '',
      nickname: user.nickname || '',
      nickNext: nickname.nextChangeAt(user),
      email: user.email || '',
      pendingEmail: pending,
      // У входа через Google почту подтвердил Google.
      emailVerified: !!user.emailVerifiedAt || (user.provider || '') !== PASSWORD_PROVIDER,
    },
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

  // Сжатие и выгрузка в Bunny — utils/galleryPhotos.js.
  let urls;
  try {
    urls = await galleryPhotos.save(req.session.userId, req.files || []);
  } catch (e) {
    if (!(e instanceof BadImageError)) throw e;
    return res.status(400).json({ success: false, message: e.message });
  }

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

  // Только своё фото: адрес ищется в галерее этого человека — на CDN
  // или, у загруженных до переезда в Bunny, на сервере.
  const fullUrl = galleryPhotos.find(req.session.userId, user.gallery, fileName);
  if (!fullUrl) return res.status(404).json({ success: false, message: 'Фото не найдено' });

  user.gallery = user.gallery.filter(u => u !== fullUrl);
  await user.save();
  await galleryPhotos.remove(req.session.userId, fullUrl)
    .catch((e) => errorLog.external(e, 'gallery.photo.remove', { url: fullUrl }));

  audit(req, 'profile.gallery.delete', { targetType: 'user', target: user, meta: { file: fileName } });
  return res.json({ success: true });
});

// ── Видео в галерее ──────────────────────────────────────────────────────
// Принимает их страница загрузки (routes/streaming/upload.js), пережатие
// со знаком — в фоне (utils/galleryVideo.js). Здесь — состояние для
// страницы профиля, пока ролик не готов, и удаление.
const OBJECT_ID = /^[a-f\d]{24}$/i;

function videoView(v) {
  return {
    id: String(v._id),
    status: v.status,
    error: v.error || '',
    duration: v.duration || 0,
    url: (v.video && v.video.url) || '',
    thumb: (v.thumb && v.thumb.url) || '',
  };
}

router.get('/profile/gallery/video/:id', requireAuth, async (req, res) => {
  const v = OBJECT_ID.test(req.params.id)
    ? await GalleryVideo.findOne({ _id: req.params.id, userId: req.session.userId }).lean()
    : null;
  if (!v) return res.status(404).json({ success: false, message: 'Видео не найдено' });
  res.json({ success: true, video: videoView(v) });
});

// Удаляет владелец. Пока ролик пережимается, удаление тоже можно: обработка
// увидит, что записи нет, и уберёт выгруженное за собой.
router.delete('/profile/gallery/video/:id', requireAuth, async (req, res) => {
  const v = OBJECT_ID.test(req.params.id)
    ? await GalleryVideo.findOne({ _id: req.params.id, userId: req.session.userId }).lean()
    : null;
  if (!v) return res.status(404).json({ success: false, message: 'Видео не найдено' });
  await galleryVideo.remove(v);
  audit(req, 'profile.gallery.video.delete', { targetType: 'user', targetId: req.session.userId, meta: { video: String(v._id) } });
  res.json({ success: true });
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
