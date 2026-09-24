// Почта в нижнем регистре — для аккаунтов, заведённых до 24.09.2026.
//
// С этого дня схема хранит почту в нижнем регистре и так же ищет по ней
// (models/User.js). Человек, у которого в базе «Audit@…», без перевода
// не вошёл бы вовсе: запрос ищет «audit@…». Поэтому перевод — при каждом
// запуске, сам, а не отдельным шагом выкладки, который легко забыть.
// Переводить нечего — это один запрос.
//
// Если у той же почты в другом регистре уже есть второй аккаунт того же
// входа, перевести нельзя (уникальный индекс email + provider): такая пара
// уходит в журнал ошибок панели и ждёт решения руками.

const User = require('../models/User');
const errorLog = require('../utils/errorLog');

async function lowercaseEmails() {
  // Регулярное выражение lowercase схемы не трогает — фильтр доходит как есть.
  const rows = await User.find({ email: /[A-Z]|^\s|\s$/ }).select('email provider').lean();
  for (const u of rows) {
    const email = u.email.trim().toLowerCase();
    const taken = await User.exists({ _id: { $ne: u._id }, email, provider: u.provider });
    if (taken) {
      errorLog.server(new Error(`почта ${email}: два аккаунта в разном регистре, перевести нельзя`), 'jobs.lowercaseEmails',
        { user: String(u._id), other: String(taken._id) });
      continue;
    }
    await User.updateOne({ _id: u._id }, { $set: { email } });
  }
  if (rows.length) console.log(`[emails] в нижний регистр: ${rows.length}`);
}

function run() {
  lowercaseEmails().catch((e) => errorLog.server(e, 'jobs.lowercaseEmails'));
}

module.exports = { run };
