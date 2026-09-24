// Поддержка: официальный аккаунт, от которого уходят рассылки и приветствие
// новичкам и с которым люди переписываются, как с обычным собеседником
// (решение 24.09.2026).
//
// Аккаунт — один из администраторов, отмеченный в панели (User.support).
// Сообщения — обычная личная переписка (routes/streaming/messages.js,
// deliver): у получателя работают пуши, счётчик и история, ответить можно
// тут же. Читают и отвечают из панели — вкладка «Поддержка»
// (routes/admin/support.js), от имени этого аккаунта.
//
// Правила приватности получателя (utils/privacy.js) и ограничение доступа
// на официальный аккаунт не действуют.

const mongoose = require('mongoose');
const User = require('../models/User');
const Broadcast = require('../models/Broadcast');
const PushSubscription = require('../models/PushSubscription');
const errorLog = require('./errorLog');
const { siteUrl } = require('./site');

const SENDER = 'nickname login email avatar role supportWelcome';

function account() {
  return User.findOne({ support: true, role: 'admin' }).select(SENDER).lean();
}

// Заготовки. {site} — адрес сайта: ссылка должна вести на тот сайт, где
// человек зарегистрирован, и быть кликабельной (public/chats.js делает
// ссылки кликабельными только в сообщениях официальных аккаунтов).
const TEMPLATES = {
  welcome: {
    title: 'Приветствие',
    ru: `Здравствуйте! Это поддержка Takebana — рады, что вы с нами.

Пара шагов, чтобы всё работало как надо:
• Фото и пару слов о себе — в настройках профиля: {site}/settings
• Уведомления о сообщениях и звонках включаются на каждом устройстве отдельно: {site}/settings#pushPanel
• На телефоне добавьте Takebana на экран «Домой» — так приходят пуши, и сайт открывается как приложение.

Если что-то не работает или есть вопрос — напишите прямо сюда, в этот чат.`,
    en: `Hi! This is Takebana support — glad to have you here.

A couple of steps to get everything working:
• Add a photo and a few words about yourself in your profile settings: {site}/settings
• Message and call notifications are turned on separately on each device: {site}/settings#pushPanel
• On your phone, add Takebana to the Home Screen — that is how push notifications arrive, and the site opens like an app.

If something doesn't work or you have a question, just write here, in this chat.`,
  },
  notifications: {
    title: 'Уведомления',
    ru: `Чтобы не пропускать сообщения и звонки, включите уведомления. Это настройка браузера, а не аккаунта, — её нужно включить на каждом устройстве.

• Пуш-уведомления приходят, даже когда сайт закрыт: {site}/settings#pushPanel
• Звук сообщений и звонков, пока сайт открыт: {site}/settings#notifyPanel

Там же можно выбрать, показывать ли текст сообщения в уведомлении.`,
    en: `To never miss a message or a call, turn on notifications. This is a browser setting, not an account one, so it has to be turned on on each device.

• Push notifications arrive even when the site is closed: {site}/settings#pushPanel
• Message and call sounds while the site is open: {site}/settings#notifyPanel

There you can also choose whether to show the message text in notifications.`,
  },
  homescreen: {
    title: 'Иконка на экран «Домой»',
    ru: `Takebana можно поставить на телефон как приложение — иконкой на экране «Домой».

iPhone: откройте сайт в Safari → кнопка «Поделиться» → «На экран Домой». На iPhone пуш-уведомления работают только так.
Android: в Chrome — меню ⋮ → «Установить приложение» или «Добавить на главный экран».

Потом откройте Takebana с иконки и включите уведомления: {site}/settings#pushPanel`,
    en: `You can install Takebana on your phone like an app — as an icon on the Home Screen.

iPhone: open the site in Safari → Share button → "Add to Home Screen". On iPhone, push notifications only work this way.
Android: in Chrome, open the ⋮ menu → "Install app" or "Add to Home screen".

Then open Takebana from the icon and turn on notifications: {site}/settings#pushPanel`,
  },
  features: {
    title: 'Возможности',
    ru: `Коротко о том, что умеет Takebana:

• Эфиры — с телефона, из браузера или из OBS: {site}/studio
• Переписка — фото, видео, голосовые и кружки, сообщения на один просмотр или с таймером: {site}/chatsPage
• Группы до 100 человек и ссылки-приглашения
• Звонки — аудио и видео, в группе до четырёх человек
• Контакты — своя записная книжка
• Видео в профиль: {site}/upload

Вопросы — пишите сюда.`,
    en: `A quick look at what Takebana can do:

• Live streams — from your phone, browser or OBS: {site}/studio
• Messages — photos, videos, voice and video notes, view-once and timed messages: {site}/chatsPage
• Groups of up to 100 people with invite links
• Calls — audio and video, up to four people in a group
• Contacts — your own address book
• Videos on your profile: {site}/upload

Questions? Write here.`,
  },
  privacy: {
    title: 'Приватность',
    ru: `В настройках появился раздел «Приватность»: {site}/settings#privacyPanel

Там можно выбрать, кто может вам писать, звонить и добавлять в группы, кто видит, что вы в сети, кто может комментировать ваши записи и видео и показывать ли вас в поиске. Сообщения от незнакомых можно собирать в отдельную папку «Заявки» — без звука и уведомлений.`,
    en: `There is a new Privacy section in your settings: {site}/settings#privacyPanel

Choose who can message you, call you and add you to groups, who sees when you are online, who can comment on your recordings and videos, and whether you appear in search. Messages from strangers can go to a separate Requests folder — no sound, no notifications.`,
  },
};

