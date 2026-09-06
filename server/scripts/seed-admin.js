// Создаёт первого администратора. Без него в панель /panel не попасть:
// роль 'admin' есть в модели User, но ни одна строка приложения её не выставляет.
//
//   node scripts/seed-admin.js --email a@b.c --password 'секрет'
//   node scripts/seed-admin.js --email a@b.c            # пароль сгенерируется
//   node scripts/seed-admin.js --list                   # показать текущих админов
//
// Если пользователь с таким email уже есть — он повышается до admin.
// Пароль при этом меняется, только если он передан явно.

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');

const SALT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 6; // столько же требует routes/userRoutes.js

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--email') args.email = argv[++i];
    else if (a === '--password') args.password = argv[++i];
    else if (a === '--role') args.role = argv[++i];
  }
  return args;
}

function generatePassword() {
  // 18 символов base64url — хватает, и его не стыдно скопировать в менеджер паролей
  return crypto.randomBytes(14).toString('base64url');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/webcabar';

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log('База: %s', uri.replace(/\/\/.*@/, '//***:***@'));

  if (args.list) {
    const admins = await User.find({ role: { $in: ['admin', 'moderator'] } })
      .select('email login role provider')
      .lean();
    if (!admins.length) {
      console.log('Администраторов нет.');
    } else {
      console.log('Найдено: %d', admins.length);
      for (const a of admins) {
        console.log('  %s  %s  provider=%s', a.role.padEnd(9), a.email, a.provider || '(пароль)');
      }
    }
    return;
  }

  const email = args.email;
  if (!email) {
    console.error('Не указан --email. Пример:');
    console.error("  node scripts/seed-admin.js --email admin@takebana.local --password 'секрет'");
    process.exitCode = 1;
    return;
  }

  const role = args.role || 'admin';
  if (!['admin', 'moderator'].includes(role)) {
    console.error('Роль может быть только admin или moderator, получено: %s', role);
    process.exitCode = 1;
    return;
  }

  let password = args.password;
  const generated = !password;
  if (generated) password = generatePassword();

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error('Пароль короче %d символов — вход через форму его не примет.', MIN_PASSWORD_LENGTH);
    process.exitCode = 1;
    return;
  }

  // provider:'' — так вход по паролю ищет пользователя в routes/userRoutes.js.
  // У входивших через Google provider='google', и пароля у них нет.
  const existing = await User.findOne({ email, provider: '' });

  if (existing) {
    const wasRole = existing.role;
    existing.role = role;
    if (args.password) existing.password = await bcrypt.hash(password, SALT_ROUNDS);
    if (!existing.streamKey) existing.streamKey = uuidv4();
    await existing.save();

    console.log('\nПользователь уже существовал — обновлён.');
    console.log('  email: %s', email);
    console.log('  роль:  %s -> %s', wasRole, role);
    console.log('  пароль: %s', args.password ? 'изменён на переданный' : 'оставлен прежним');
    if (generated) console.log('  (сгенерированный пароль не применён: пользователь уже был заведён)');
  } else {
    const user = new User({
      email,
      login: email.split('@')[0],
      password: await bcrypt.hash(password, SALT_ROUNDS),
      provider: '',
      role,
      streamKey: uuidv4(),
    });
    await user.save();

    console.log('\nАдминистратор создан.');
    console.log('  email:  %s', email);
    console.log('  роль:   %s', role);
    console.log('  пароль: %s', password);
    if (generated) console.log('\n  Пароль сгенерирован и больше нигде не сохранён — скопируйте сейчас.');
  }

  console.log('\nВойти: /login, затем открыть /panel');
}

main()
  .catch((err) => {
    console.error('Ошибка:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
