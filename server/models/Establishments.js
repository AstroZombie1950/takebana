const mongoose = require('mongoose');

const EstablishmentsSchema = new mongoose.Schema({
    name: String, // название
    // Тип, страна и город — коды справочника (utils/places.js), по ним
    // фильтрует раздел /venues. Чего в справочнике нет, владелец вписывает
    // сам (30.09): тогда код пустой, а текст — в *Other, пока панель не
    // возьмёт его в общий список.
    type: String,
    typeOther: String,
    country: String,
    countryOther: String,
    city: String,
    cityOther: String,
    address: String, // адрес
    email: String, // email
    phone: String, // номер телефона
    status: Boolean, // status тру или фолс
    // Когда панель последний раз меняла status (29.09). status: false без
    // этой отметки — заявка, которую ещё не рассматривали: такая у человека
    // может быть только одна (utils/venueOwner.js). С отметкой — одобренное,
    // которое панель потом скрыла: новой заявке оно не мешает.
    reviewedAt: Date,
    // Настройки заведения — свои у каждого, меняет владелец сразу, без
    // проверки (/venue/:id/settings, 29.09).
    features: {
        videoMenu: { type: Boolean, default: false }, // видео-меню (docs/VENUES.md, п. 10)
    },
    weekdayHours: { // время работы в будни с и до
        open: String,
        close: String
    },
    weekendHours: { // время работы в выходные с и до
        open: String,
        close: String
    },
    location: { // координаты
        lat: Number, // широта
        lng: Number // долгота
    },
    // Часовой пояс по точке (30.09): часы работы — местные, и «открыто
    // сейчас» считается по ним, где бы ни был посетитель (utils/venueHours.js).
    tz: String,
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    photos: [String], // массив ссылок на фотографии
    // Обложка камеры (28.09): заставка страницы /venue/:id/live, пока нет
    // картинки, и превью ссылки. /uploads/thumbnails/…, ставит владелец.
    cover: String,
    // Логотип (29.09): круглый значок на карте, в списке и на странице
    // заведения. /uploads/avatars/…, ставит владелец сразу, без проверки —
    // как обложку камеры и аватар человека.
    avatar: String,
    // Описание для страницы заведения /venue/:id (29.09).
    about: String,
    online: Boolean, // камера заведения включена (routes/venueLive.js)
    // Средняя оценка и число оценок (29.09) — для карточек выдачи /venues:
    // считать их по Rating на каждую карточку дорого. Пересчитывает
    // utils/venueRating.js — при оценке и при удалении того, кто оценивал.
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    // Правка одобренного заведения ждёт проверки (29.09). До того правка
    // снимала заведение с карты целиком (status: false) до повторного
    // одобрения. Теперь на карте остаётся одобренное, а правка лежит здесь,
    // пока панель её не примет (поля переезжают наверх) или не отклонит.
    // Фото в черновике — полный новый список: новые файлы уже на диске,
    // отклонение их убирает.
    pending: {
        at: Date,
        name: String,
        // Объектом: голое `type: String` Mongoose принял бы за тип всего pending.
        type: { type: String },
        typeOther: String,
        country: String,
        countryOther: String,
        city: String,
        cityOther: String,
        address: String,
        about: String,
        weekdayHours: { open: String, close: String },
        weekendHours: { open: String, close: String },
        location: { lat: Number, lng: Number },
        photos: { type: [String], default: undefined },
    },
});

// Правки на проверке — вкладка панели «Заведения», фильтр «Правки».
EstablishmentsSchema.index({ 'pending.at': 1 }, { sparse: true });

// Заведения владельца — личный кабинет
EstablishmentsSchema.index({ owner: 1 });
// Выборка точек в границах карты идёт с фильтром по статусу
EstablishmentsSchema.index({ status: 1, 'location.lat': 1, 'location.lng': 1 });

module.exports = mongoose.model('Establishments', EstablishmentsSchema);