const fill = (text) => text.replace(/\{site\}/g, siteUrl(''));

// Заготовки для панели — с подставленным адресом, как их получит человек.
function templates() {
  return Object.entries(TEMPLATES).map(([key, t]) => ({ key, title: t.title, ru: fill(t.ru), en: fill(t.en) }));
}

// Отправка — через доставку личной переписки. Модуль маршрутов тянется
// лениво: он сам подключает многое из utils/.
function messages() {
  return require('../routes/streaming/messages');
}

// Одно сообщение от поддержки человеку. Приватность и ограничения мимо:
// заявкой такая переписка тоже не становится.
async function send(req, sender, recipient, content, { push = true } = {}) {
  const { openConversation, deliver } = messages();
  const conversation = await openConversation(sender._id, recipient._id);
  if (conversation.requestFor) conversation.requestFor = undefined;
  return deliver(req, { conversation, sender, recipient, content, silent: !push });
}

// Приветствие новичку сразу после регистрации — если в панели включено.
// Ничего не ждёт и ничего не роняет: регистрация важнее письма.
function welcome(req, user, lang) {
  account()
    .then((sender) => {
      if (!sender || !sender.supportWelcome) return null;
      const t = TEMPLATES.welcome;
      return send(req, sender, user, fill(lang === 'en' ? t.en : t.ru));
    })
    .catch((e) => errorLog.server(e, 'support.welcome'));
}

// Кому уходит рассылка — условие выборки. Бан не повод молчать про
// уведомления, но забаненному писать незачем: он всё равно не ответит.
async function audienceWhere(kind, days, me, senderId) {
  if (kind === 'self') return { _id: me };
  const where = { _id: { $ne: senderId }, banned: { $ne: true } };
  if (kind === 'recent') {
    const from = mongoose.Types.ObjectId.createFromTime(Math.floor((Date.now() - days * 86400000) / 1000));
    where._id = { $ne: senderId, $gte: from };
  }
  if (kind === 'nopush') {
    where._id = { $ne: senderId, $nin: await PushSubscription.distinct('user') };
  }
  return where;
}

async function audienceCount(kind, days, me, senderId) {
  return User.countDocuments(await audienceWhere(kind, days, me, senderId));
}

// Рассылка идёт в фоне по одному человеку: у каждого своя переписка,
// сокет и пуш. Пачками с паузой — чтобы не забрать базу у живых запросов.
const BATCH = 25;
const PAUSE_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(req, doc, sender) {
  const where = await audienceWhere(doc.audience.kind, doc.audience.days, doc.by, sender._id);
  const cursor = User.find(where).select('nickname login email avatar lang').lean().cursor({ batchSize: BATCH });
  let sent = 0;
  let failed = 0;
  let n = 0;
  for await (const user of cursor) {
    const text = user.lang === 'en' && doc.text.en ? doc.text.en : doc.text.ru || doc.text.en;
    try {
      await send(req, sender, user, text, { push: doc.push });
      sent++;
    } catch (e) {
      failed++;
      errorLog.server(e, 'support.broadcast');
    }
    if (++n % BATCH === 0) {
      await Broadcast.updateOne({ _id: doc._id }, { $set: { sent, failed } });
      await sleep(PAUSE_MS);
    }
  }
  await Broadcast.updateOne({ _id: doc._id }, { $set: { sent, failed, status: 'done', finishedAt: new Date() } });
}

// Запустить рассылку: запись в истории сразу, отправка — в фоне.
async function broadcast(req, sender, { by, template, text, audience, push }) {
  const total = await audienceCount(audience.kind, audience.days, by, sender._id);
  const doc = await Broadcast.create({ by, sender: sender._id, template, text, audience, push, total });
  run(req, doc, sender).catch((e) => {
    errorLog.server(e, 'support.broadcast');
    Broadcast.updateOne({ _id: doc._id }, { $set: { status: 'stopped', finishedAt: new Date() } }).catch(() => {});
  });
  return doc;
}

// Рассылка, которую оборвал перезапуск процесса, так и числилась бы идущей.
function markInterrupted() {
  return Broadcast.updateMany({ status: 'running' }, { $set: { status: 'stopped', finishedAt: new Date() } });
}

module.exports = { account, templates, send, welcome, broadcast, audienceCount, markInterrupted };
