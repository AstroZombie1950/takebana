// RTMP → HLS: ffmpeg под нашим управлением.
//
// Встроенный `trans` из node-media-server не используем. В установленной 2.7.4
// NodeTransServer.run() в последней строке логирует необъявленную `version`, а
// getFFmpegVersion, которую он импортирует из node_core_utils, там не
// экспортируется вовсе. run() асинхронный и вызывается без catch — в Node 24
// необработанный reject завершает процесс, то есть включение `trans` уронило бы
// приложение при первой же публикации.
//
// Своя обвязка попутно даёт то, что понадобится на этапе 3: свой каталог, свои
// флаги, перезапуск при обрыве и раздача сегментов мимо Node.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isPlainFileName } = require('./safePath');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// Отсюда плейлист и сегменты раздаёт nginx (location /live/ в
// ops/nginx/takebana.conf), а локально — express.static в app.js: зритель
// забирает /live/<streamKey>/index.m3u8.
const HLS_ROOT = path.join(__dirname, '..', 'media', 'live');

const SEGMENT_SECONDS = 2;
const PLAYLIST_SEGMENTS = 6;   // ~12 секунд в плейлисте: меньше — старт рвётся
const RESTART_DELAY_MS = 2000;
const MAX_RESTARTS = 5;        // дальше молчим: чинить надо не перезапуском

// Транскод 720p30 стоит ~0,25 ядра M2 на эфир (вход 1080p или 60 fps —
// до 0,4), на vCPU сервера — примерно вдвое больше. Три эфира оставляют
// Node и Mongo минимум ядро из четырёх. Сверх лимита видео копируется.
const MAX_TRANSCODES = 3;

// streamKey -> { proc, restarts, stopping, timer, transcode }
const jobs = new Map();

function dirFor(streamKey) {
    return path.join(HLS_ROOT, streamKey);
}

// Чистим только своё: плейлист и сегменты. Каталог не удаляем — его может
// держать открытым отдающий процесс.
function clean(dir) {
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return;
    }
    for (const name of files) {
        if (!name.endsWith('.ts') && !name.endsWith('.m3u8')) continue;
        try {
            fs.unlinkSync(path.join(dir, name));
        } catch { /* уже удалён или занят — не мешает */ }
    }
}

// Видео пережимаем, потому что при копировании сегмент режется только по
// ключевому кадру OBS: при интервале «авто» это 8,3 с вместо двух — задержка
// под полминуты. Заодно выход не зависит от настроек вещателя: не больше 720p
// и 30 кадров (вниз, без растяжения), 2500 кбит/с — на эту цифру посчитан
// трафик CDN. -fpsmax есть с ffmpeg 4.4, на сервере 4.4.2 из apt.
//
// Звук пережимаем в AAC всегда — HLS на iOS другой не принимает, а
// перекодирование одной аудиодорожки стоит доли процента ядра.
const VIDEO_TRANSCODE = [
    '-vf', "scale=-2:'min(720,ih)'", '-fpsmax', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
    '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`, '-sc_threshold', '0',
];

function ffmpegArgs(streamKey, dir, transcode) {
    return [
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-fflags', 'nobuffer',
        '-i', `rtmp://127.0.0.1:1935/live/${streamKey}`,

        ...(transcode ? VIDEO_TRANSCODE : ['-c:v', 'copy']),
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',

        '-f', 'hls',
        '-hls_time', String(SEGMENT_SECONDS),
        '-hls_list_size', String(PLAYLIST_SEGMENTS),
        // omit_endlist — плейлист остаётся «живым»; delete_segments — диск не растёт;
        // independent_segments — обязательное условие проигрывания на iOS.
        '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
        path.join(dir, 'index.m3u8'),
    ];
}

function spawnFfmpeg(streamKey, job) {
    const dir = dirFor(streamKey);
    const proc = spawn(FFMPEG, ffmpegArgs(streamKey, dir, job.transcode), { stdio: ['ignore', 'ignore', 'pipe'] });
    job.proc = proc;

    proc.stderr.on('data', (chunk) => {
        console.error(`[hls ${streamKey}] ${String(chunk).trim()}`);
    });

    // ENOENT здесь означает «ffmpeg не установлен» — перезапуск не поможет.
    proc.on('error', (err) => {
        console.error(`[hls ${streamKey}] ffmpeg не запустился (${FFMPEG}): ${err.message}`);
        job.restarts = MAX_RESTARTS;
    });

    proc.on('close', (code, signal) => {
        if (job.stopping) {
            jobs.delete(streamKey);
            clean(dir);
            return;
        }

        // Эфир идёт, а ffmpeg вышел — обрыв связи с RTMP или сбой кодека.
        if (job.restarts >= MAX_RESTARTS) {
            console.error(`[hls ${streamKey}] ffmpeg падает подряд ${MAX_RESTARTS} раз, останавливаемся`);
            jobs.delete(streamKey);
            return;
        }

        job.restarts++;
        console.warn(`[hls ${streamKey}] ffmpeg завершился (code=${code} signal=${signal}), перезапуск ${job.restarts}/${MAX_RESTARTS}`);
        job.timer = setTimeout(() => spawnFfmpeg(streamKey, job), RESTART_DELAY_MS);
    });
}

// Запускается на postPublish, то есть после проверки подписи и ключа.
function start(streamKey) {
    if (!isPlainFileName(streamKey)) {
        console.error(`[hls] некорректный streamKey, транскод не запущен: ${streamKey}`);
        return;
    }
    if (jobs.has(streamKey)) return;

    const dir = dirFor(streamKey);
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
        console.error(`[hls ${streamKey}] не создать каталог ${dir}: ${e.message}`);
        return;
    }
    // Сегменты прошлого эфира: плеер иначе подхватит их как начало текущего.
    clean(dir);

    // Останавливаемый конвейер уже не в счёте: его ffmpeg выходит до 5 с.
    let transcoding = 0;
    for (const j of jobs.values()) if (j.transcode && !j.stopping) transcoding++;
    const transcode = transcoding < MAX_TRANSCODES;

    const job = { proc: null, restarts: 0, stopping: false, timer: null, transcode };
    jobs.set(streamKey, job);
    spawnFfmpeg(streamKey, job);
    console.log(`[hls ${streamKey}] ${transcode ? 'транскод' : 'копирование видео, лимит транскодов'} → /live/${streamKey}/index.m3u8`);
}

function stop(streamKey) {
    const job = jobs.get(streamKey);
    if (!job) return;

    job.stopping = true;
    if (job.timer) clearTimeout(job.timer);

    if (job.proc && job.proc.exitCode === null) {
        job.proc.kill('SIGTERM');
        // Обработчик close снимет job и подчистит каталог. Если ffmpeg завис на
        // записи — добиваем, иначе процесс останется висеть до конца жизни Node.
        setTimeout(() => {
            if (job.proc && job.proc.exitCode === null) job.proc.kill('SIGKILL');
        }, 5000).unref();
    } else {
        jobs.delete(streamKey);
        clean(dirFor(streamKey));
    }
    console.log(`[hls ${streamKey}] остановлен`);
}

function isRunning(streamKey) {
    return jobs.has(streamKey);
}

module.exports = { start, stop, isRunning, HLS_ROOT };
