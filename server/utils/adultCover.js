// Обложки 18+ на витрине (AUDIT-2026-10-14, S5).
//
// Сама страница эфира и записи 18+ закрыта гейтом, но до 14.10 обложка
// висела в каталоге, поиске и на вкладке записей профиля у любого: у гостя
// и у того, кто 18+ не подтвердил. Теперь такому зрителю — размытая копия
// самой обложки: 64 точки по ширине, растягивается на карточку. Цвет
// и силуэт остаются, разобрать ничего нельзя. Размытие в CSS не годится:
// оригинал всё равно скачивается и виден в «Сохранить картинку».
//
// Копия делается по первому запросу (/blur/<вид>/<id>.webp, routes/blur.js)
// и лежит на нашем диске (media/blur, ~1 КБ): так одним путём покрыты
// и новые обложки, и старые, а Bunny не трогаем. ?v= — отпечаток адреса
// исходной обложки: сменили обложку — сменился и адрес копии, кэш браузера
// и nginx старую не отдаст. Не спрошенные месяц копии убираются.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Stream = require('../models/Stream');
const Recording = require('../models/Recording');
const User = require('../models/User');
const errorLog = require('./errorLog');

const DIR = path.join(__dirname, '..', 'media', 'blur');
const UPLOADS = path.join(__dirname, '..', 'public', 'uploads');
const CDN = (process.env.RECORDINGS_CDN_URL || '').replace(/\/+$/, '');
const WIDTH = 64;
const KEEP_MS = 30 * 864e5;

// Вид → документ и адрес его обложки.
const KINDS = {
  stream: { Model: Stream, fields: 'isAdult thumbnail', src: (d) => d.thumbnail },
  recording: { Model: Recording, fields: 'isAdult thumb', src: (d) => d.thumb && d.thumb.url },
};

const version = (src) => crypto.createHash('sha1').update(String(src)).digest('hex').slice(0, 10);
const ownerOf = (item) => String((item.userId && item.userId._id) || item.userId || '');

// Что показать зрителю вместо src. viewer — { id, adult }: автор и
// подтвердивший 18+ видят оригинал, остальные — копию.
function pick(kind, item, src, viewer) {
  if (!src || !item || !item.isAdult || !KINDS[kind]) return src;
  if (viewer && (viewer.adult || (viewer.id && String(viewer.id) === ownerOf(item)))) return src;
  return `/blur/${kind}/${item._id}.webp?v=${version(src)}`;
}

// Подтвердил ли человек 18+ — для маршрутов без commonDataMiddleware.
async function viewerOf(userId) {
  if (!userId) return { id: null, adult: false };
  const u = await User.findById(userId).select('adultConfirmedAt').lean();
  return { id: String(userId), adult: !!(u && u.adultConfirmedAt) };
}

// Исходник: свой файл (/uploads/…) или файл с CDN записей. Чужих адресов
// не читаем — маршрут не должен стать прокси на что угодно.
async function source(src) {
  if (src.startsWith('/uploads/')) {
    const file = path.resolve(UPLOADS, '.' + src.slice('/uploads'.length).split('?')[0]);
    if (!file.startsWith(UPLOADS + path.sep)) throw new Error('обложка вне папки загрузок');
    return fs.promises.readFile(file);
  }
  if (CDN && src.startsWith(CDN + '/')) {
    const res = await fetch(src, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`CDN ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('обложка не с нашего диска и не с CDN записей');
}

const making = new Map(); // файл → промис: два запроса одной копии ждут одну склейку

// Путь к готовой копии или null (не 18+, нет обложки, исходник не прочитан).
async function file(kind, id) {
  const K = KINDS[kind];
  if (!K || !/^[a-f\d]{24}$/i.test(id)) return null;
  const doc = await K.Model.findById(id).select(K.fields).lean();
  const src = doc && doc.isAdult ? K.src(doc) : '';
  if (!src) return null;
  const out = path.join(DIR, `${kind}-${id}-${version(src)}.webp`);
  if (fs.existsSync(out)) {
    // Отметка «спрашивали» для уборки: atime на сервере не надёжен (relatime).
    // Запросов мало — браузер держит копию год.
    const now = new Date();
    fs.promises.utimes(out, now, now).catch(() => {});
    return out;
  }
  if (!making.has(out)) {
    making.set(out, (async () => {
      try {
        const buf = await sharp(await source(src), { limitInputPixels: 50e6 })
          .rotate().resize({ width: WIDTH }).blur(2.5).webp({ quality: 40 }).toBuffer();
        await fs.promises.mkdir(DIR, { recursive: true });
        await fs.promises.writeFile(out, buf);
        return out;
      } catch (e) {
        errorLog.media(e, 'adultCover.make', { kind, id });
        return null;
      } finally {
        making.delete(out);
      }
    })());
  }
  return making.get(out);
}

// Копии, которые месяц никто не спрашивал (обложку сменили, эфир кончился).
async function sweep() {
  let names = [];
  try { names = await fs.promises.readdir(DIR); } catch { return; }
  const cutoff = Date.now() - KEEP_MS;
  let removed = 0;
  for (const n of names) {
    const p = path.join(DIR, n);
    const st = await fs.promises.stat(p).catch(() => null);
    if (st && st.mtimeMs < cutoff) {
      await fs.promises.rm(p, { force: true }).catch((e) => errorLog.server(e, 'adultCover.sweep'));
      removed += 1;
    }
  }
  if (removed) console.log(`[blur] убрано старых размытых обложек: ${removed}`);
}

function start() {
  setTimeout(sweep, 60 * 1000).unref();
  setInterval(sweep, 864e5).unref();
}

module.exports = { pick, viewerOf, file, start };
