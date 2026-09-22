// Проверка связи — страница /check (views/check.ejs, public/tk-check.js).
//
// Жалобы «у меня не грузится» приходят без подробностей, а у разных
// российских провайдеров режется разное: 21.09.2026 с одного московского
// узла не открылся адрес Bunny, хотя сайт и Daily с него работали
// (temp/costs-2026-09-21.md, раздел 8). Страница проверяет каждый путь
// по отдельности и пишет итог в журнал панели.
//
// Замер — один и тот же файл в 96 КБ по трём адресам: свой сервер, CDN
// эфиров, CDN записей. Больше 16 КБ нарочно: так режут Cloudflare, и обрыв
// на первых килобайтах виден как недокачанный файл, а не как «открылось».
// Расширение .ts — для него у обеих зон Bunny включён CORS, и страница
// может дочитать ответ и посчитать байты.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');
const errorLog = require('./errorLog');
const { HLS_ROOT, hlsBase } = require('./hls');

const KEY = '_check/probe.ts';
const SIZE = 96 * 1024;
const LOCAL = path.join(HLS_ROOT, KEY);
const VOD = (process.env.RECORDINGS_CDN_URL || '').replace(/\/+$/, '');

let vodReady = false;

// При старте: файл на своём диске (его отдаёт nginx по /live/, и за ним же
// ходит CDN эфиров) и копия в хранилище Bunny для CDN записей.
async function prepare() {
  try {
    if (!fs.existsSync(LOCAL)) {
      await fs.promises.mkdir(path.dirname(LOCAL), { recursive: true });
      await fs.promises.writeFile(LOCAL, crypto.randomBytes(SIZE));
    }
    if (storage.driver !== 'bunny' || !VOD) return;
    const head = await fetch(`${VOD}/${KEY}`, { method: 'HEAD' }).catch(() => null);
    if (!head || !head.ok) await storage.put(LOCAL, KEY, 'video/mp2t');
    vodReady = true;
  } catch (err) {
    errorLog.external(err, 'netCheck.prepare');
  }
}

// Адреса для страницы. Нет CDN — нет и строки проверки.
function targets() {
  return {
    size: SIZE,
    site: `/live/${KEY}`,
    live: hlsBase ? `${hlsBase}/live/${KEY}` : '',
    vod: vodReady ? `${VOD}/${KEY}` : '',
    daily: process.env.DAILY_DOMAIN ? `https://${process.env.DAILY_DOMAIN}.daily.co/` : '',
  };
}

module.exports = { prepare, targets };
