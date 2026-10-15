// Приём файлов: обложки эфиров, аватары, галерея профиля, вложения переписки.
//
// Файл приходит в память и уходит на диск уже обработанным — сжатым,
// подогнанным по размеру и без EXIF (utils/image.js). Прежде здесь стояли
// три multer.diskStorage, и присланное ложилось на диск байт в байт.
//
// Память, а не диск, по двум причинам: обрабатывать всё равно нужно из буфера,
// а файл, не прошедший обработку, не остаётся на диске мусором. Размеры тут
// небольшие — лимиты ниже, и до памяти доходит только то, что их прошло.
//
// Папка — от расположения файла, а не от рабочего каталога: маршруты, которые
// удаляют файлы, считают путь так же (UPLOADS), и раньше они промахивались
// мимо папки — удалённое из галереи оставалось на диске.

const multer = require('multer');
const os = require('os');
const path = require('path');
const limits = require('../../utils/limits');

const UPLOADS = path.join(__dirname, '..', '..', 'public', 'uploads');

// webp принимаем наравне с jpeg и png: его отдаёт «Поделиться» на телефонах
// и большинство редакторов, а раньше такая загрузка просто отваливалась.
// heic (снимок с айфона) пока нет: в готовых сборках sharp его поддержки нет,
// нужна отдельная libheif — см. temp/backlog-2026-09-17.md.
const ALLOWED = /^image\/(jpeg|png|webp)$/;

// status и expose — для middleware/errors.js: не тот формат файла это 400
// с внятным текстом, а не безымянная пятисотка в журнале ошибок.
const badType = () => Object.assign(new Error('Только изображения JPEG, PNG или WebP.'), { status: 400, expose: true });

const fileFilter = (req, file, cb) => {
  if (ALLOWED.test(file.mimetype)) return cb(null, true);
  cb(badType());
};

// Лимит — на присланное, не на сохранённое: после обработки файл в разы легче.
const inMemory = (mb) => multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: mb * 1024 * 1024 },
  fileFilter,
});

const upload = inMemory(5);         // обложки эфиров
const uploadAvatar = inMemory(5);
const uploadCover = inMemory(10);   // своя обложка видео

// Предел веса фото галереи и вложений — свой у человека (utils/limits.js,
// с 15.10; было 10 МБ и 200 МБ): multer собирается на запрос, одинаковые
// пределы — один экземпляр.
const built = new Map();
const once = (key, make) => built.get(key) || built.set(key, make()).get(key);
async function galleryUpload(req) {
  const lim = await limits.forUser(req.session.userId);
  return once('g' + lim.galleryPhotoMb, () => inMemory(lim.galleryPhotoMb));
}
// Готовый обработчик: galleryPhotos((m) => m.array('photos', 10)).
const galleryPhotos = (use) => async (req, res, next) => {
  try { use(await galleryUpload(req))(req, res, next); } catch (e) { next(e); }
};

// Большое в память не берём: файл ложится во временную папку.
const toTmp = multer.diskStorage({ destination: os.tmpdir(), filename: (req, file, cb) => cb(null, 'tk-upload-' + Date.now() + '-' + Math.random().toString(36).slice(2)) });

// Вложения переписки — на диск: видео до 200 МБ. Тип здесь не
// проверяется — присланному браузером типу верить нельзя; вид, предел
// и содержимое проверяет utils/attachments.js, он же удаляет файл.
// Предел multer — наибольший из пределов отправителя; точный по виду
// проверяет utils/attachments.js. Лимиты — в req.attachLimits.
async function uploadAttachment(req, res, next) {
  try {
    const lim = await limits.forUser(req.session.userId);
    req.attachLimits = lim;
    const mb = limits.chatMaxMb(lim);
    once('a' + mb, () => multer({ storage: toTmp, limits: { fileSize: mb * 1024 * 1024, files: 1, fields: 8 } }).single('file'))(req, res, next);
  } catch (e) {
    next(e);
  }
}

module.exports = { UPLOADS, upload, uploadAvatar, uploadCover, galleryUpload, galleryPhotos, uploadAttachment };
