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
const recording = require('./recording');
const errorLog = require('./errorLog');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// Отсюда плейлист и сегменты раздаёт nginx (location /live/ в
// ops/nginx/takebana.conf), а локально — express.static в app.js: зритель
// забирает /live/<streamKey>/index.m3u8.
const HLS_ROOT = path.join(__dirname, '..', 'media', 'live');

// Адрес CDN перед /live/ — HLS_BASE_URL, например https://live.takebana.com.
// Пусто — зритель берёт поток со своего домена. Кривое значение не должно
// оставить зрителей без видео: предупреждаем и отдаём со своего домена.
function readHlsBase(value) {
    if (!value) return '';
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('не http(s)');
        return url.origin + url.pathname.replace(/\/+$/, '');
    } catch (e) {
        console.error(`[hls] HLS_BASE_URL не разобран (${e.message}), поток отдаётся со своего домена: ${value}`);
        return '';
    }
}
const hlsBase = readHlsBase(process.env.HLS_BASE_URL);

const SEGMENT_SECONDS = 2;
const PLAYLIST_SEGMENTS = 6;   // ~12 секунд в плейлисте: меньше — старт рвётся
const RESTART_DELAY_MS = 2000;
const MAX_RESTARTS = 5;        // дальше молчим: чинить надо не перезапуском

// Транскод 1080p60 → 720p30 на vCPU сервера (KVM 4) — 0,78 ядра на один эфир,
// три одновременно — 2,04 ядра, все в реальном времени (замер 15.09.2026).
// Три эфира оставляют Node, Mongo и nginx два ядра из четырёх.
//
// Сверх этого числа видео раньше копировалось. Так больше нельзя: копия идёт
// мимо фильтров, то есть без водяного знака, а знак обязателен на всяком
// видео (требование по товарному знаку, 17.09.2026). Поэтому четвёртый и
// дальнейшие эфиры кодируются облегчённо — 480p и меньше битрейт: хуже
// картинка, но знак на месте и сервер жив. Цена профиля на сервере
// не замерена, замер — вместе со следующим нагрузочным прогоном.
const MAX_FULL_TRANSCODES = 3;

const PROFILES = {
    full: { height: 720, bitrate: '2500k', preset: 'veryfast', watermarkHeight: 54 },
    lite: { height: 480, bitrate: '1200k', preset: 'ultrafast', watermarkHeight: 38 },
};

// Знак — готовый PNG с прозрачностью, собран из public/img/logo.svg. Кладём
// в кадр при кодировании: наложение поверх плеера снималось бы вместе
// со страницей, а из кадра его так просто не убрать. Правый верхний угол:
// там реже всего оказывается лицо ведущего и подписи.
// Файл и размеры знака — utils/watermark.js, общий на все медиа.
const { WATERMARK, WATERMARK_MARGIN } = require('./watermark');

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

// Видео пережимаем всегда. Во-первых, при копировании сегмент режется только
// по ключевому кадру OBS: при интервале «авто» это 8,3 с вместо двух —
// задержка под полминуты. Во-вторых, водяной знак кладётся в кадр, а это
// возможно только при кодировании. Выход заодно не зависит от настроек
// вещателя: не больше 720p и 30 кадров (вниз, без растяжения), 2500 кбит/с —
// на эту цифру посчитан трафик CDN. -fpsmax есть с ffmpeg 4.4, на сервере
// 4.4.2 из apt.
//
// Знак — второй вход ffmpeg. Высота у него в пикселях, а не долей кадра:
// доля потребовала бы scale2ref, а его в новых сборках ffmpeg уже нет,
// и конвейер сломался бы при следующем обновлении сервера.
//
// Звук пережимаем в AAC всегда — HLS на iOS другой не принимает, а
// перекодирование одной аудиодорожки стоит доли процента ядра.
function videoArgs(profile) {
    const p = PROFILES[profile];
    return [
        '-i', WATERMARK,
        '-filter_complex',
        `[0:v]scale=-2:'min(${p.height},ih)'[v];` +
        `[1:v]scale=-1:${p.watermarkHeight}[wm];` +
        `[v][wm]overlay=W-w-${WATERMARK_MARGIN}:${WATERMARK_MARGIN}[out]`,
        '-fpsmax', '30',
        '-c:v', 'libx264', '-preset', p.preset, '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
        '-b:v', p.bitrate, '-maxrate', p.bitrate, '-bufsize', String(parseInt(p.bitrate, 10) * 2) + 'k',
        '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`, '-sc_threshold', '0',
    ];
}

