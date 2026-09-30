// Видео-меню заведения (29.09, docs/VENUES.md п. 10): вкладка /venue/:id/menu
// и правка позиций. Позиции и ролики — utils/venueMenu.js, вид — views/venueMenu.ejs,
// скрипт — public/tk-venue-menu.js.
//
// Меню включает владелец в настройках заведения (features.videoMenu).
// Выключенное — 404 всем, кроме владельца и администратора: им вкладка
// открывается с пометкой, чтобы меню можно было собрать заранее. Позиции
// заводит владелец одобренного заведения; администратор может править
// и удалять — как саму правку заведения (requireOwner).

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const Establishments = require('../models/Establishments');
const MenuItem = require('../models/MenuItem');
const venueMenu = require('../utils/venueMenu');
const { pageVenue, tabsFor, indexableVenue } = require('../utils/venuePage');
const { requireAuthApi, requireOwner, requireNotBanned } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { commonDataMiddleware } = require('./streaming/shared');
const { audit } = require('../utils/audit');
const ld = require('../utils/jsonld');

const OBJECT_ID = /^[a-f\d]{24}$/i;

// Присланный ролик — на диск во временную папку, не в память: до CLIP_MB.
// Вид файла проверяет пережатие (utils/videoEncode.js) по содержимому.
const uploadClip = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => cb(null, 'tk-menu-' + Date.now() + '-' + Math.random().toString(36).slice(2)),
  }),
  limits: { fileSize: venueMenu.CLIP_MB * 1024 * 1024, files: 1, fields: 4 },
});

const FIELDS = {
  section: { type: 'string', max: venueMenu.SECTION_MAX, default: '', label: 'Раздел' },
  name: { type: 'string', required: true, max: venueMenu.NAME_MAX, label: 'Название' },
  description: { type: 'string', max: venueMenu.DESCRIPTION_MAX, default: '', label: 'Описание' },
  price: { type: 'string', max: venueMenu.PRICE_MAX, default: '', label: 'Цена' },
};

// ── Вкладка ──
router.get('/venue/:venueId/menu', commonDataMiddleware, async (req, res, next) => {
  const found = await pageVenue(req, res);
  if (!found) return next();
  const { venue, own, admin } = found;
  const manage = own || admin;
  const on = !!(venue.features && venue.features.videoMenu);
  if (!on && !manage) return next();
  const items = await MenuItem.find({ venue: venue._id }).sort({ order: 1, _id: 1 }).lean();
  if (!items.length && !manage) return next();
  const sections = venueMenu.sections(items);
  const path = `/venue/${venue._id}/menu`;
  res.render('venueMenu', {
    venue, manage, on, sections,
    tab: 'menu',
    tabs: await tabsFor(venue, manage),
    count: items.length,
    canEdit: manage && venue.status === true,
    indexable: on && items.length > 0 && indexableVenue(venue),
    menuLd: items.length ? ld.menu({ path, name: venue.name, sections }) : null,
    limits: {
      name: venueMenu.NAME_MAX, description: venueMenu.DESCRIPTION_MAX, price: venueMenu.PRICE_MAX,
      section: venueMenu.SECTION_MAX, seconds: venueMenu.CLIP_SECONDS, mb: venueMenu.CLIP_MB, items: venueMenu.MAX_ITEMS,
    },
    clipsEnabled: venueMenu.enabled,
  });
});

// ── Правка ──
// Позиция своего заведения по :itemId. null — нет такой.
function itemOf(req) {
  if (!OBJECT_ID.test(req.params.itemId)) return null;
  return MenuItem.findOne({ _id: req.params.itemId, venue: req.resource._id }).lean();
}

const owner = requireOwner(Establishments);
const guard = [requireAuthApi, requireNotBanned, owner];

