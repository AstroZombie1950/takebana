// Приём файлов: обложки эфиров, аватары, галерея профиля.
//
// Три разных хранилища с общим фильтром типов. Пути считаются от рабочего
// каталога процесса — так было и раньше; pm2 запускает приложение из server/
// (ops/ecosystem.config.js), туда же смотрит и раздача public/.

const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

module.exports = { upload, uploadAvatar, uploadGallery };
