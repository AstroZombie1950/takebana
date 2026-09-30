// Владелец и его заведения (29.09, docs/VENUES.md п. 6–7): сколько их может
// быть и можно ли подать ещё одну заявку.
//
// Заведений у человека — не больше MAX_VENUES одновременно: одобренные,
// скрытые панелью и заявки на проверке. Отклонённую заявку панель удаляет,
// поэтому она и не считается. Заявка на проверке — одна за раз: пока первую
// не рассмотрели, вторую не подать, чтобы панель не заваливали пачкой.
// Правка одобренного (pending) — не заявка и ни во что не считается.

const Establishments = require('../models/Establishments');

const MAX_VENUES = 10;

// Заявка, которую панель ещё не рассматривала.
const isWaiting = (v) => v.status !== true && !v.reviewedAt;

// → { count, waiting, full, can } — can: можно подать новую заявку.
async function applyState(ownerId) {
  const venues = await Establishments.find({ owner: ownerId }).select('status reviewedAt').lean();
  const waiting = venues.some(isWaiting);
  const full = venues.length >= MAX_VENUES;
  return { count: venues.length, max: MAX_VENUES, waiting, full, can: !waiting && !full };
}

// Состояние заведения для списка своих — класс и ключ подписи.
function stateOf(v) {
  if (v.online) return ['is-live', 'venues.onAir'];
  if (isWaiting(v)) return ['is-wait', 'venues.pending'];
  if (v.status !== true) return ['is-off', 'venues.hidden'];
  if (v.pending && v.pending.at) return ['is-wait', 'venue.page.draft'];
  return ['', 'venues.offlineState'];
}

// Своё одобренное заведение — от его имени можно вести эфир и загружать
// видео (docs/VENUES.md п. 9). null — чужое, на проверке, скрытое или нет такого.
async function ownApproved(ownerId, venueId) {
  if (!venueId || !/^[a-f\d]{24}$/i.test(String(venueId))) return null;
  return Establishments.findOne({ _id: venueId, owner: ownerId, status: true }).select('name avatar city status').lean();
}

module.exports = { MAX_VENUES, applyState, stateOf, ownApproved };