router.post('/venue/:id/menu', ...guard, validate(FIELDS), async (req, res) => {
  const venue = req.resource;
  if (venue.status !== true) return res.status(403).json({ message: 'Меню заводится у одобренного заведения' });
  if (await MenuItem.countDocuments({ venue: venue._id }) >= venueMenu.MAX_ITEMS) {
    return res.status(400).json({ message: 'В меню уже 100 позиций' });
  }
  const last = await MenuItem.findOne({ venue: venue._id }).sort({ order: -1 }).select('order').lean();
  const item = await MenuItem.create({ venue: venue._id, ...req.body, order: last ? last.order + 1 : 0 });
  audit(req, 'venue.menu', { targetType: 'venue', target: venue, meta: { add: String(item._id) } });
  res.json({ ok: true, item: venueMenu.itemView(item) });
});

router.get('/venue/:id/menu/:itemId', requireAuthApi, owner, async (req, res) => {
  const item = await itemOf(req);
  if (!item) return res.status(404).json({ message: 'Позиция не найдена' });
  res.json({ ok: true, item: venueMenu.itemView(item) });
});

router.put('/venue/:id/menu/:itemId', ...guard, validate(FIELDS), async (req, res) => {
  const item = await itemOf(req);
  if (!item) return res.status(404).json({ message: 'Позиция не найдена' });
  const saved = await MenuItem.findOneAndUpdate({ _id: item._id }, { $set: req.body }, { returnDocument: 'after' }).lean();
  res.json({ ok: true, item: venueMenu.itemView(saved) });
});

router.delete('/venue/:id/menu/:itemId', ...guard, async (req, res) => {
  const item = await itemOf(req);
  if (!item) return res.status(404).json({ message: 'Позиция не найдена' });
  await venueMenu.remove(item);
  audit(req, 'venue.menu', { targetType: 'venue', target: req.resource, meta: { remove: String(item._id), name: item.name } });
  res.json({ ok: true });
});

// Выше или ниже на одну: меняется местами с соседом по списку.
router.post('/venue/:id/menu/:itemId/move', ...guard, validate({
  dir: { type: 'int', required: true, values: [-1, 1], label: 'Куда' },
}), async (req, res) => {
  const item = await itemOf(req);
  if (!item) return res.status(404).json({ message: 'Позиция не найдена' });
  const list = await MenuItem.find({ venue: item.venue }).sort({ order: 1, _id: 1 }).select('_id').lean();
  const at = list.findIndex((x) => String(x._id) === String(item._id));
  const to = at + req.body.dir;
  if (to < 0 || to >= list.length) return res.json({ ok: true });
  [list[at], list[to]] = [list[to], list[at]];
  // Порядок переписывается целиком: у старых позиций он мог совпадать.
  await MenuItem.bulkWrite(list.map((x, i) => ({ updateOne: { filter: { _id: x._id }, update: { $set: { order: i } } } })));
  res.json({ ok: true });
});

// Ролик позиции: файл и start — с какой секунды исходника. Пережатие идёт
// в фоне; страница спрашивает позицию, пока ролик не готов.
router.post('/venue/:id/menu/:itemId/clip', ...guard, uploadClip.single('clip'), async (req, res) => {
  const file = req.file && req.file.path;
  const drop = () => file && fs.promises.rm(file, { force: true }).catch(() => {});
  const item = await itemOf(req);
  if (!item) { await drop(); return res.status(404).json({ message: 'Позиция не найдена' }); }
  if (!venueMenu.enabled) { await drop(); return res.status(503).json({ message: 'Видео сейчас не принимаются' }); }
  if (!file) return res.status(400).json({ message: 'Файл не передан' });
  if (item.clip && item.clip.status === 'processing') { await drop(); return res.status(409).json({ message: 'Прежний ролик ещё обрабатывается' }); }
  const start = Math.max(0, Math.min(86400, Number(req.body.start) || 0));
  await venueMenu.setClip(item, file, start, req.session.userId);
  audit(req, 'venue.menu', { targetType: 'venue', target: req.resource, meta: { clip: String(item._id), size: req.file.size } });
  res.json({ ok: true, item: venueMenu.itemView(await MenuItem.findById(item._id).lean()) });
});

router.delete('/venue/:id/menu/:itemId/clip', ...guard, async (req, res) => {
  const item = await itemOf(req);
  if (!item) return res.status(404).json({ message: 'Позиция не найдена' });
  await venueMenu.clearClip(item);
  res.json({ ok: true });
});

module.exports = router;
