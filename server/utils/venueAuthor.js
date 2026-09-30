// Автор карточки от имени заведения (29.09, docs/VENUES.md п. 9). Эфир, запись
// и видео с полем venue показываются под заведением: его название, логотип
// и ссылка на его страницу — вместо человека, который их ведёт. Вид — тот же,
// что у автора-человека ({ displayName, url, avatarStyle }), поэтому карточки
// каталога, ленты, поиска и «Смотрите также» менять не нужно.
//
// Заведение подтягивается populate('venue', VENUE_AUTHOR). Скрытое панелью
// или удалённое подписью не служит — тогда автор снова человек.

const userView = require('./userView');

const VENUE_AUTHOR = 'name avatar status';

function venueAuthor(venue) {
  if (!venue || !venue.name || venue.status !== true) return null;
  return {
    _id: venue._id,
    venue: true,
    displayName: venue.name,
    url: '/venue/' + venue._id,
    avatarStyle: userView.avatarStyle(venue, venue.name),
  };
}

module.exports = { VENUE_AUTHOR, venueAuthor };
