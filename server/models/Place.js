// Страна, город или тип заведения, добавленные панелью из заявок (30.09).
// Основа справочника — config/catalog.js; здесь только то, что владельцы
// вписали в «Другое», а администратор решил взять в общий список.
// Справочник целиком — utils/places.js.
const mongoose = require('mongoose');

const PlaceSchema = new mongoose.Schema({
  kind: { type: String, enum: ['country', 'city', 'type'], required: true },
  code: { type: String, required: true },
  name: { ru: { type: String, required: true }, en: { type: String, required: true } },
  country: String,  // у города — код страны
  center: { type: [Number], default: undefined }, // у города — [долгота, широта], с неё открывается выбор точки
}, { timestamps: { createdAt: true, updatedAt: false } });

PlaceSchema.index({ kind: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Place', PlaceSchema);
