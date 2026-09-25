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

// Транскод 1080p60 → 720p30 на vCPU сервера (KVM 4) — 0,78 ядра на один эфир
// (замер 15.09.2026).
//
// Несколько качеств (решение 25.09.2026): 720p, 480p и 360p одним ffmpeg,
// плеер выбирает сам — телефон и слабая сеть берут меньшее, и трафик CDN
// падает. Нижние кодируются быстрее (superfast). Замер 25.09 на одном
// видео, в долях от одного 720p: 720/480/360 одним пресетом — 1,60, с
// быстрыми нижними — 1,44, 720+360 — 1,17. Взяли 1,44: на сервере это
// ~1,12 ядра на эфир. Поэтому полных эфиров одновременно два, а не три,
// как было с одним качеством: 2 × 1,12 ≈ 3 × 0,78, Node, Mongo и nginx
// по-прежнему остаются два ядра из четырёх.
//
// Сверх этого числа видео раньше копировалось. Так больше нельзя: копия идёт
// мимо фильтров, то есть без водяного знака, а знак обязателен на всяком
// видео (требование по товарному знаку, 17.09.2026). Поэтому дальнейшие
// эфиры кодируются облегчённо — одно качество 480p: хуже картинка, но знак
// на месте и сервер жив. По тому же замеру 0,54 от 720p, ~0,42 ядра.
const MAX_FULL_TRANSCODES = 2;

// Качество — подпапка /live/<ключ>/<высота>/, index.m3u8 в корне эфира —
// общий плейлист со списком качеств: адрес для плеера прежний.
const PROFILES = {
    full: {
        watermarkHeight: 54,
        renditions: [
            { height: 720, bitrate: 2500, preset: 'veryfast' },
            { height: 480, bitrate: 1200, preset: 'superfast' },
            { height: 360, bitrate: 700, preset: 'superfast' },
        ],
    },
    lite: {
        watermarkHeight: 38,
        renditions: [{ height: 480, bitrate: 1200, preset: 'ultrafast' }],
    },
    // Камера заведения (utils/venueCam.js): без записи, 15 кадров — это
    // вид зала, а не эфир. Из VP8 браузера — 0,14 от одного 720p эфира
    // (замер 25.09), ~0,11 ядра, и только пока камеру смотрят.
    venue: {
        watermarkHeight: 38,
        fps: 15,
        exact: true,
        renditions: [{ height: 480, bitrate: 800, preset: 'superfast' }],
    },
};

