// Камера заведения через Bunny (решение 25.09.2026, вариант А).
//
// Заведение вещает по WHIP на наш MediaMTX — он здесь только приёмник,
// зрителям он не отдаёт ничего. Наш ffmpeg забирает поток с петли
// (RTSP), кладёт знак в кадр и режет HLS 480p/15 кадров в тот же
// /live/, что у эфиров (utils/hls.js), — зрители берут его через CDN
// live.takebana.com. Наш исходящий трафик — одна копия на камеру для
// Bunny, сколько бы людей ни смотрело; процессор — ~0,11 ядра на
// камеру, которую смотрят (замер 25.09).
//
// Камера вещает, только когда её смотрят. Страница владельца открыта
// весь день, но видео уходит, лишь пока на странице камеры есть хоть
// один вошедший зритель: сокет-комната venue:<id> (sockets/index.js)
// сообщает сюда их число, отсюда владельцу — venue:demand. Зрителей
// не стало — выжидаем IDLE_MS (обновление страницы не должно рвать
// показ) и гасим. Начало и конец публикации MediaMTX сообщает сам
// (runOnAvailable / runOnUnavailable → routes/venueLive.js), по ним
// запускается и гаснет ffmpeg.

const { createHmac } = require('crypto');
const Establishments = require('../models/Establishments');
const mediamtx = require('./mediamtx');
const hls = require('./hls');
const ioHolder = require('./io');
const errorLog = require('./errorLog');

const IDLE_MS = 30 * 1000;
// Владелец пропал без «выключить» (упала вкладка, пропала сеть): через
// столько камеру снимаем с карты — зрителю иначе ждать картинку вечно.
const OWNER_GONE_MS = 60 * 1000;

const demand = new Map(); // venueId → true, пока камеру просят
const idle = new Map();   // venueId → таймер выключения
const gone = new Map();   // venueId → таймер «владелец пропал»

// Каталог HLS камеры: не угадать без секрета, но один и тот же между
// перезапусками — зритель с открытой страницей не теряет адрес. Смотреть
// камеру пускают после входа (routes/venueLive.js), а адрес без суффикса
// подбирался бы по id заведения из карты.
function hlsKey(venueId) {
  const sig = createHmac('sha256', process.env.SESSION_SECRET || 'dev').update('venue:' + venueId).digest('hex').slice(0, 16);
  return `venue_${venueId}_${sig}`;
}

const venueOf = (path) => (/^venue_([a-f\d]{24})$/i.exec(path || '') || [])[1] || null;

function emit(venueId, event, payload) {
  const io = ioHolder.get();
  if (io) io.to(`venue:${venueId}`).emit(event, { venueId: String(venueId), ...payload });
}

function room(venueId) {
  const io = ioHolder.get();
  return io ? io.sockets.adapter.rooms.get(`venue:${venueId}`) : null;
}

// Зрители — вошедшие, кроме владельца: гостю картинку не показывают
// (routes/venueLive.js). Один человек с трёх вкладок — один зритель.
function count(venueId) {
  const io = ioHolder.get();
  const ids = room(venueId);
  if (!io || !ids) return 0;
  const users = new Set();
  for (const id of ids) {
    const s = io.sockets.sockets.get(id);
    if (s && s.data.userId && s.data.venueOwn !== String(venueId)) users.add(s.data.userId);
  }
  return users.size;
}

// Сидит ли владелец на странице камеры (sockets/index.js, venueOwn).
function ownerHere(venueId) {
  const io = ioHolder.get();
  const ids = room(venueId);
  if (!io || !ids) return false;
  for (const id of ids) {
    const s = io.sockets.sockets.get(id);
    if (s && s.data.venueOwn === String(venueId)) return true;
  }
  return false;
}

function setDemand(venueId, on) {
  if (!!demand.get(venueId) === on) return;
  if (on) demand.set(venueId, true); else demand.delete(venueId);
  emit(venueId, 'venue:demand', { on });
}

// Число зрителей на странице изменилось (sockets/index.js). Просим
// камеру, только если она включена владельцем.
async function viewers(venueId, count) {
  venueId = String(venueId);
  if (count > 0) {
    clearTimeout(idle.get(venueId));
    idle.delete(venueId);
    if (demand.get(venueId)) return;
    const venue = await Establishments.findById(venueId).select('online').lean().catch(() => null);
    if (venue && venue.online) setDemand(venueId, true);
    return;
  }
  if (!demand.get(venueId) || idle.has(venueId)) return;
  idle.set(venueId, setTimeout(() => {
    idle.delete(venueId);
    setDemand(venueId, false);
  }, IDLE_MS).unref());
}

// Владелец включил камеру: зрители уже ждут — сразу просим картинку.
function switchedOn(venueId, count) {
  venueId = String(venueId);
  if (count > 0) setDemand(venueId, true);
}

// Выключили (кнопкой, баном, удалением): спрос снят, ffmpeg гаснет,
// когда MediaMTX скажет, что публикации больше нет.
function switchedOff(venueId) {
  venueId = String(venueId);
  clearTimeout(idle.get(venueId));
  idle.delete(venueId);
  clearTimeout(gone.get(venueId));
  gone.delete(venueId);
  demand.delete(venueId);
  hls.stop(hlsKey(venueId));
}

const wanted = (venueId) => !!demand.get(String(venueId));

// Сокет владельца отключился. Вернулся за минуту — ничего не было.
function ownerLeft(venueId) {
  venueId = String(venueId);
  if (gone.has(venueId)) return;
  gone.set(venueId, setTimeout(async () => {
    gone.delete(venueId);
    if (ownerHere(venueId)) return;
    try {
      const r = await Establishments.updateOne({ _id: venueId, online: true }, { $set: { online: false } });
      if (!r.modifiedCount) return;
      emit(venueId, 'venue:state', { online: false });
      switchedOff(venueId);
      await mediamtx.kick(mediamtx.pathOf(venueId));
    } catch (e) {
      errorLog.server(e, 'venueCam.ownerLeft', { venueId });
    }
  }, OWNER_GONE_MS).unref());
}

// Публикация пошла или кончилась (routes/venueLive.js, хуки MediaMTX).
function available(path) {
  const venueId = venueOf(path);
  if (!venueId) return;
  hls.start(hlsKey(venueId), { input: mediamtx.readUrl(path), profile: 'venue' });
}

function unavailable(path) {
  const venueId = venueOf(path);
  if (venueId) hls.stop(hlsKey(venueId));
}

// Перезапуск приложения: MediaMTX о публикациях, начатых до него, ещё
// раз не скажет — спрашиваем сами.
async function resume() {
  for (const path of await mediamtx.livePaths()) available(path);
}

module.exports = { hlsKey, count, viewers, switchedOn, switchedOff, wanted, ownerHere, ownerLeft, available, unavailable, resume };
