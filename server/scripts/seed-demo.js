// Демонстрационные данные для локальной разработки: пользователи, заведения, эфиры.
// Нужны, чтобы было что открывать в браузере — база после переезда будет пустой.
//
//   node scripts/seed-demo.js           # досоздать недостающее
//   node scripts/seed-demo.js --reset   # сначала удалить прежние демо-записи
//
// Все записи помечены признаком demo в поле email/title, чтобы --reset
// не задел ничего постороннего. На проде запускать не нужно.

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
// crypto.randomUUID() встроен в Node и даёт тот же формат, что uuid v4.
// Пакет uuid убран: использовался только ради v4, а его advisory
// (буфер в v3/v5/v6) тянулся в аудит на пустом месте.
const { randomUUID: uuidv4 } = require('crypto');

const User = require('../models/User');
const Establishments = require('../models/Establishments');
const Stream = require('../models/Stream');

const DEMO_DOMAIN = 'demo.takebana.local'; // по нему находим и чистим демо-записи
const DEMO_PASSWORD = 'demo123456';
const SALT_ROUNDS = 10;

const USERS = [
  { login: 'anna',  email: 'anna@'  + DEMO_DOMAIN },
  { login: 'boris', email: 'boris@' + DEMO_DOMAIN },
];

const PLACES = [
  {
    name: 'Бар «Тэкэбана»', type: 'bar', country: 'Сербия', city: 'belgrade',
    address: 'Кнеза Михаила, 12', phone: '+381 11 000-00-01',
    weekdayHours: { open: '12:00', close: '00:00' },
    weekendHours: { open: '12:00', close: '02:00' },
    location: { lat: 44.8168, lng: 20.4601 }, status: true, online: true,
  },
  {
    name: 'Кафе «Дунав»', type: 'cafe', country: 'Сербия', city: 'novi-sad',
    address: 'Змај Јовина, 4', phone: '+381 21 000-00-02',
    weekdayHours: { open: '09:00', close: '22:00' },
    weekendHours: { open: '10:00', close: '23:00' },
    location: { lat: 45.2551, lng: 19.8452 }, status: true, online: false,
  },
  {
    name: 'Паб «Морава»', type: 'pub', country: 'Сербия', city: 'nis',
    address: 'Обреновићева, 30', phone: '+381 18 000-00-03',
    weekdayHours: { open: '11:00', close: '23:00' },
    weekendHours: { open: '11:00', close: '01:00' },
    location: { lat: 43.3209, lng: 21.8958 }, status: false, online: false,
  },
];

// owner — индекс в USERS. Коды категорий и городов — из config/catalog.js:
// прежние «Бары» / «Атмосфера» не попадали ни в одну вкладку каталога.
const STREAMS = [
  { owner: 0, title: 'Демо: вечер в баре', category: 'business', subcategory: 'horeca', city: 'belgrade', isActive: true, viewers: 14 },
  { owner: 1, title: 'Демо: джем в клубе', category: 'entertainment', subcategory: 'music', city: 'novi-sad', isActive: true, viewers: 6 },
  { owner: 0, title: 'Демо: трансляция с камеры', category: 'business', subcategory: 'horeca', city: 'belgrade', isActive: false },
];

async function reset() {
  const users = await User.find({ email: new RegExp('@' + DEMO_DOMAIN + '$') }).select('_id').lean();
  const ids = users.map((u) => u._id);
  const s = await Stream.deleteMany({ userId: { $in: ids } });
  const e = await Establishments.deleteMany({ owner: { $in: ids } });
  const u = await User.deleteMany({ _id: { $in: ids } });
  console.log('Удалено демо-записей: пользователей %d, заведений %d, эфиров %d',
    u.deletedCount, e.deletedCount, s.deletedCount);
}

async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/webcabar';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log('База: %s', uri.replace(/\/\/.*@/, '//***:***@'));

  if (process.argv.includes('--reset')) await reset();

  const hash = await bcrypt.hash(DEMO_PASSWORD, SALT_ROUNDS);
  const created = [];

  for (const u of USERS) {
    let user = await User.findOne({ email: u.email, provider: '' });
    if (!user) {
      user = await User.create({
        ...u, password: hash, provider: '', role: 'user', streamKey: uuidv4(),
      });
      created.push('пользователь ' + u.login);
    }
    u._doc = user;
  }

  const owner = USERS[0]._doc;

  for (const p of PLACES) {
    const exists = await Establishments.findOne({ name: p.name, owner: owner._id });
    if (!exists) {
      await Establishments.create({
        ...p, email: owner.email, owner: owner._id, photos: [],
      });
      created.push('заведение «' + p.name + '»');
    } else if (exists.type !== p.type || exists.city !== p.city) {
      // Тип и город — коды config/catalog.js с 11 сентября 2026: у записей,
      // созданных раньше, город лежал строкой, а типа не было вовсе.
      await Establishments.updateOne({ _id: exists._id }, { $set: { type: p.type, city: p.city } });
      created.push('заведение «' + p.name + '»: тип и город');
    }
  }

  for (const { owner: i, ...s } of STREAMS) {
    const user = USERS[i]._doc;
    const exists = await Stream.findOne({ title: s.title, userId: user._id });
    if (!exists) {
      await Stream.create({
        ...s, userId: user._id, streamKey: user.streamKey || uuidv4(),
        startedAt: s.isActive ? new Date() : null,
        streamType: 'web-stream', streamProvider: 'web-stream',
      });
      created.push('эфир «' + s.title + '»');
    }
  }

  if (created.length) {
    console.log('\nСоздано:');
    for (const c of created) console.log('  ' + c);
  } else {
    console.log('\nВсё уже на месте, ничего не создавалось.');
  }

  const counts = {
    пользователей: await User.countDocuments(),
    заведений: await Establishments.countDocuments(),
    эфиров: await Stream.countDocuments(),
  };
  console.log('\nВ базе сейчас:');
  for (const [k, v] of Object.entries(counts)) console.log('  %s: %d', k, v);
  console.log('\nВход демо-пользователями: %s / пароль %s', USERS.map((u) => u.email).join(', '), DEMO_PASSWORD);
}

main()
  .catch((err) => {
    console.error('Ошибка:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
