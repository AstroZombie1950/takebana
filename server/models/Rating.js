const mongoose = require('mongoose');

const RatingSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // ссылка на пользователя
    establishment: { type: mongoose.Schema.Types.ObjectId, ref: 'Establishments' }, // ссылка на заведение
    rating: { type: Number, min: 1, max: 5 } // оценка от 1 до 5
});

module.exports = mongoose.model('Rating', RatingSchema);