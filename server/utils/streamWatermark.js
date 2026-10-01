// Где у эфира водяной знак (30.09.2026) — настройка в панели, вкладка
// «Водяной знак».
//
//   overlay — поверх плеера у зрителя (по умолчанию). Сервер видео не
//             трогает сверх нужного: первые эфиры идут лестницей качеств,
//             дальше видео копируется (utils/hls.js). Знак снимается вместе
//             со страницей, а по прямой ссылке на плейлист его нет вовсе.
//   frame   — в кадре: кладёт наш ffmpeg, каждый эфир пережимается. Знак не
//             снять, но процессор кончается на четвёртом-пятом эфире.
//
// Зачем выбор: знак в кадре упирает число эфиров в процессор сервера, а для
// зрителя наложение выглядит так же. Вернуть знак в кадр — одна кнопка,
// если понадобится строгая защита (решение 30.09: пока поверх, альтернатива
// — позже).
//
// Режим конвейер берёт при старте эфира (hls.start) и держит до его конца:
// смена в панели действует на эфиры, начатые после неё.
//
// Запись эфира — всегда со знаком в кадре (решение 01.10.2026): при
// overlay куски пишутся чистыми и при сохранении пережимаются со знаком
// в фоне (utils/recording.js). Процессор тратится один раз и не во время
// эфира, а скачанная запись остаётся помеченной.

const Setting = require('../models/Setting');
const errorLog = require('./errorLog');

const KEY = 'streamWatermark';
const MODES = ['overlay', 'frame'];

// Конвейер спрашивает режим синхронно, в обработчике RTMP, — поэтому
// значение живёт в памяти: читается при запуске и меняется только здесь.
// Процесс один (ops/ecosystem.config.js), расходиться не с кем.
let current = { mode: 'overlay', updatedAt: null };

async function load() {
  try {
    const doc = await Setting.findById(KEY).lean();
    if (doc && MODES.includes(doc.value && doc.value.mode)) current = { mode: doc.value.mode, updatedAt: doc.updatedAt };
  } catch (e) {
    errorLog.server(e, 'streamWatermark.load');
  }
}

const mode = () => current.mode;
const updatedAt = () => current.updatedAt;

// null — режима такого нет.
async function save(value, by) {
  if (!MODES.includes(value)) return null;
  const at = new Date();
  await Setting.updateOne({ _id: KEY }, { $set: { value: { mode: value }, updatedAt: at, updatedBy: by || null } }, { upsert: true });
  current = { mode: value, updatedAt: at };
  return value;
}

module.exports = { MODES, load, mode, updatedAt, save };
