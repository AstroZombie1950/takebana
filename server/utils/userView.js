// Как пользователь выглядит в интерфейсе: имя и аватар без фото.
// Прежде это считалось копией в десяти маршрутах.

const GRADIENTS = [
  'linear-gradient(to right, #ff7e5f, #feb47b)',
  'linear-gradient(to right, #6a11cb, #2575fc)',
  'linear-gradient(to right, #ff9966, #ff5e62)',
  'linear-gradient(to right, #00c6ff, #0072ff)',
  'linear-gradient(to right, #f7971e, #ffd200)',
  'linear-gradient(to right, #7F00FF, #E100FF)',
  'linear-gradient(to right, #fc00ff, #00dbde)',
];

// Логин, иначе начало почты. Без обоих (вход без почты) — хвост id: имя
// уходит и в звонок, и в чат эфира, где читатели на разных языках, поэтому
// словарная заглушка вроде «Пользователь» здесь не годится.
function displayName(user) {
  return user.login || (user.email && user.email.split('@')[0]) || '#' + String(user._id).slice(-6);
}

// Цвет — от id, а не случайный: прежде у одного человека он менялся
// от страницы к странице и при каждой перезагрузке. Хвост ObjectId —
// счётчик, поэтому соседние по регистрации получают разные цвета.
function avatarStyle(user, name = displayName(user)) {
  if (user.avatar) return { url: user.avatar };
  const n = parseInt(String(user._id).slice(-6), 16) || 0;
  return { gradient: GRADIENTS[n % GRADIENTS.length], initial: name.charAt(0).toUpperCase() };
}

module.exports = { displayName, avatarStyle };