// Выход — tee: один раз закодированный поток уходит и в HLS, и в кусок
// записи эфира (utils/recording.js). Отдельный второй выход ffmpeg кодировал
// бы видео заново — ещё 0,78 ядра на эфир. Кусок — MPEG-TS: оборванный на
// середине, он всё равно читается. onfail=ignore — сбой записи (кончился
// диск) не останавливает эфир.
//
// hls: omit_endlist — плейлист остаётся «живым»; delete_segments — диск не
// растёт; independent_segments — обязательное условие проигрывания на iOS.
// Номера сегментов — от секунд эпохи, а не с нуля. Сегмент кэшируется на час
// (браузер, CDN), и с нуля новый эфир или перезапуск ffmpeg писали бы
// seg00000.ts под тем же адресом — зритель получал бы кусок прошлого эфира.
// Номер в плейлисте заодно только растёт.
function ffmpegArgs(streamKey, dir, profile, part) {
    const hlsOut = '[f=hls' +
        `:hls_time=${SEGMENT_SECONDS}` +
        `:hls_list_size=${PLAYLIST_SEGMENTS}` +
        ':hls_flags=delete_segments+omit_endlist+independent_segments' +
        ':hls_start_number_source=epoch' +
        ':hls_segment_type=mpegts' +
        `:hls_segment_filename=${path.join(dir, 'seg%05d.ts')}]` +
        path.join(dir, 'index.m3u8');

    return [
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-fflags', 'nobuffer',
        '-i', `rtmp://127.0.0.1:1935/live/${streamKey}`,

        ...videoArgs(profile),
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',

        // tee сам потоки не выбирает: без -map ffmpeg не знает, что ему отдать.
        // Видео берём с выхода фильтра — там оно уже со знаком.
        '-map', '[out]', '-map', '0:a?',
        '-f', 'tee',
        part ? `${hlsOut}|[f=mpegts:onfail=ignore]${part}` : hlsOut,
    ];
}

function spawnFfmpeg(streamKey, job) {
    const dir = dirFor(streamKey);
    // Каждый запуск — новый кусок записи: после паузы и перезапуска тоже.
    const part = recording.newPart(streamKey);
    const proc = spawn(FFMPEG, ffmpegArgs(streamKey, dir, job.profile, part), { stdio: ['ignore', 'ignore', 'pipe'] });
    job.proc = proc;

    proc.stderr.on('data', (chunk) => {
        console.error(`[hls ${streamKey}] ${String(chunk).trim()}`);
    });

    // ENOENT здесь означает «ffmpeg не установлен» — перезапуск не поможет.
    proc.on('error', (err) => {
        errorLog.media(err, 'hls.spawn', { streamKey, ffmpeg: FFMPEG });
        job.restarts = MAX_RESTARTS;
    });

    proc.on('close', (code, signal) => {
        if (job.stopping) {
            finish(streamKey, job);
            clean(dir);
            return;
        }

        // Эфир идёт, а ffmpeg вышел — обрыв связи с RTMP или сбой кодека.
        if (job.restarts >= MAX_RESTARTS) {
            errorLog.media(new Error(`ffmpeg падает подряд ${MAX_RESTARTS} раз, транскод остановлен`), 'hls.restarts', { streamKey, code });
            finish(streamKey, job);
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
        errorLog.media(e, 'hls.dir', { streamKey });
        return;
    }
    // Сегменты прошлого эфира: плеер иначе подхватит их как начало текущего.
    clean(dir);

    // Без файла знака эфир не начинаем: видео без знака отдавать нельзя,
    // а молча продолжить — значит нарушить это правило незаметно.
    if (!fs.existsSync(WATERMARK)) {
        errorLog.media(new Error(`нет файла водяного знака ${WATERMARK}`), 'hls.watermark', { streamKey });
        return;
    }

    // Останавливаемый конвейер уже не в счёте: его ffmpeg выходит до 5 с.
    let full = 0;
    for (const j of jobs.values()) if (j.profile === 'full' && !j.stopping) full++;
    const profile = full < MAX_FULL_TRANSCODES ? 'full' : 'lite';

    const job = { proc: null, restarts: 0, stopping: false, timer: null, profile };
    job.done = new Promise((resolve) => { job.resolve = resolve; });
    jobs.set(streamKey, job);
    spawnFfmpeg(streamKey, job);
    console.log(`[hls ${streamKey}] транскод ${PROFILES[profile].height}p со знаком${profile === 'lite' ? ' (лимит полных транскодов)' : ''} → /live/${streamKey}/index.m3u8`);
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
        finish(streamKey, job);
        clean(dirFor(streamKey));
    }
    console.log(`[hls ${streamKey}] остановлен`);
}

function finish(streamKey, job) {
    if (jobs.get(streamKey) === job) jobs.delete(streamKey);
    job.resolve();
}

// Конвейер эфира остановлен и ffmpeg вышел: куски записи закрыты.
function stopped(streamKey) {
    const job = jobs.get(streamKey);
    return job ? job.done : Promise.resolve();
}

function isRunning(streamKey) {
    return jobs.has(streamKey);
}

// Знак и отступ — ещё и видео галереи (utils/galleryVideo.js): один знак на всё видео сайта.
module.exports = { start, stop, stopped, isRunning, HLS_ROOT, hlsBase };