// Сколько ядер ест конвейер каждого вида — по замерам выше. Сумма больше
// CPU_WARN — пишем в журнал: Node, Mongo и nginx остаются без процессора,
// тормозят и эфиры, и сайт. Повтор — только после спада ниже CPU_CALM.
const CORES = { full: 1.12, lite: 0.42, venue: 0.11 };
const CPU_WARN = 3;
const CPU_CALM = 2.5;
let cpuWarned = false;

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
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        // Подпапки качеств (720, 480, 360) — внутрь, но только их.
        if (e.isDirectory()) {
            if (/^\d+$/.test(e.name)) clean(path.join(dir, e.name));
            continue;
        }
        if (!e.name.endsWith('.ts') && !e.name.endsWith('.m3u8')) continue;
        try {
            fs.unlinkSync(path.join(dir, e.name));
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

// Ровно short по короткой стороне, и вверх тоже. Для камеры заведения:
// браузер меняет размер кадра на ходу, пока оценивает канал (320×180 в
// первые секунды, зонд 25.09), и без этого зритель получал бы то крошечную
// картинку, то плейлист, где размер скачет посреди потока.
function exactScale(short) {
    return `scale='if(gt(iw,ih),-2,${short})':'if(gt(iw,ih),${short},-2)'`;
}

// Знак кладётся один раз, в верхнее качество, — нижние уменьшаются уже
// вместе с ним, как у записей (utils/recordingHls.js). setsar=1: без него
// 1280×720 → 854×480 выходит с неквадратным пикселем (SAR 1280/1281) —
// так было и у облегчённого 480p до 25.09.
// Ключи кодека с номером потока (-b:v:1) — по одному на качество.
function videoArgs(profile) {
    const { renditions, watermarkHeight, exact } = PROFILES[profile];
    let graph = `[0:v]${(exact ? exactScale : fitScale)(renditions[0].height)},setsar=1[v];` +
        `[1:v]scale=-1:${watermarkHeight}[wm];` +
        `[v][wm]overlay=W-w-${WATERMARK_MARGIN}:${WATERMARK_MARGIN}`;
    if (renditions.length === 1) {
        graph += '[v0]';
    } else {
        graph += `,split=${renditions.length}[v0]` + renditions.slice(1).map((_, i) => `[s${i + 1}]`).join('');
        graph += renditions.slice(1).map((r, i) => `;[s${i + 1}]${fitScale(r.height)},setsar=1[v${i + 1}]`).join('');
    }
    const args = [
        '-i', WATERMARK,
        '-filter_complex', graph,
        '-fpsmax', String(PROFILES[profile].fps || 30),
        '-c:v', 'libx264', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
        '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`, '-sc_threshold', '0',
    ];
    renditions.forEach((r, i) => args.push(
        `-preset:v:${i}`, r.preset,
        `-b:v:${i}`, `${r.bitrate}k`, `-maxrate:v:${i}`, `${r.bitrate}k`, `-bufsize:v:${i}`, `${r.bitrate * 2}k`,
    ));
    return args;
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
//
// Качества — var_stream_map: у каждого своя подпапка и свой звук (сборка
// hls.js у зрителя — light, отдельных звуковых дорожек не понимает),
// master_pl_name — общий index.m3u8 в корне эфира. Запись — только верхнее
// качество (select), нижние для неё делает utils/recordingHls.js.
//
// Двоеточие внутри значения — разделитель настроек tee, его экранируем.
// Дважды: tee снимает слой экранирования, деля выходы по «|», и ещё один —
// разбирая настройки выхода. Проверено на 4.4.8 (как на сервере) и 9.
//
// audio: false — у публикации нет звука (бывает у самодельных кодировщиков).
// Без звука карта «v:0,a:0» ломает запуск, поэтому сначала пробуем со звуком,
// а по отказу ffmpeg перезапускаем без него (spawnFfmpeg ниже).
const teeValue = (v) => v.replace(/:/g, '\\\\:');

// input — откуда брать: эфир — с нашего RTMP, камера заведения — RTSP
// MediaMTX с петли (по TCP: UDP-порты RTSP у него выключены).
function inputArgs(streamKey, input) {
    if (input) return ['-rtsp_transport', 'tcp', '-i', input];
    return ['-i', `rtmp://127.0.0.1:1935/live/${streamKey}`];
}

function ffmpegArgs(streamKey, dir, profile, part, audio, input) {
    const { renditions } = PROFILES[profile];
    const variants = renditions.map((r, i) => `v:${i}${audio ? `,a:${i}` : ''},name:${r.height}`).join(' ');
    const hlsOut = '[f=hls' +
        `:hls_time=${SEGMENT_SECONDS}` +
        `:hls_list_size=${PLAYLIST_SEGMENTS}` +
        ':hls_flags=delete_segments+omit_endlist+independent_segments' +
        ':hls_start_number_source=epoch' +
        ':hls_segment_type=mpegts' +
        ':master_pl_name=index.m3u8' +
        `:var_stream_map=${teeValue(variants)}` +
        `:hls_segment_filename=${path.join(dir, '%v', 'seg%05d.ts')}]` +
        path.join(dir, '%v', 'index.m3u8');
    const recordOut = `[select=${teeValue(audio ? 'v:0,a:0' : 'v:0')}:f=mpegts:onfail=ignore]${part}`;

    return [
        // warning, а не error: именно на этом уровне ffmpeg говорит о разъезде
        // меток времени («Non-monotonous DTS», «past duration too large»).
        // С уровнем error такие строки не печатались вовсе, и рассинхрон,
        // на который жалуется зритель, не оставлял следа нигде.
        // Разбор и отсев — в spawnFfmpeg ниже.
        '-nostdin', '-hide_banner', '-loglevel', 'warning',
        '-fflags', 'nobuffer',
        ...inputArgs(streamKey, input),

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
        // Видео берём с выходов фильтра — там оно уже со знаком; звук — по
        // копии на качество.
        ...renditions.flatMap((_, i) => ['-map', `[v${i}]`]),
        ...(audio ? renditions.flatMap(() => ['-map', '0:a']) : []),
        '-f', 'tee',
        part ? `${hlsOut}|${recordOut}` : hlsOut,
    ];
}

// Так ffmpeg отказывает, когда -map 0:a нечего взять: 4.4 пишет
// «Stream map '0:a'…», 9 — «Stream map ''…». Другим картам пустыми
// не бывать — видео берётся с выходов фильтра.
const NO_AUDIO = /Stream map '[^']*' matches no streams/i;

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
    const part = job.input ? null : recording.newPart(streamKey);
    const proc = spawn(FFMPEG, ffmpegArgs(streamKey, dir, job.profile, part, job.audio, job.input), { stdio: ['ignore', 'ignore', 'pipe'] });
    job.proc = proc;
    // О каких видах разъезда уже сказали в этом запуске — чтобы не повторяться.
    job.warned = new Set();

    proc.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (!text) return;
        console.error(`[hls ${streamKey}] ${text}`);

        // Публикация без звука: карта 0:a пуста, ffmpeg не стартует.
        // Перезапуск без звука — сразу и не в счёт обрывов (close ниже).
        if (job.audio && NO_AUDIO.test(text)) job.audio = false;

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

        if (!job.audio && !job.silent) {
            job.silent = true;
            console.warn(`[hls ${streamKey}] в публикации нет звука — эфир без звуковой дорожки`);
            spawnFfmpeg(streamKey, job);
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
        // Камера заведения: вещатель ушёл — ffmpeg видит конец потока раньше,
        // чем MediaMTX скажет об этом (venueCam.unavailable гасит и повтор).
        // Каждый такой уход — не сбой, в журнал только «падает подряд».
        if (!job.input) {
            errorLog.media(new Error(`ffmpeg вышел посреди эфира (code=${code} signal=${signal}), перезапуск ${job.restarts}/${MAX_RESTARTS}`),
                'hls.restart', { streamKey, code, signal, restart: job.restarts });
        }
        job.timer = setTimeout(() => spawnFfmpeg(streamKey, job), RESTART_DELAY_MS);
    });
}

