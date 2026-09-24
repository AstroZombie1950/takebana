// Картинка карточки профиля для мессенджеров и соцсетей: аватар и логотип
// на фирменном тёмном фоне, 1200×630 (docs/seo/). Без водяного знака: знак —
// только на контенте, не на аватарах (решение 18.09).
//
// Живёт в облаке (utils/storage.js), не на сервере: диск сервера маленький.
// Собирается один раз на аватар — при смене аватара и, для тех, кто сменил
// его до этой функции, при первом открытии профиля — и отдаётся с CDN.
// Адрес и версия (имя файла аватара) — в User.ogCard. Пока картинки нет,
// у страницы общая обложка. Аватар не свой (вход через Google) — тоже.

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const storage = require('./storage');
const errorLog = require('./errorLog');

const UPLOADS = path.join(__dirname, '..', 'public');
const LOGO = path.join(__dirname, '..', 'public', 'img', 'logo.svg');
const W = 1200, H = 630, AVA = 420;

// /uploads/avatars/<имя файла> — только так и только простое имя.
function avatarFile(avatar) {
  const m = /^\/uploads\/avatars\/([\w.-]+)$/.exec(avatar || '');
  return m ? path.join(UPLOADS, 'uploads', 'avatars', m[1]) : null;
}

async function render(src, out) {
  const [avatar, logo] = await Promise.all([
    sharp(src).resize(AVA, AVA, { fit: 'cover' }).toBuffer(),
    sharp(LOGO, { density: 300 }).resize({ width: 480 }).toBuffer({ resolveWithObject: true }),
  ]);
  const left = 110, top = (H - AVA) / 2;
  await sharp({ create: { width: W, height: H, channels: 3, background: '#0A0A0A' } })
    .composite([
      // Киноварная рамка за аватаром — тот же приём, что у карточек сайта.
      { input: { create: { width: AVA + 16, height: AVA + 16, channels: 3, background: '#E34234' } }, left: left - 8, top: top - 8 },
      { input: avatar, left, top },
      { input: logo.data, left: 620, top: Math.round((H - logo.info.height) / 2) },
    ])
    .jpeg({ quality: 85 })
    .toFile(out);
}

// Собрать и выгрузить для нынешнего аватара; прежнюю — удалить. Один
// человек — одна сборка за раз.
const building = new Set();
async function refresh(user) {
  const User = require('../models/User');
  const id = String(user._id);
  const src = avatarFile(user.avatar);
  if (!storage.enabled || building.has(id)) return;
  building.add(id);
  const tmp = path.join(os.tmpdir(), `tk-og-${id}-${Date.now()}.jpg`);
  try {
    const old = user.ogCard && user.ogCard.key;
    if (!src || !fs.existsSync(src)) {
      if (old) {
        await User.updateOne({ _id: id }, { $unset: { ogCard: 1 } });
        await storage.remove(old).catch(() => {});
      }
      return;
    }
    const v = path.parse(src).name;
    const key = `og/${id}-${v}.jpg`;
    await render(src, tmp);
    const url = await storage.put(tmp, key, 'image/jpeg');
    await User.updateOne({ _id: id }, { $set: { ogCard: { url, key, v } } });
    if (old && old !== key) await storage.remove(old).catch(() => {});
  } catch (e) {
    errorLog.media(e, 'og.profile', { user: id });
  } finally {
    building.delete(id);
    fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}

// Адрес картинки для og:image профиля или null — тогда общая обложка.
// Картинка устарела или её нет — собирается в фоне, страницу не держит.
function forProfile(user) {
  const src = avatarFile(user.avatar);
  const card = user.ogCard;
  if (src && card && card.v === path.parse(src).name) return card.url;
  if (src || card) refresh(user);
  return null;
}

module.exports = { refresh, forProfile };
