// Заведения: заявка, карта, карточка, оценки, кабинет владельца.
// Камера заведения — routes/venueLive.js, страница карты — views/map.ejs.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
const { audit } = require('../utils/audit');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const Establishments = require('../models/Establishments');
const Rating = require('../models/Rating');
const { removeVenue } = require('../utils/userDelete');
const { readVenueFilters } = require('../utils/venueFilters');
const multer = require('multer');
const path = require('path');

// Фото заведений кладём туда же, где аватары, галерея и обложки, —
// в public/uploads. Раньше путь был 'uploads/' относительно рабочего каталога
// процесса: папка оказывалась вне public (то есть не раздавалась статикой
// напрямую), не попадала в .gitignore и уезжала, если сервер запускали не из
// server/. В базе не было ни одного заведения с фото, переносить нечего.
const ESTABLISHMENT_UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'establishments');

// Фотографии заведения идут тем же путём, что аватары и галерея: в память,
// потом через sharp на диск (utils/image.js). Прежде здесь стоял diskStorage
// вообще без проверки типа и без ограничения размера — на публично раздаваемую
// папку можно было положить файл любого вида и любого веса.
const { saveImages, BadImageError } = require('../utils/image');

const ALLOWED_PHOTO = /^image\/(jpeg|png|webp)$/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (ALLOWED_PHOTO.test(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('Только изображения JPEG, PNG или WebP.'), { status: 400, expose: true }));
  },
});

const { requireAuth, requireOwner, wrap } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const OBJECT_ID = /^[a-f\d]{24}$/i;
// Адрес фотографии заведения — только файл в своей папке: его выдаёт загрузка
// в этом же маршруте, а приходит он обратно от формы.
const PHOTO_URL = /^\/uploads\/establishments\/[\w.-]+$/;

// Часы, координаты, город и тип — в utils/venueFields.js: те же схемы
// нужны админке, и разъезжаться им нельзя.
const { HOURS, LOCATION, CITY, TYPE } = require('../utils/venueFields');

// То, что видит любой вошедший: карточка на карте и поиск. Почта, телефон
// и владелец — только самому владельцу, в /user-establishments.
const PUBLIC_FIELDS = 'name type city country address weekdayHours weekendHours location photos online';



// Заявка на заведение — страница /company-register (public/tk-company.js).
// На карту заведение попадает после проверки: status выставляет админка.
router.post('/register-establishment', requireAuth, validate({
    name: { type: 'string', required: true, max: 200, label: 'Название' },
    type: { ...TYPE, required: true },
    country: { type: 'string', required: true, max: 100, label: 'Страна' },
    city: { ...CITY, required: true },
    address: { type: 'string', required: true, max: 300, label: 'Адрес' },
    email: { type: 'email', required: true, label: 'Почта' },
    phone: { type: 'string', required: true, max: 32, label: 'Телефон' },
    weekdayHours: { ...HOURS, required: true, label: 'Часы по будням' },
    weekendHours: { ...HOURS, required: true, label: 'Часы по выходным' },
    lat: { type: 'number', min: -90, max: 90, label: 'Широта' },
    lng: { type: 'number', min: -180, max: 180, label: 'Долгота' },
}), wrap(async (req, res) => {
    const { name, type, country, city, address, email, phone, weekdayHours, weekendHours, lat, lng } = req.body;

    const establishment = new Establishments({
        name,
        type,
        country,
        city,
        address,
        email,
        phone,
        status: false,
        weekdayHours,
        weekendHours,
        location: {
            lat,
            lng
        },
        owner: req.session.userId // добавляем владельца
    });

    const savedEstablishment = await establishment.save();
    audit(req, 'venue.apply', { targetType: 'venue', target: savedEstablishment, meta: { city: savedEstablishment.city, type: savedEstablishment.type } });
    res.json({ message: 'Заявка отправлена', establishment: savedEstablishment });
}));