function cpuCheck() {
    let cores = 0;
    const count = {};
    for (const j of jobs.values()) {
        if (j.stopping) continue;
        cores += CORES[j.profile];
        count[j.profile] = (count[j.profile] || 0) + 1;
    }
    if (cores < CPU_CALM) cpuWarned = false;
    if (cpuWarned || cores < CPU_WARN) return;
    cpuWarned = true;
    errorLog.media(new Error(`Перекодирование близко к пределу процессора: ~${cores.toFixed(1)} ядра из 4 (эфиров ${(count.full || 0) + (count.lite || 0)}, камер ${count.venue || 0})`),
        'hls.cpu', { cores, ...count });
}

// Эфир — на postPublish, то есть после проверки подписи и ключа.
// Камера заведения — по готовности потока в MediaMTX (utils/venueCam.js):
// opts.input — его адрес, opts.profile — 'venue'.
function start(streamKey, opts = {}) {
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
    const profile = opts.profile || (full < MAX_FULL_TRANSCODES ? 'full' : 'lite');

    const job = { proc: null, restarts: 0, stopping: false, timer: null, profile, input: opts.input || null, audio: true, silent: false };
    job.done = new Promise((resolve) => { job.resolve = resolve; });
    jobs.set(streamKey, job);
    spawnFfmpeg(streamKey, job);
    cpuCheck();
    console.log(`[hls ${streamKey}] транскод ${PROFILES[profile].renditions.map((r) => r.height + 'p').join('/')} со знаком${profile === 'lite' ? ' (лимит полных транскодов)' : profile === 'venue' ? ' (камера заведения)' : ''} → /live/${streamKey}/index.m3u8`);
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

// Знак и отступ — ещё и видео галереи (utils/galleryVideo.js): один знак на всё видео сайта.
module.exports = { start, stop, stopped, HLS_ROOT, hlsBase };
