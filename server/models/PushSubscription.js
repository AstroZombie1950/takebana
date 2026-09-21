// Подписка устройства на пуш-уведомления (utils/push.js).
//
// Одна запись — одно устройство: телефон, рабочий ноутбук, домашний. Адрес
// (endpoint) выдаёт пуш-сервис производителя браузера, и принадлежит он
// устройству, а не человеку. Поэтому уникальность по endpoint, а не по паре
// с user: сменился аккаунт на том же телефоне — запись переписывается,
// а не заводится вторая, иначе уведомления первого поедут второму.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const pushSubscriptionSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  endpoint: { type: String, required: true, unique: true },
  // Ключи шифрования устройства: ими web-push шифрует полезную нагрузку,
  // так что пуш-сервис содержимого не видит.
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
  // Показывать ли текст сообщения в уведомлении. Настройка устройства, а не
  // аккаунта: телефон в кармане и ноутбук на общем столе — разные истории.
  // Решает сервер, он и собирает уведомление, поэтому значение живёт здесь,
  // а не в localStorage, как три звуковых тумблера (public/tk-notify.js).
  preview: { type: Boolean, default: false },
  // Пуши об эфирах авторов, на которых человек подписан. Отдельно от личных:
  // отказаться от рассылки про эфиры можно, не теряя сообщений и звонков.
  live: { type: Boolean, default: true },
  // Язык уведомления. Текст собирается для спящего устройства, запроса
  // с cookie `lang` рядом нет — запоминаем язык в момент подписки.
  lang: { type: String, enum: ['ru', 'en'], default: 'ru' },
  // Чтобы человек узнал своё устройство в списке, а мы — по какому браузеру
  // пришёл отказ.
  ua: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  // Когда сюда последний раз дошло. По нему убираем подписки устройств,
  // которые молча исчезли, не прислав 410.
  lastOkAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
