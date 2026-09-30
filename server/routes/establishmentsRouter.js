// Заведения: раздел /venues (список и карта), заявка, оценки, страница
// заведения, кабинет владельца. Камера заведения — routes/venueLive.js.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
const { audit } = require('../utils/audit');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос

const Establishments = require('../models/Establishments');
const Rating = require('../models/Rating');
const gallery = require('../utils/gallery');
const { removeVenue, unlinkUpload } = require('../utils/userDelete');
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
const MAX_PHOTOS = 6;

// Файлов — не больше, чем фото у заведения: всё прочитанное multer держит
// в памяти, и сотня файлов по 10 МБ перезапускала процесс вместе с эфирами.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: MAX_PHOTOS },
  fileFilter(req, file, cb) {
    if (ALLOWED_PHOTO.test(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('Только изображения JPEG, PNG или WebP.'), { status: 400, expose: true }));
  },
});

const { requireAuth, requireOwner, wrap } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

// Адрес фотографии заведения — только файл в своей папке: его выдаёт загрузка
// в этом же маршруте, а приходит он обратно от формы.
const PHOTO_URL = /^\/uploads\/establishments\/[\w.-]+$/;

// Часы, координаты, тип, страна и город — в utils/venueFields.js: те же
// схемы нужны админке, и разъезжаться им нельзя. Тип, страну и город сверяет
// справочник (utils/places.js).
const { HOURS, LOCATION, PLACE, ABOUT_MAX, DRAFT_FIELDS, dropDraft } = require('../utils/venueFields');
const places = require('../utils/places');
const { commonDataMiddleware } = require('./streaming/shared');

const { venuesWhere, escapeRegex } = require('../utils/search');
const { hoursState, zoneAt } = require('../utils/venueHours');
const venueRating = require('../utils/venueRating');
const { applyState, stateOf } = require('../utils/venueOwner');
const { pageVenue, tabsFor, indexableVenue } = require('../utils/venuePage');

// Что нужно карточке выдачи /venues. Почты, телефона и владельца в ней нет.
const CARD_FIELDS = 'name type typeOther city cityOther address about weekdayHours weekendHours tz location photos avatar cover online ratingAvg ratingCount';



// ── Раздел «Заведения» /venues (29.09) ───────────────────────────────────────
// Прежде — «Карта заведений» /map: узкая панель, поиск выпадашкой на десять
// названий и строки без фото. Теперь карточки (фото, оценка, часы, описание)
// и карта рядом, поиск фильтрует сам список (docs/VENUES.md, вариант Б).
//
// Карточки рисует сервер — и в странице, и фрагментом /venues/cards, когда
// меняются фильтры: шаблон один (views/partials/venueCard.ejs), а поиск видит
// список заведений без скрипта. Скрипт (public/tk-venues.js) берёт из карточек
// точки для карты и прячет те, что вне видимой её части.

// Сколько карточек за раз. Одобренных заведений пока десятки; когда
// перевалит за этот предел, нужна будет подгрузка страницами.
const LIST_LIMIT = 300;

const SORT = {
    live: { online: -1, ratingAvg: -1, name: 1 },
    rate: { ratingAvg: -1, ratingCount: -1, name: 1 },
    name: { name: 1 },
};

async function listVenues(f) {
    const where = f.q ? venuesWhere(new RegExp(escapeRegex(f.q), 'i')) : { status: true };
    // Код города однозначен сам по себе — страна при нём ничего не сужает.
    if (f.city) where.city = f.city;
    else if (f.country) where.country = f.country;
    if (f.types.length) where.type = { $in: f.types };
    if (f.live) where.online = true;
    const venues = await Establishments.find(where).select(CARD_FIELDS).sort(SORT[f.sort]).limit(LIST_LIMIT).lean();
    // «Открыто сейчас» — по часам и местному времени заведения, в базе его нет.
    const now = new Date();
    for (const v of venues) v.hours = hoursState(v, now);
    return f.open ? venues.filter((v) => v.hours && v.hours.open) : venues;
}