// Точки для карты (public/tk-venues.js) — только то, что рисуют маркер и
// строка списка. Фильтры те же, что в адресе страницы (utils/venueFilters.js).
// Раньше уходили документы целиком — с почтой, телефоном и владельцем.
router.get('/establishmentsLocation', wrap(async (req, res) => {
    const [south, west, north, east] = ['bl_lat', 'bl_lng', 'tr_lat', 'tr_lng'].map((k) => Number(req.query[k]));
    if (![south, west, north, east].every(Number.isFinite)) {
        return res.status(400).json({ message: 'Нужны границы карты: bl_lat, bl_lng, tr_lat, tr_lng' });
    }

    const filters = readVenueFilters(req.query);
    const where = {
        'location.lat': { $gte: south, $lte: north },
        'location.lng': { $gte: west, $lte: east },
        status: true, // заведение прошло проверку
    };
    if (filters.city) where.city = filters.city;
    if (filters.types.length) where.type = { $in: filters.types };
    if (filters.live) where.online = true;

    // Потолок — на случай, когда карта отдалена на всю Европу: список
    // в панели всё равно показывает только видимое.
    const establishments = await Establishments.find(where)
        .select('name type city location online photos')
        .limit(500)
        .lean();

    res.json(establishments.map(({ photos, ...e }) => ({ ...e, photos: (photos || []).slice(0, 1) })));
}));


// Карточка заведения: сведения, средняя оценка и оценка того, кто смотрит.
// Раньше это были три запроса, /getRatings отдавал оценки вместе
// с идентификаторами проголосовавших, а /getUserRating/:userId/… — чужую
// оценку по идентификатору в адресе.
// Гостю тоже: карта открыта без входа, своей оценки у него просто нет.
router.get('/api/venues/:id', wrap(async (req, res) => {
    if (!OBJECT_ID.test(req.params.id)) return res.status(404).json({ message: 'Заведение не найдено' });

    const venue = await Establishments.findOne({ _id: req.params.id, status: true }).select(PUBLIC_FIELDS).lean();
    if (!venue) return res.status(404).json({ message: 'Заведение не найдено' });

    const ratings = await Rating.find({ establishment: venue._id }).select('user rating').lean();
    const mine = req.session.userId && ratings.find((r) => String(r.user) === String(req.session.userId));
    const sum = ratings.reduce((s, r) => s + r.rating, 0);

    res.json({
        ...venue,
        rating: {
            average: ratings.length ? sum / ratings.length : 0,
            count: ratings.length,
            mine: mine ? mine.rating : null,
        },
    });
}));


// Поиск по названию для панели карты.
router.get('/searchEstablishments/:name', wrap(async (req, res) => {
    // Спецсимволы экранируются: строка вроде `(a+)+$` собирала регулярное
    // выражение с катастрофическим откатом и вешала процесс на одном запросе.
    const name = req.params.name.slice(0, 100);
    const regex = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const establishments = await Establishments.find({ name: regex, status: true })
        .select('name type city address location online')
        .limit(10)
        .lean();

    res.json(establishments);
}));


// «Мои заведения» — всё, включая неодобренные, со всеми полями: это кабинет владельца.
router.get('/user-establishments', requireAuth, wrap(async (req, res) => {
    const establishments = await Establishments.find({ owner: req.session.userId }).lean();
    res.json(establishments);
}));

