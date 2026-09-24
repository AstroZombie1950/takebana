// Адрес профиля: /@ник (docs/seo/DECISIONS.md). Ник есть у всех
// (utils/nickname.js, ensureAll), /userPage/<id> — запасной путь на случай,
// если его нет, и старый адрес: он отвечает 301 сюда же.

function profileUrl(user) {
  return user && user.nickname ? '/@' + user.nickname : '/userPage/' + (user && user._id);
}

module.exports = { profileUrl };