// Каркас кабинета, поэтому commonDataMiddleware: шапке и левой панели нужны
// профиль, подписки и уведомления. Открыт и гостю.
// Страны и города в фильтре — только те, где есть одобренные заведения:
// пустой пункт ведёт в пустую выдачу. Своё владельцев («Другое») в фильтр
// не попадает, пока панель не возьмёт его в список (utils/places.js).
async function filterPlaces(lang) {
    const [countries, cities] = await Promise.all([
        Establishments.distinct('country', { status: true }),
        Establishments.distinct('city', { status: true }),
    ]);
    const has = (list) => (x) => list.includes(x.code);
    return {
        countries: places.options('country', lang).filter(has(countries)),
        cities: places.options('city', lang).filter(has(cities)),
    };
}

router.get('/venues', commonDataMiddleware, wrap(async (req, res) => {
    const filters = readVenueFilters(req.query);
    const [venues, where] = await Promise.all([listVenues(filters), filterPlaces(res.locals.lang)]);
    res.render('venues', { filters, venues, where });
}));

// Карточки под новые фильтры — тот же шаблон, что в странице.
router.get('/venues/cards', wrap(async (req, res) => {
    const venues = await listVenues(readVenueFilters(req.query));
    res.set('X-Robots-Tag', 'noindex');
    res.render('partials/venueCards', { venues });
}));

// «Мои заведения» (29.09): все свои — и одобренные, и на проверке, — ссылками
// на их страницы, и можно ли подать ещё одну заявку. В левой панели пункт
// ведёт сюда, когда заведений больше одного (routes/streaming/shared.js).
router.get('/venues/mine', requireAuth, commonDataMiddleware, wrap(async (req, res) => {
    const [venues, apply] = await Promise.all([
        Establishments.find({ owner: req.session.userId })
            .select('name type typeOther city cityOther status reviewedAt online avatar pending.at').sort({ _id: 1 }).lean(),
        applyState(req.session.userId),
    ]);
    res.render('myVenues', { venues: venues.map((v) => ({ ...v, state: stateOf(v) })), apply });
}));

// Прежние адреса раздела: /map (до 29.09) и /main (до 15.09). Ими делились
// ссылками на заведения (?venue=) — запрос переезжает вместе с адресом.
router.get(['/map', '/main'], (req, res) => {
    const qs = req.originalUrl.indexOf('?');
    res.redirect(301, '/venues' + (qs === -1 ? '' : req.originalUrl.slice(qs)));
});


// Заявка на заведение — страница /company-register (public/tk-company.js).
// На карту заведение попадает после проверки: status выставляет админка.
router.post('/register-establishment', requireAuth, validate({
    name: { type: 'string', required: true, max: 200, label: 'Название' },
    ...PLACE,
    address: { type: 'string', required: true, max: 300, label: 'Адрес' },
    email: { type: 'email', required: true, label: 'Почта' },
    phone: { type: 'string', required: true, max: 32, label: 'Телефон' },
    weekdayHours: { ...HOURS, required: true, label: 'Часы по будням' },
    weekendHours: { ...HOURS, required: true, label: 'Часы по выходным' },
    lat: { type: 'number', min: -90, max: 90, label: 'Широта' },
    lng: { type: 'number', min: -180, max: 180, label: 'Долгота' },
}), wrap(async (req, res) => {
    // Пределы (docs/VENUES.md, п. 6): заявка на проверке — одна за раз,
    // заведений — не больше MAX_VENUES. Страница заявки о них предупреждает
    // сама; здесь — на случай второй вкладки и прямого запроса.
    const apply = await applyState(req.session.userId);
    if (apply.waiting) return res.status(409).json({ message: 'Заявка уже на проверке: следующую можно подать после решения по ней' });
    if (apply.full) return res.status(409).json({ message: 'Достигнут предел заведений на одного человека' });

    const place = places.pick(req.body);
    if (place.error) return res.status(400).json({ message: place.error });

    const { name, address, email, phone, weekdayHours, weekendHours, lat, lng } = req.body;

    const establishment = new Establishments({
        name,
        ...place.fields,
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
        tz: zoneAt({ lat, lng }) || undefined,
        owner: req.session.userId // добавляем владельца
    });

    const savedEstablishment = await establishment.save();
    audit(req, 'venue.apply', { targetType: 'venue', target: savedEstablishment, meta: { country: savedEstablishment.country || savedEstablishment.countryOther, city: savedEstablishment.city || savedEstablishment.cityOther, type: savedEstablishment.type || savedEstablishment.typeOther } });
    res.json({ message: 'Заявка отправлена', establishment: savedEstablishment });
}));