// validate стоит после multer: до разбора multipart тела ещё нет.
router.put('/updateEstablishment/:id', requireAuth, requireOwner(Establishments), upload.array('newPhotos'), validate({
    name: { type: 'string', max: 200, label: 'Название' },
    type: TYPE,
    country: { type: 'string', max: 100, label: 'Страна' },
    city: CITY,
    address: { type: 'string', max: 300, label: 'Адрес' },
    email: { type: 'email', label: 'Почта' },
    phone: { type: 'string', max: 32, label: 'Телефон' },
    weekdayHours: { ...HOURS, label: 'Часы по будням' },
    weekendHours: { ...HOURS, label: 'Часы по выходным' },
    location: LOCATION,
    // Список уже загруженных фотографий, который присылает форма. Столько же,
    // сколько принимает загрузка новых, — иначе лимит в 6 обходится этим полем.
    // Только свои файлы: без образца владелец записывал в photos любую строку —
    // чужой адрес картинки, а с появлением удаления заведения ещё и путь
    // с «..», по которому удалялся бы посторонний файл.
    uploadedPhotos: { type: 'array', json: true, max: 6, default: [],
        of: { type: 'string', max: 300, pattern: PHOTO_URL }, label: 'Фотографии' },
}), wrap(async (req, res) => {

    if (req.files.length > 6) {
        req.files = req.files.slice(0, 6);
    }

    const { name, type, country, city, address, email, phone, weekdayHours, weekendHours, location, uploadedPhotos } = req.body;
    const { lat, lng } = location || {};

    // Пустое тело после разбора и означает «обновлять нечего». Три JSON.parse
    // отсюда убраны: их делает схема, и кривая строка теперь даёт 400, а не 500.
    if (!Object.keys(req.body).length) {
        return res.status(400).json({ message: 'Пожалуйста, укажите хотя бы одно поле для обновления' });
    }

    let newPhotoNames;
    try {
        newPhotoNames = await saveImages(req.files, 'establishment', ESTABLISHMENT_UPLOAD_DIR);
    } catch (e) {
        if (!(e instanceof BadImageError)) throw e;
        return res.status(400).json({ message: e.message });
    }

    const establishment = {
        name,
        type,
        country,
        city,
        address,
        email,
        phone,
        status: false,
        weekdayHours,
        weekendHours,
        location: lat !== undefined && lng !== undefined ? { lat, lng } : undefined,
        // Абсолютный URL от корня сайта. file.path раньше давал относительный
        // 'uploads/имя.jpg', и на вложенных страницах вида /userPage/:id браузер
        // искал его по /userPage/uploads/... — картинка не находилась.
        photos: uploadedPhotos.concat(newPhotoNames.map(name => `/uploads/establishments/${name}`)).slice(0, 6)
    };

    const updatedEstablishment = await Establishments.findByIdAndUpdate(req.params.id, establishment, { returnDocument: 'after' });
    audit(req, 'venue.update', { targetType: 'venue', target: updatedEstablishment, meta: { fields: Object.keys(establishment) } });
    res.json(updatedEstablishment);
}));


// Удалить заведение. Кнопка была в старой вёрстке, но ни обработчика,
// ни маршрута под ней не существовало — заведение можно было только
// перестать показывать.
//
// requireOwner пускает и администратора: в админке своя кнопка удаления,
// и логика там та же.
router.delete('/establishment/:id', requireAuth, requireOwner(Establishments), wrap(async (req, res) => {
    const venue = req.resource; // requireOwner уже нашёл документ

    // Камера, оценки и фото уходят вместе с ним: utils/userDelete.js.
    await removeVenue(venue);
    audit(req, 'venue.delete', { targetType: 'venue', target: venue, meta: { city: venue.city, byOwner: true } });
    res.json({ ok: true });
}));


// Оценка: одна от человека, повторная заменяет прежнюю.
router.post('/rateEstablishment', requireAuth, validate({
    establishmentId: { type: 'objectId', required: true, label: 'Заведение' },
    // Оценка пятибалльная: без верхней границы одним запросом ставилась
    // произвольная, и средний балл заведения уезжал куда угодно.
    rating: { type: 'int', required: true, min: 1, max: 5, label: 'Оценка' },
}), wrap(async (req, res) => {
    const { establishmentId, rating } = req.body;
    if (!(await Establishments.exists({ _id: establishmentId, status: true }))) {
        return res.status(404).json({ message: 'Заведение не найдено' });
    }

    const userRating = await Rating.findOneAndUpdate(
        { user: req.session.userId, establishment: establishmentId },
        { $set: { rating } },
        { upsert: true, returnDocument: 'after' }
    );
    audit(req, 'venue.rate', { targetType: 'venue', targetId: establishmentId, meta: { rating } });
    res.json({ rating: userRating.rating });
}));

module.exports = router;
