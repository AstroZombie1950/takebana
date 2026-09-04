// utils/playlistUtils.js
// Утилиты для управления обновлением HLS плейлистов

const path = require('path');
const fs = require('fs');

let playlistUpdateIntervals = {}; // Интервалы для периодического обновления плейлистов

// Функция для запуска периодического обновления плейлиста
function startPlaylistUpdates(streamKey, STREAMS_DIR) {
  // Останавливаем предыдущий интервал если есть
  stopPlaylistUpdates(streamKey);
  
  console.log(`🔄 Запускаем периодическое обновление плейлиста для ${streamKey}`);
  
  playlistUpdateIntervals[streamKey] = setInterval(() => {
    const streamPath = path.join(STREAMS_DIR, streamKey);
    const playlistPath = path.join(streamPath, 'playlist.m3u8');
    
    // Проверяем что плейлист существует
    if (fs.existsSync(playlistPath)) {
      try {
        // Перезаписываем плейлист с теми же данными для обновления timestamp
        const content = fs.readFileSync(playlistPath, 'utf8');
        fs.writeFileSync(playlistPath, content);
        console.log(`📋 Плейлист ${streamKey} обновлен (keepalive)`);
      } catch (error) {
        console.error(`❌ Ошибка обновления плейлиста ${streamKey}:`, error);
      }
    }
  }, 5000); // Обновляем каждые 5 секунд
}

// Функция для остановки периодического обновления плейлиста
function stopPlaylistUpdates(streamKey) {
  try {
    if (streamKey && playlistUpdateIntervals && playlistUpdateIntervals[streamKey]) {
      clearInterval(playlistUpdateIntervals[streamKey]);
      delete playlistUpdateIntervals[streamKey];
      console.log(`⏹️ Остановлено обновление плейлиста для ${streamKey}`);
    } else {
      console.log(`ℹ️ Нет активного интервала обновления плейлиста для ${streamKey}`);
    }
  } catch (error) {
    console.warn(`⚠️ Ошибка при остановке обновления плейлиста для ${streamKey}:`, error);
  }
}

module.exports = {
  startPlaylistUpdates,
  stopPlaylistUpdates
};