// Точки для карты на «О нас» (public/tk-landing.js) — только то, что рисует
// маркер. Раздел /venues берёт точки из своих карточек (data-lat, data-lng).
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
        .select('name type city location online photos avatar')
        .limit(500)
        .lean();

    // Значок точки и строки списка — логотип, без него первое фото.
    res.json(establishments.map(({ photos, avatar, ...e }) => ({ ...e, photos: avatar ? [avatar] : (photos || []).slice(0, 1) })));
}));


// Правка заведения — со страницы /venue/:id/edit (public/tk-venue-edit.js).
// validate стоит после multer: до разбора multipart тела ещё нет.
//
// Заведение ещё не одобрено — правка ложится сразу, проверять всё равно
// будут целиком. Одобренное — правка уходит черновиком (pending) и ждёт
// панели, а на карте до тех пор остаётся прежнее (решение 29.09). До этого
// любая правка ставила status: false, и заведение пропадало с карты, пока
// его не одобрят заново. Правку администратора не проверяет никто.
router.put('/updateEstablishment/:id', requireAuth, requireOwner(Establishments), upload.array('newPhotos', MAX_PHOTOS), validate({
    name: { type: 'string', max: 200, label: 'Название' },
    ...PLACE,
    address: { type: 'string', max: 300, label: 'Адрес' },
    about: { type: 'string', max: ABOUT_MAX, label: 'Описание' },
    weekdayHours: { ...HOURS, label: 'Часы по будням' },
    weekendHours: { ...HOURS, label: 'Часы по выходным' },
    location: LOCATION,
    // Список уже загруженных фотографий, который присылает форма. Столько же,
    // сколько принимает загрузка новых, — иначе лимит в 6 обходится этим полем.
    // Только свои файлы: без образца владелец записывал в photos любую строку —
    // чужой адрес картинки, а с появлением удаления заведения ещё и путь
    // с «..», по которому удалялся бы посторонний файл.
    uploadedPhotos: { type: 'array', json: true, max: MAX_PHOTOS, default: [],
        of: { type: 'string', max: 300, pattern: PHOTO_URL }, label: 'Фотографии' },
}), wrap(async (req, res) => {
    const venue = req.resource; // requireOwner уже нашёл документ
    const draft = !!venue.status && String(venue.owner) === String(req.session.userId);
    const before = venue.pending && venue.pending.at ? venue.pending : null;

    // Оставляем только фото этого заведения — одобренные и из прежнего
    // черновика: образец пути пропускал и файл чужого, а при удалении своего
    // заведения он стирался. Новых — сколько осталось места, до записи на
    // диск, а не после.
    const live = new Set(venue.photos || []);
    const had = new Set([...live, ...((before && before.photos) || [])]);
    const kept = [...new Set(req.body.uploadedPhotos)].filter((u) => had.has(u));
    const files = req.files.slice(0, MAX_PHOTOS - kept.length);

    const { name, address, about, weekdayHours, weekendHours, location } = req.body;
    const { lat, lng } = location || {};

    // Тип, страна и город приходят тройкой — форма шлёт их всегда. Нет ни
    // одного — не трогаем.
    let place = {};
    if (places.KINDS.some((k) => req.body[k] !== undefined || req.body[k + 'Other'] !== undefined)) {
        const picked = places.pick(req.body);
        if (picked.error) return res.status(400).json({ message: picked.error });
        place = picked.fields;
    }

    // Пустое тело после разбора и означает «обновлять нечего». Три JSON.parse
    // отсюда убраны: их делает схема, и кривая строка теперь даёт 400, а не 500.
    if (!Object.keys(req.body).length) {
        return res.status(400).json({ message: 'Пожалуйста, укажите хотя бы одно поле для обновления' });
    }

    let newPhotoNames;
    try {
        newPhotoNames = await saveImages(files, 'establishment', ESTABLISHMENT_UPLOAD_DIR);
    } catch (e) {
        if (!(e instanceof BadImageError)) throw e;
        return res.status(400).json({ message: e.message });
    }

    const fields = {
        name,
        ...place,
        address,
        about,
        weekdayHours,
        weekendHours,
        location: lat !== undefined && lng !== undefined ? { lat, lng } : undefined,
        // Абсолютный URL от корня сайта. file.path раньше давал относительный
        // 'uploads/имя.jpg', и на вложенных страницах вида /userPage/:id браузер
        // искал его по /userPage/uploads/... — картинка не находилась.
        photos: kept.concat(newPhotoNames.map(name => `/uploads/establishments/${name}`))
    };

    let updated;
    if (draft) {
        // Незаполненное в черновике — как у одобренного: иначе принятая
        // правка стёрла бы поле, которое человек и не трогал.
        const plain = venue.toObject();
        const pending = { at: new Date() };
        for (const [k, v] of Object.entries(fields)) pending[k] = v === undefined ? plain[k] : v;
        updated = await Establishments.findByIdAndUpdate(venue._id, { $set: { pending } }, { returnDocument: 'after' });
        // Из прежнего черновика ушли — с диска, если их нет и среди одобренных.
        for (const url of (before && before.photos) || []) {
            if (!live.has(url) && !fields.photos.includes(url)) unlinkUpload(url, 'establishments');
        }
        audit(req, 'venue.pending', { targetType: 'venue', target: updated, meta: { fields: Object.keys(fields).filter((k) => fields[k] !== undefined) } });
    } else {
        // Точка переехала — пояс за ней (utils/venueHours.js). У черновика
        // пояс ставит принятие правки (utils/venueFields.js, applyDraft).
        if (fields.location && zoneAt(fields.location)) fields.tz = zoneAt(fields.location);
        updated = await Establishments.findByIdAndUpdate(venue._id, fields, { returnDocument: 'after' });
        // Убранные из списка — с диска, иначе они оставались сиротами.
        for (const url of had) if (!fields.photos.includes(url)) unlinkUpload(url, 'establishments');
        audit(req, 'venue.update', { targetType: 'venue', target: updated, meta: { fields: Object.keys(fields) } });
    }
    res.json({ ok: true, pending: draft });
}));

