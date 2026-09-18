// Разовое сжатие того, что загрузили до utils/image.js.
//
//   node scripts/compress-uploads.js           # только посчитать: что и сколько сэкономим
//   node scripts/compress-uploads.js --apply   # пережать на месте
//
// Новые загрузки уже идут через sharp. Старые лежат как прислали: фото
// с телефона на несколько мегабайт под аватаркой 128×128.
//
// Пережимаем в том же формате и под тем же именем: jpeg остаётся jpeg,
// png — png. Так адреса в базе не меняются и базу трогать не нужно вовсе.
// Размеры — те же, что у новых загрузок (utils/image.js, PRESETS), метаданные
// срезаются. Файл заменяется, только если стал легче: уже маленький не трогаем.
//
// Запись на диск — через временный файл и rename: оборванный на середине
// запуск не оставит полупустую картинку.

const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { PRESETS } = require('../utils/image');

const UPLOADS = path.join(__dirname, '..', 'public', 'uploads');
const APPLY = process.argv.includes('--apply');

// Папка → профиль обработки. Галерея лежит по подпапкам пользователей.
const DIRS = [
  { dir: 'avatars', preset: 'avatar' },
  { dir: 'thumbnails', preset: 'thumbnail' },
  { dir: 'establishments', preset: 'establishment' },
  { dir: 'gallery', preset: 'gallery', nested: true },
];

const IMAGE = /\.(jpe?g|png)$/i;

async function files(dir, nested) {
  const root = path.join(UPLOADS, dir);
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory() && nested) out.push(...await files(path.join(dir, e.name), false));
    else if (e.isFile() && IMAGE.test(e.name)) out.push(full);
  }
  return out;
}

async function recompress(file, preset) {
  const p = PRESETS[preset];
  const before = (await fs.stat(file)).size;
  let pipeline = sharp(file).rotate()
    .resize({ width: p.width, height: p.height, fit: p.fit, withoutEnlargement: true });
  pipeline = /\.png$/i.test(file)
    ? pipeline.png({ compressionLevel: 9, palette: true, quality: p.quality })
    : pipeline.jpeg({ quality: p.quality, mozjpeg: true });
  const data = await pipeline.toBuffer();
  if (data.length >= before) return { before, after: before, skipped: true };
  if (APPLY) {
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  }
  return { before, after: data.length };
}

(async () => {
  const mb = (n) => (n / 1048576).toFixed(2) + ' МБ';
  let total = 0, saved = 0, count = 0, broken = 0;
  for (const { dir, preset, nested } of DIRS) {
    for (const file of await files(dir, nested)) {
      try {
        const r = await recompress(file, preset);
        total += r.before; saved += r.before - r.after; count++;
      } catch (e) {
        broken++;
        console.warn('  не читается:', path.relative(UPLOADS, file), '—', e.message);
      }
    }
  }
  console.log(`${APPLY ? 'Пережато' : 'Можно пережать'}: ${count} файлов, ${mb(total)} → ${mb(total - saved)}` +
    (broken ? `; нечитаемых — ${broken}` : ''));
  if (!APPLY && saved) console.log('Запустить с --apply, чтобы заменить файлы.');
})().catch((e) => { console.error(e); process.exit(1); });
