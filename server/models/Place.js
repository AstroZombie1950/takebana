// Тип заведения или страна, добавленные панелью из заявок (30.09).
// Основа справочника — config/catalog.js и все страны ISO; здесь только
// то, что владельцы вписали в «Другое», а администратор решил взять в общий
// список. Справочник целиком — utils/places.js. Города (до 09.10) в базе
// остались строками kind: 'city' — справочник их не читает.
const mongoose = require('mongoose');

const PlaceSchema = new mongoose.Schema({
  kind: { type: String, enum: ['country', 'type'], required: true },
  code: { type: String, required: true },
  name: { ru: { type: String, required: true }, en: { type: String, required: true } },
}, { timestamps: { createdAt: true, updatedAt: false } });

PlaceSchema.index({ kind: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Place', PlaceSchema);