// Отозвать правку, которая ещё ждёт проверки: черновик уходит, новые фото
// из него — с диска.
router.delete('/updateEstablishment/:id', requireAuth, requireOwner(Establishments), wrap(async (req, res) => {
    const venue = req.resource;
    if (!venue.pending || !venue.pending.at) return res.json({ ok: true });
    dropDraft(venue);
    await Establishments.updateOne({ _id: venue._id }, { $unset: { pending: 1 } });
    res.json({ ok: true });
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
    const venue = await Establishments.findOne({ _id: establishmentId, status: true }).select('owner').lean();
    if (!venue) return res.status(404).json({ message: 'Заведение не найдено' });
    // Своё заведение не оценить (30.09): средняя — мнение гостей.
    if (String(venue.owner) === String(req.session.userId)) {
        return res.status(403).json({ message: 'Своё заведение оценить нельзя' });
    }

    await Rating.updateOne(
        { user: req.session.userId, establishment: establishmentId },
        { $set: { rating } },
        { upsert: true }
    );
    await venueRating.recount(establishmentId);
    const { ratingAvg, ratingCount } = await Establishments.findById(establishmentId).select('ratingAvg ratingCount').lean();
    audit(req, 'venue.rate', { targetType: 'venue', targetId: establishmentId, meta: { rating } });
    // Новая средняя — странице заведения, чтобы не перезагружаться.
    res.json({ rating, average: ratingAvg, count: ratingCount });
}));

// ── Страница заведения (29.09) ───────────────────────────────────────────────
// До неё у заведения была только карточка поверх карты и страница камеры,
// а у владельца — окно «Мои заведения» на карте: где править, как запустить
// камеру, что сейчас на проверке — не понять. Теперь /venue/:id — профиль:
// гостю сведения, фото, оценка и камера, владельцу ещё и пульт — камера,
// правка, удаление, состояние проверки. Правка — /venue/:id/edit.
//
// Заведение на проверке видно только владельцу (и администратору) — как
// на карте. Кто смотрит и какие вкладки — utils/venuePage.js: это общее
// с видео-меню (routes/venueMenu.js).

