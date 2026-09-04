const NodeMediaServer = require('node-media-server');
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });


const fs = require('fs');

const config = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 10,
    ping_timeout: 30
  },
  http: {
    port: 8000,
    mediaroot: './media',
    allow_origin: '*'
  },
  log: {
    level: 3, // 0=error, 1=warn, 2=info, 3=debug
    file: './media/server.log' // Файл для записи логов
  }
};

const nms = new NodeMediaServer(config);
const activeStreams = new Map();
let ioRef = null;

function setIO(io) {
  ioRef = io;
}

async function markObsStreamStarted(streamKey) {
  try {
    const Stream = require('./models/Stream');
    const updated = await Stream.findOneAndUpdate(
      { streamKey },
      {
        streamType: 'obs-stream',
        streamProvider: 'obs',
        isActive: true,
        startedAt: new Date(),
        updatedAt: Date.now()
      },
      { new: true }
    ).lean();
    if (ioRef) {
      ioRef.to(`stream:${streamKey}`).emit('stream:update', {
        streamKey,
        streamType: 'obs-stream',
        streamProvider: 'obs',
        isActive: true
      });
    }
    return updated;
  } catch (e) {
    console.error('[mediaServer] markObsStreamStarted error:', e?.message || e);
    return null;
  }
}

async function markObsStreamEnded(streamKey) {
  try {
    const Stream = require('./models/Stream');
    const updated = await Stream.findOneAndUpdate(
      { streamKey },
      {
        isActive: false,
        startedAt: null,
        updatedAt: Date.now()
      },
      { new: true }
    ).lean();
    if (ioRef) {
      ioRef.to(`stream:${streamKey}`).emit('stream:update', {
        streamKey,
        isActive: false
      });
    }
    return updated;
  } catch (e) {
    console.error('[mediaServer] markObsStreamEnded error:', e?.message || e);
    return null;
  }
}

// Обработчики событий
nms.on('prePublish', (id, streamPath, args) => {
    console.log(`[INFO] Stream is starting: ${streamPath} with ID: ${id}`);
    const streamKey = streamPath.split('/')[2];
    activeStreams.set(streamKey, {
        id,
        startTime: new Date(),
        isLive: true
    });
    // OBS publish detected -> mark stream active in DB and notify viewers
    markObsStreamStarted(streamKey);
});

nms.on('donePublish', (id, streamPath, args) => {
    console.log(`[INFO] Stream has ended: ${streamPath}`);
    const streamKey = streamPath.split('/')[2];
    activeStreams.delete(streamKey);
    markObsStreamEnded(streamKey);
});

nms.on('error', (err) => {
    console.error(`[ERROR] ${err.message}`);
});

nms.run();

// Экспортируем необходимые объекты
module.exports = {
    nms,
    activeStreams,
    setIO
};