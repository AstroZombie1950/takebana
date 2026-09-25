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
const GalleryPhoto = require('../../models/GalleryPhoto');
const { saveImage, BadImageError } = require('../../utils/image');
const galleryPhotos = require('../../utils/galleryPhotos');
const { commonDataMiddleware } = require('./shared');
const bcrypt = require('bcrypt');
const { PASSWORD_PROVIDER, PASSWORD_MAX } = require('../../utils/password');
const { authLimiter } = require('../../middleware/rateLimit');
const loginGuard = require('../../utils/loginGuard');
const { validate } = require('../../middleware/validate');
const { removeUser } = require('../../utils/userDelete');
const userView = require('../../utils/userView');
const ogImage = require('../../utils/ogImage');
const { audit } = require('../../utils/audit');
const nickname = require('../../utils/nickname');
const { mailConfigured } = require('../../utils/mail');
const profileLinks = require('../../utils/profileLinks');
const privacy = require('../../utils/privacy');

// Страница настроек: имя и ник, фото, пароль, почта, язык, удаление. Раньше — окно поверх
// любой страницы кабинета, и его разметка со скриптом ехали с каждой из них.
router.get('/settings', requireAuth, commonDataMiddleware, async (req, res) => {
  // Роль — ради блока удаления аккаунта: у администратора его нет. Общий
  // commonDataMiddleware роль не тянет, и ради одной страницы добавлять её
  // в выборку каждой страницы кабинета незачем.
  const user = await User.findById(req.session.userId)
    .select('provider role login nickname nicknameChangedAt email emailChange emailVerifiedAt restricted bio links privacy').lean();
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
    privacy: privacy.of(user),
    profile: {
      login: user.login || '',
      nickname: user.nickname || '',
      nickNext: nickname.nextChangeAt(user),
      email: user.email || '',
      pendingEmail: pending,
      // У входа через Google почту подтвердил Google.
      emailVerified: !!user.emailVerifiedAt || (user.provider || '') !== PASSWORD_PROVIDER,
      bio: user.bio || '',
      // Ссылки — как их показать в полях: kind → { display, url }.
      links: Object.fromEntries(profileLinks.list(user.links).map((l) => [l.kind, l])),
    },
    linksOn: profileLinks.ENABLED,
    linkKinds: profileLinks.KINDS,
    linkNames: profileLinks.NAMES,
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
  ogImage.refresh(user); // карточка для мессенджеров — в фоне

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
  ogImage.refresh(user); // без аватара карточка не нужна — уберётся из облака

  audit(req, 'profile.avatar.delete', { targetType: 'user', target: user });
  res.json({ success: true, avatar: avatarOf(user) });
});

// Загрузка фотографий в галерею (до MAX_PER_USER суммарно, за раз — до
// PER_REQUEST). Файлы multer держит в памяти, поэтому сколько принять,
// решается до него: раньше до 100 файлов по 10 МБ читались целиком и только
// потом упирались в лимит. Больше остатка multer не примет — 400.
// requireAuth перед multer — см. комментарий у /profile/avatar.
//
// Подписи (25.09) — полем captions, JSON-массивом в порядке файлов: у формы
// с файлами тело не JSON, и validate() до него не дотягивается.
const { MAX_PER_USER: PHOTOS_MAX, PER_REQUEST: PHOTOS_PER_REQUEST, CAPTION_MAX } = galleryPhotos;

function captionsOf(raw, n) {
  let list = [];
  try { list = JSON.parse(raw || '[]'); } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  return Array.from({ length: n }, (_, i) => String(list[i] == null ? '' : list[i]).trim().slice(0, CAPTION_MAX));
}

router.post('/profile/gallery', requireAuth, async (req, res, next) => {
  const left = PHOTOS_MAX - await GalleryPhoto.countDocuments({ userId: req.session.userId });
  if (left <= 0) return res.status(400).json({ success: false, message: 'Лимит 100 фото уже достигнут' });
  uploadGallery.array('photos', Math.min(left, PHOTOS_PER_REQUEST))(req, res, next);
}, async (req, res) => {
  const userId = req.session.userId;
  // Параллельная загрузка могла занять место, пока шёл этот запрос.
  const left = PHOTOS_MAX - await GalleryPhoto.countDocuments({ userId });
  if (left <= 0) return res.status(400).json({ success: false, message: 'Лимит 100 фото уже достигнут' });
  const files = (req.files || []).slice(0, left);
  const captions = captionsOf(req.body.captions, files.length);

  // Сжатие, знак и выгрузка в Bunny — utils/galleryPhotos.js.
  let urls;
  try {
    urls = await galleryPhotos.save(userId, files);
  } catch (e) {
    if (!(e instanceof BadImageError)) throw e;
    return res.status(400).json({ success: false, message: e.message });
  }

  // Время — с шагом в миллисекунду: пачка выбрана в одном порядке и в нём же
  // должна лечь в ленту (новые сверху, первое выбранное — самое новое).
  const now = Date.now();
  const photos = await GalleryPhoto.insertMany(urls.map((url, i) => ({
    userId, url, caption: captions[i], createdAt: new Date(now + urls.length - i),
  })));
  const total = await GalleryPhoto.countDocuments({ userId });

  audit(req, 'profile.gallery.add', { targetType: 'user', targetId: userId, meta: { added: photos.length, total } });
  return res.json({ success: true, photos: photos.map((p) => ({ id: String(p._id), url: p.url })), total });
});

// ── Видео в галерее ──────────────────────────────────────────────────────
// Принимает их страница загрузки (routes/streaming/upload.js), пережатие
// со знаком — в фоне (utils/galleryVideo.js). Здесь — состояние для
// плитки, пока ролик не готов; удаление — DELETE /video/:id (routes/watch.js).
const OBJECT_ID = /^[a-f\d]{24}$/i;

function videoView(v) {
  return {
    id: String(v._id),
    status: v.status,
    error: v.error || '',
    duration: v.duration || 0,
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
    const attempt = await loginGuard.start(req, res, user.email, { task: false });
    if (!attempt) return;
    const match = req.body.password ? await bcrypt.compare(req.body.password, user.password) : false;
    if (!match) {
      audit(req, 'profile.delete', { result: 'fail', targetType: 'user', target: user });
      return attempt.fail('Неверный пароль');
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
