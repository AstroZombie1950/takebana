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
//
// ── Расхождение звука и картинки ────────────────────────────────────────────
//
// Заказчик пожаловался на отставание (20.09.2026). В конвейере не было ничего,
// что удерживало бы звук на метках времени видео, и это классический источник
// расхождения: в начале эфира всё ровно, через полчаса звук на секунду впереди.
//
// Откуда берётся. Метки времени приходят по RTMP от чужого кодировщика — OBS
// на чужом компьютере или выход Daily. Часы у него свои, и идут они чуть
// иначе наших: за час набегают доли секунды. Плюс переподключение OBS
// начинает нумерацию заново, а звуковой и видеопоток возобновляются не
// в один миг. Без поправки ffmpeg кодирует звук как есть, тот идёт в своём
// темпе, и разъезд копится.
//
// aresample=async=1000 держит звук на метках времени видео: растягивает или
// поджимает дорожку, но не больше тысячи отсчётов в секунду — это около двух
// сотых процента при 48 кГц, на слух незаметно. Дыру больше этого (после
// обрыва) фильтр закрывает тишиной вместо того, чтобы сдвинуть всё дальнейшее.
// Вмешательство только в звук: картинка, битрейт, размер сегмента и задержка
// остаются ровно прежними — мы ничем не платим за эту правку.
//
// first_pts=0 прижимает начало дорожки к нулю: если звук пошёл позже видео
// (камера просыпается дольше микрофона), начало добивается тишиной, а не
// уезжает вперёд на эту разницу до конца эфира.
const AUDIO_SYNC = 'aresample=async=1000:first_pts=0';

// Ужать по короткой стороне: вертикальный кадр (телефон ведущего, 720×1280)
// остаётся 720×1280, а не 405×720. Только вниз — меньшее не растягиваем.
// Отрицательная сторона из выражения значит «по пропорции» и в ffmpeg 4.4.
function fitScale(short) {
    return `scale='if(gt(iw,ih),-2,min(${short},iw))':'if(gt(iw,ih),min(${short},ih),-2)'`;
}

function videoArgs(profile) {
    const p = PROFILES[profile];
    return [
        '-i', WATERMARK,
        '-filter_complex',
        `[0:v]${fitScale(p.height)}[v];` +
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
        // warning, а не error: именно на этом уровне ffmpeg говорит о разъезде
        // меток времени («Non-monotonous DTS», «past duration too large»).
        // С уровнем error такие строки не печатались вовсе, и рассинхрон,
        // на который жалуется зритель, не оставлял следа нигде.
        // Разбор и отсев — в spawnFfmpeg ниже.
        '-nostdin', '-hide_banner', '-loglevel', 'warning',
        '-fflags', 'nobuffer',
        '-i', `rtmp://127.0.0.1:1935/live/${streamKey}`,

        ...videoArgs(profile),
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-af', AUDIO_SYNC,

        // Очередь мультиплексора. Когда одна дорожка обгоняет другую (а после
        // обрыва RTMP это норма), ffmpeg копит пакеты опережающей, пока не
        // дождётся отстающей. Упёршись в предел по умолчанию, он не ждёт,
        // а выходит с ошибкой — то есть эфир обрывается у всех зрителей
        // и перезапускается. Тысяча пакетов — это доли секунды видео;
        // памяти стоит копейки, а перезапуск стоит всего эфира.
        '-max_muxing_queue_size', '1024',

        // tee сам потоки не выбирает: без -map ffmpeg не знает, что ему отдать.
        // Видео берём с выхода фильтра — там оно уже со знаком.
        '-map', '[out]', '-map', '0:a?',
        '-f', 'tee',
        part ? `${hlsOut}|[f=mpegts:onfail=ignore]${part}` : hlsOut,
    ];
}

// Строки ffmpeg, по которым видно, что звук и картинка разъезжаются.
// Порядок важен: срабатывает первое совпадение.
//
//   dts     — метки времени пришли не по возрастанию: сбился кодировщик
//             или было переподключение. Самый частый предвестник рассинхрона.
//   drift   — ffmpeg сам сообщает, что правит расхождение (это работает
//             aresample); единичное — норма, постоянное — повод смотреть сеть.
//   frames  — кадры дублируются или выбрасываются пачками: вещатель не
//             вытягивает свой же битрейт.
//   queue   — одна дорожка ушла далеко вперёд другой.
const TIMING = [
    ['dts', /non-?monotonou?s dts|invalid, non-?monotonic/i],
    ['drift', /timestamp discontinuity|first_pts|audio timestamp|clipping/i],
    ['frames', /past duration too large|dup(licate)? \d+ frames|drop(ping)? \d+ frames/i],
    ['queue', /too many packets buffered|muxing queue/i],
];

function spawnFfmpeg(streamKey, job) {
    const dir = dirFor(streamKey);
    // Каждый запуск — новый кусок записи: после паузы и перезапуска тоже.
    const part = recording.newPart(streamKey);
    const proc = spawn(FFMPEG, ffmpegArgs(streamKey, dir, job.profile, part), { stdio: ['ignore', 'ignore', 'pipe'] });
    job.proc = proc;
    // О каких видах разъезда уже сказали в этом запуске — чтобы не повторяться.
    job.warned = new Set();

    proc.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (!text) return;
        console.error(`[hls ${streamKey}] ${text}`);

        // Про метки времени ffmpeg говорит строками, а не кодом выхода, и
        // повторяет их сотнями раз за эфир. В журнал — по одной на эфир
        // и по виду: журнал группирует по отпечатку, но сто одинаковых записей
        // в минуту всё равно ни к чему, а счётчик группы должен считать эфиры,
        // а не кадры. Что именно ищем — TIMING ниже.
        for (const [kind, rx] of TIMING) {
            if (!rx.test(text)) continue;
            if (job.warned.has(kind)) break;
            job.warned.add(kind);
            errorLog.media(new Error(`ffmpeg: ${kind} — ${text.split('\n')[0].slice(0, 200)}`),
                'hls.timing', { streamKey, kind, profile: job.profile });
            break;
        }
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
        // В журнал — каждый перезапуск, а не только последний. Один перезапуск
        // это пять секунд без картинки у всех зрителей сразу: зритель уходит,
        // ведущий уверен, что «сайт лагает», и никто об этом не говорит.
        // Раньше запись появлялась только после третьего подряд.
        errorLog.media(new Error(`ffmpeg вышел посреди эфира (code=${code} signal=${signal}), перезапуск ${job.restarts}/${MAX_RESTARTS}`),
            'hls.restart', { streamKey, code, signal, restart: job.restarts });
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