router.get('/venue/:venueId', commonDataMiddleware, wrap(async (req, res, next) => {
    const found = await pageVenue(req, res);
    if (!found) return next();
    const { venue, own, admin } = found;
    // Средняя — в самом заведении (utils/venueRating.js); своя — чтобы
    // звёзды голосования показали, что уже поставлено.
    const mine = req.session.userId
        ? await Rating.findOne({ user: req.session.userId, establishment: venue._id }).select('rating').lean()
        : null;
    res.render('venue', {
        venue,
        own,
        manage: own || admin,
        tabs: await tabsFor(venue, own || admin),
        // Часы на сегодня — по местному дню недели заведения, как в карточках выдачи.
        hours: hoursState(venue),
        rating: { average: venue.ratingAvg || 0, count: venue.ratingCount || 0, mine: mine ? mine.rating : 0 },
    });
}));

router.get('/venue/:venueId/edit', requireAuth, commonDataMiddleware, wrap(async (req, res, next) => {
    const found = await pageVenue(req, res);
    if (!found || !(found.own || found.admin)) return next();
    const { venue } = found;
    // В форму — черновик, если правка ещё ждёт проверки: человек продолжает
    // её, а не начинает заново с одобренного.
    const draft = venue.pending && venue.pending.at ? venue.pending : null;
    res.render('venueEdit', {
        venue,
        form: draft ? { ...venue, ...Object.fromEntries(DRAFT_FIELDS.filter((k) => draft[k] != null).map((k) => [k, draft[k]])) } : venue,
        draftAt: draft ? draft.at : null,
        maxPhotos: MAX_PHOTOS,
        aboutMax: ABOUT_MAX,
    });
}));

// «Эфиры» и «Видео» заведения (29.09, docs/VENUES.md п. 9): записи эфиров
// и видео, снятые от его имени, по PAGE на страницу. Владельцу видно и
// незаконченное (склеивается, грузится) и кнопки «Начать эфир» и
// «Загрузить видео». Нечего показать — вкладки нет, адрес — 404.
router.get(['/venue/:venueId/streams', '/venue/:venueId/videos'], commonDataMiddleware, wrap(async (req, res, next) => {
    const found = await pageVenue(req, res);
    if (!found) return next();
    const { venue, own, admin } = found;
    const manage = own || admin;
    const tab = req.path.endsWith('/videos') ? 'videos' : 'streams';
    const tabs = await tabsFor(venue, manage);
    if (!tabs[tab]) return next();

    const owner = { venue: venue._id };
    const total = tab === 'streams'
        ? await gallery.recordingsCount(owner, manage)
        : (await gallery.counts(owner, manage)).videosListed;
    const pg = gallery.page(total, Number(req.query.page) || 1);
    const range = { skip: pg.skip, limit: gallery.PAGE };
    const items = tab === 'streams' ? await gallery.recordings(owner, manage, range) : await gallery.videos(owner, manage, range);
    res.render('venueTab', {
        venue, manage, tab, tabs, items, total, page: pg.page, pages: pg.pages,
        // В индекс — как сама страница заведения (с описанием), и если есть что смотреть.
        indexable: indexableVenue(venue) && items.some((x) => x.status === 'ready'),
        canPost: own && venue.status === true,
    });
}));

// Вкладка «Настройки» (29.09) держала одно видео-меню — с 30.09 её
// выключатель на странице правки, она и называется «Настройки».
router.get('/venue/:venueId/settings', (req, res) => res.redirect(301, '/venue/' + encodeURIComponent(req.params.venueId) + '/edit'));

// Выключатели настроек заведения (видео-меню) на странице /venue/:id/edit:
// свои у каждого, меняются сразу, без проверки — как логотип.
// Одна настройка за запрос — так их шлёт переключатель страницы. Пустое тело
// ничего не меняет и не ошибка.
// requireOwner пускает владельца и администратора, как у правки.
router.put('/venue/:id/settings', requireAuth, requireOwner(Establishments), validate({
    videoMenu: { type: 'bool', label: 'Видео-меню' },
}), wrap(async (req, res) => {
    const venue = req.resource;
    const set = {};
    if (req.body.videoMenu !== undefined) set['features.videoMenu'] = req.body.videoMenu;
    if (!Object.keys(set).length) return res.json({ ok: true });
    await Establishments.updateOne({ _id: venue._id }, { $set: set });
    audit(req, 'venue.settings', { targetType: 'venue', target: venue, meta: set });
    res.json({ ok: true });
}));

module.exports = router;
