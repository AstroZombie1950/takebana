const mongoose = require('mongoose');

const EstablishmentsSchema = new mongoose.Schema({
    name: String, // название
    country: String, // страна
    city: String, // город
    address: String, // адрес
    email: String, // email
    phone: String, // номер телефона
    status: Boolean, // status тру или фолс
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
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    photos: [String], // массив ссылок на фотографии
    online: Boolean // камера заведения включена (routes/venueLive.js)
});

// Заведения владельца — личный кабинет
EstablishmentsSchema.index({ owner: 1 });
// Выборка точек в границах карты идёт с фильтром по статусу
EstablishmentsSchema.index({ status: 1, 'location.lat': 1, 'location.lng': 1 });

module.exports = mongoose.model('Establishments', EstablishmentsSchema);
