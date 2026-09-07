// Прокси на node-media-server (порт 8000).
//
// Монтируется до сессий: это поток видео, сессия ему не нужна, а лишний разбор
// cookie на каждом сегменте — бесполезная работа. На проде запросы к /live/
// идут мимо приложения, прямо на медиасервер (см. ops/nginx/takebana.conf);
// этот прокси нужен для локальной разработки и как запасной путь.

// Прокси для HLS файлов от Node Media Server (порт 8000) через Express (порт 3000)
// Это решает проблему Mixed Content (HTTPS страница не может загружать HTTP ресурсы)
const http = require('http');

const liveProxy = (req, res, next) => {
  // Проксируем запросы к Node Media Server на порту 8000.
  // ВАЖНО: используем originalUrl, чтобы сохранить префикс `/live/...`,
  // иначе NodeMediaServer будет искать стрим по неверному streamPath.
  const targetUrl = `http://localhost:8000${req.originalUrl}`;

  // Успешные запросы не логируем: сюда приходит каждый сегмент и каждое
  // обновление плейлиста. Ошибки ниже остаются — они редки и нужны.
  const proxyReq = http.get(targetUrl, (proxyRes) => {
    if (proxyRes.statusCode === 404) {
      console.error(`[Media Proxy] 404 Not Found: ${targetUrl}`);
      console.error(`[Media Proxy] Check if Node Media Server is running and stream path is correct`);
    }
    
    // Копируем заголовки
    res.set({
      'Content-Type': proxyRes.headers['content-type'] || 'application/vnd.apple.mpegurl',
      'Cache-Control': proxyRes.headers['cache-control'] || 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range',
      'Accept-Ranges': 'bytes'
    });
    
    res.status(proxyRes.statusCode);
    
    // Пересылаем данные
    proxyRes.pipe(res);
    
    proxyRes.on('error', (err) => {
      console.error(`[HLS Proxy] Error in response stream:`, err.message);
    });
  });
  
  proxyReq.on('error', (err) => {
    console.error(`[Media Proxy] Error proxying ${req.originalUrl}:`, err.message);
    console.error(`[Media Proxy] Check if Node Media Server is running on port 8000`);
    if (!res.headersSent) {
      // Для live FLV часто "ошибка" означает, что поток ещё не опубликован,
      // или NMS перезапускается. Не хотим пугать 502 на клиенте.
      const isFlv = String(req.path || '').toLowerCase().endsWith('.flv');
      if (isFlv) {
        res.status(404).end();
      } else {
        res.status(502).json({ error: 'Media server unavailable', path: req.path, message: err.message });
      }
    }
  });
  
  req.on('aborted', () => {
    // Обрыв — штатное дело для плеера: перемотка, уход со страницы. Не логируем.
    proxyReq.abort();
  });
  
  // ВАЖНО: `.flv` — это долгоживущее соединение (live stream).
  // Таймауты подходят для плейлистов/сегментов, но ломают FLV.
  const isFlv = String(req.path || '').toLowerCase().endsWith('.flv');
  if (isFlv) {
    // Отключаем таймаут полностью для live FLV
    proxyReq.setTimeout(0);
    // Нельзя кэшировать live поток
    if (!res.headersSent) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  } else {
    // Таймаут для коротких запросов (HLS плейлист/сегменты)
    proxyReq.setTimeout(5000, () => {
      console.error(`[Media Proxy] Timeout for ${req.originalUrl}`);
      proxyReq.abort();
      if (!res.headersSent) {
        res.status(504).json({ error: 'Media server timeout', path: req.path });
      }
    });
  }
};

module.exports = { liveProxy };
