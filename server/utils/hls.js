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
const streamLog = require('./streamLog');

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
// Что сверх этого числа — зависит от того, где водяной знак
// (utils/streamWatermark.js, настройка в панели):
//   — знак поверх плеера: видео копируется как пришло — одно качество,
//     процессора почти не ест, эфиров одновременно — десятки;
//   — знак в кадре: копия шла бы мимо фильтров, то есть без знака, поэтому
//     дальнейшие эфиры кодируются облегчённо — одно качество 480p, по тому
//     же замеру 0,54 от 720p, ~0,42 ядра. Хуже картинка, но знак на месте
//     и сервер жив — до четвёртого-пятого эфира.
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
    // Копия без перекодирования — только когда знак поверх плеера. Сегмент
    // режется по ключевому кадру вещателя: у OBS с интервалом «авто» это
    // 8,3 с вместо двух, и задержка растёт до полуминуты. Битрейт и размер
    // кадра — какие прислал вещатель. Подпапка — src: высоты мы не знаем.
    copy: {
        copy: true,
        renditions: [{ height: 'src' }],
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
// У копии — только звук и упаковка в сегменты. Знак в кадре добавляет
// к полному меньше процента — процессор ест пережатие, а не знак (30.09).
// full и copy — замер 02.10 на боевом сервере (AMD EPYC 9354P, ffmpeg 4.4),
// 60 с вертикального 720×1280 с шумом как у камеры, в реальном времени:
// полный — 0,87 ядра, копия — 0,08, из них 0,06 — кодирование звука AAC
// (копия со звуком без пережатия — 0,013).
const CORES = { full: 0.87, lite: 0.42, venue: 0.11, copy: 0.08 };
// Звук копией (веб-эфир, ниже) — без пережатия AAC.
const AUDIO_CORES = 0.06;
// Сколько ядер из четырёх отдаём живым эфирам — остальное Node, базе,
// nginx и очереди записей (nice 19).
const LIVE_CORES = 3;
const CPU_WARN = 3;
const CPU_CALM = 2.5;
let cpuWarned = false;

// Знак — готовый PNG с прозрачностью, собран из public/img/logo.svg. В кадре
// его так просто не убрать, поверх плеера он снимается вместе со страницей;
// что выбрано — utils/streamWatermark.js. Правый верхний угол: там реже
// всего оказывается лицо ведущего и подписи.
// Файл и размеры знака — utils/watermark.js, общий на все медиа.
const { WATERMARK, WATERMARK_MARGIN } = require('./watermark');
const streamWatermark = require('./streamWatermark');

// streamKey -> { proc, restarts, stopping, timer, profile, mark, … }
const jobs = new Map();

// Режим конвейера закреплён за эфиром, а не за запуском ffmpeg. Обрыв выхода
// Daily останавливает конвейер, и через секунды он запускается заново. До
// 02.10 режим при этом выбирался с нуля: эфир, пока переподключался, отдавал
// своё место полного транскода другому и возвращался копией (b5df47de,
// 01.10 19:05). Плейлист менял состав качеств, и плеер айфона на этом вставал
// кружком. Теперь место держится за эфиром HOLD_MS — но только когда
// конвейер остановлен обрывом выхода Daily (stop с hold, mediaServer.js).
// Любая другая остановка — конец эфира, пауза, модерация, уборка, OBS
// отключился — закрепление снимает: иначе следующий эфир с тем же ключом
// унаследовал бы прежний режим знака и шёл бы без знака в кадре, когда
// панель уже включила «в кадре» (зонд водяного знака, 02.10).
// streamKey -> { profile, mark, until }
const held = new Map();
const HOLD_MS = 10 * 60 * 1000;

function heldFor(streamKey) {
    const h = held.get(streamKey);
    if (h && h.until > Date.now()) return h;
    if (h) held.delete(streamKey);
    return null;
}

function release(streamKey) {
    held.delete(streamKey);
}

// Плейлист появился: ffmpeg пишет index.m3u8 после первых сегментов. Это
// миг, когда зритель может начать смотреть, — в хронологию эфира, со
// временем от запуска. Не появился за READY_MS — тоже событие.
const READY_MS = 60 * 1000;

// Хронология: эфира — его отрезок (utils/streamLog.js), камеры заведения —
// её сеанс (opts.log из utils/venueCam.js → utils/venueLog.js).
const note = (streamKey, job, e, d) => (job.log ? job.log(e, d) : streamLog.event(streamKey, e, d));

function watchReady(streamKey, job) {
    const t0 = Date.now();
    const file = path.join(dirFor(streamKey), 'index.m3u8');
    const tick = () => {
        if (job.stopping || jobs.get(streamKey) !== job) return;
        if (fs.existsSync(file)) return note(streamKey, job, 'hls.ready', { ms: Date.now() - t0 });
        if (Date.now() - t0 > READY_MS) return note(streamKey, job, 'hls.late', { ms: READY_MS });
        setTimeout(tick, 500).unref();
    };
    setTimeout(tick, 500).unref();
}

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
        // Подпапки качеств (720, 480, 360, src у копии) — внутрь, но только их.
        if (e.isDirectory()) {
            if (/^(\d+|src)$/.test(e.name)) clean(path.join(dir, e.name));
            continue;
        }
        if (!e.name.endsWith('.ts') && !e.name.endsWith('.m3u8')) continue;
        try {
            fs.unlinkSync(path.join(dir, e.name));
        } catch { /* уже удалён или занят — не мешает */ }
    }
}

// Пережимаем, пока хватает процессора, а при знаке в кадре — всегда.
// Во-первых, при копировании сегмент режется только по ключевому кадру OBS:
// при интервале «авто» это 8,3 с вместо двух — задержка под полминуты.
// Во-вторых, знак в кадр кладётся только при кодировании. Выход заодно не
// зависит от настроек вещателя: не больше 720p и 30 кадров (вниз, без
// растяжения), 2500 кбит/с — на эту цифру посчитан трафик CDN. -fpsmax есть
// с ffmpeg 4.4, на сервере 4.4.2 из apt.
//
// Знак — второй вход ffmpeg. Высота у него в пикселях, а не долей кадра:
// доля потребовала бы scale2ref, а его в новых сборках ffmpeg уже нет,
// и конвейер сломался бы при следующем обновлении сервера.
//
// Звук пережимаем в AAC всегда — HLS на iOS другой не принимает. Стоит это
// 0,06 ядра на эфир (замер 02.10; быстрый кодер -aac_coder fast — 0,055):
// при 50 копиях — три ядра из четырёх, это главная цена копии.
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

// Камере заведения first_pts=0 вредит (STATUS, 4 октября). Айфон, вернувшись
// из фона, отдаёт новый микрофон, и формат звука меняется посреди потока
// (моно ↔ стерео): ffmpeg пересобирает фильтр, а с first_pts=0 метки звука
// начинаются заново с нуля. Мультиплексор прижимает каждый пакет к прежней
// метке — звук сломан на столько, сколько камера шла до этого (29.09 — 10
// и 100 с, «Non-monotonous DTS … current: 320»). Выравнивать начало камере
// незачем: звук и картинка идут от одного вещателя через MediaMTX с общей
// шкалой. Эфиру смена формата не грозит: OBS при этом переподключается,
// веб-эфир берёт звук копией.
const AUDIO_SYNC_VENUE = 'aresample=async=1000';

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
// inFrame — класть ли знак: false, когда он поверх плеера.
function videoArgs(profile, inFrame) {
    const { renditions, watermarkHeight, exact } = PROFILES[profile];
    let graph = `[0:v]${(exact ? exactScale : fitScale)(renditions[0].height)},setsar=1`;
    if (inFrame) {
        graph += `[v];[1:v]scale=-1:${watermarkHeight}[wm];` +
            `[v][wm]overlay=W-w-${WATERMARK_MARGIN}:${WATERMARK_MARGIN}`;
    }
    if (renditions.length === 1) {
        graph += '[v0]';
    } else {
        graph += `,split=${renditions.length}[v0]` + renditions.slice(1).map((_, i) => `[s${i + 1}]`).join('');
        graph += renditions.slice(1).map((r, i) => `;[s${i + 1}]${fitScale(r.height)},setsar=1[v${i + 1}]`).join('');
    }
    const args = [
        ...(inFrame ? ['-i', WATERMARK] : []),
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

// audioCopy — звук как пришёл, без пережатия и без синхронизации: у веб-эфира
// (решение Ивана 02.10). Его звук собирает выход Daily на своём сервере —
// часы ровные, AAC, разъезжаться нечему; а пережатие AAC стоит 0,06 ядра
// на эфир, при 50 эфирах — почти три ядра из четырёх. У OBS (чужой
// компьютер, свои часы, переподключения) — пережатие с aresample, как было.
function ffmpegArgs(streamKey, dir, profile, part, audio, input, inFrame, audioCopy) {
    const { renditions, copy } = PROFILES[profile];
    const variants = renditions.map((r, i) => `v:${i}${audio ? `,a:${i}` : ''},name:${r.height}`).join(' ');
    const hlsOut = '[f=hls' +
        `:hls_time=${SEGMENT_SECONDS}` +
        `:hls_list_size=${PLAYLIST_SEGMENTS}` +
        // program_date_time — время сервера у каждого сегмента: по нему
        // зритель ставит заставку «ведущий переключился» в тот момент
        // воспроизведения, когда ведущий ушёл, а не на 10–20 с раньше
        // (public/tk-viewer.js, тест 02.10). Проверено на 4.4 и 9.
        ':hls_flags=delete_segments+omit_endlist+independent_segments+program_date_time' +
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

        ...(copy ? ['-c:v', 'copy'] : videoArgs(profile, inFrame)),
        ...(audioCopy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-af', profile === 'venue' ? AUDIO_SYNC_VENUE : AUDIO_SYNC]),

        // Очередь мультиплексора. Когда одна дорожка обгоняет другую (а после
        // обрыва RTMP это норма), ffmpeg копит пакеты опережающей, пока не
        // дождётся отстающей. Упёршись в предел по умолчанию, он не ждёт,
        // а выходит с ошибкой — то есть эфир обрывается у всех зрителей
        // и перезапускается. Тысяча пакетов — это доли секунды видео;
        // памяти стоит копейки, а перезапуск стоит всего эфира.
        '-max_muxing_queue_size', '1024',

        // tee сам потоки не выбирает: без -map ffmpeg не знает, что ему отдать.
        // Видео берём с выходов фильтра — там оно уже со знаком (копия —
        // прямо со входа); звук — по копии на качество.
        ...(copy ? ['-map', '0:v'] : renditions.flatMap((_, i) => ['-map', `[v${i}]`])),
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
    const part = job.input ? null : recording.newPart(streamKey, { unmarked: job.mark === 'overlay' });
    const proc = spawn(FFMPEG, ffmpegArgs(streamKey, dir, job.profile, part, job.audio, job.input, job.mark === 'frame', job.daily), { stdio: ['ignore', 'ignore', 'pipe'] });
    job.proc = proc;
    // Плейлист ждём раз на конвейер: перезапуск ffmpeg каталог не стирает,
    // и прежний index.m3u8 давал «первый плейлист» после каждого обрыва.
    if (!job.watched) { job.watched = true; watchReady(streamKey, job); }
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
            // Шаг назад на десятки миллисекунд — перекрытие на стыке, когда
            // ffmpeg пересобрал звуковой фильтр (смена формата у камеры, см.
            // AUDIO_SYNC_VENUE): мультиплексор его поправит, звук цел. Сбой —
            // скачок от полусекунды (метки в 1/48000 у звука, 1/90000 у картинки).
            const back = text.match(/previous: (\d+), current: (\d+)/);
            if (kind === 'dts' && back && Number(back[1]) - Number(back[2]) < 45000) break;
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
            note(streamKey, job, 'hls.giveup', { code, signal });
            finish(streamKey, job);
            // Старый плейлист — долой: иначе новый зритель получал ~12 с
            // прошлого видео и вставал, а не «видео ещё не пришло» (зонд
            // probe-venue-trace-1003: MediaMTX упал, о конце публикации не сказал).
            clean(dir);
            return;
        }

        job.restarts++;
        console.warn(`[hls ${streamKey}] ffmpeg завершился (code=${code} signal=${signal}), перезапуск ${job.restarts}/${MAX_RESTARTS}`);
        note(streamKey, job, 'hls.exit', { code, signal, restart: job.restarts });
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

// Сколько конвейеров каждого вида идёт и сколько ядер они едят по замерам —
// для журнала ниже и «Системы» в панели (routes/admin/load.js).
function usage() {
    let cores = 0;
    const count = {};
    for (const j of jobs.values()) {
        if (j.stopping) continue;
        cores += CORES[j.profile] - (j.daily ? AUDIO_CORES : 0);
        count[j.profile] = (count[j.profile] || 0) + 1;
    }
    return { cores, count };
}

function cpuCheck() {
    const { cores, count } = usage();
    if (cores < CPU_CALM) cpuWarned = false;
    if (cpuWarned || cores < CPU_WARN) return;
    cpuWarned = true;
    errorLog.media(new Error(`Перекодирование близко к пределу процессора: ~${cores.toFixed(1)} ядра из 4 (эфиров ${(count.full || 0) + (count.lite || 0) + (count.copy || 0)}, камер ${count.venue || 0})`),
        'hls.cpu', { cores, ...count });
}

// Эфир — на postPublish, то есть после проверки подписи и ключа.
// Камера заведения — по готовности потока в MediaMTX (utils/venueCam.js):
// opts.input — его адрес, opts.profile — 'venue', opts.log — её хронология.
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

    // Где знак — решается раз на эфир: перезапуски после обрыва идут так же
    // (held выше). Камера заведения — всегда в кадре: её пережимаем в любом
    // случае (VP8 браузера), и знак там ничего не стоит.
    const kept = opts.profile ? null : heldFor(streamKey);
    const mark = opts.profile === 'venue' ? 'frame' : kept ? kept.mark : streamWatermark.mode();

    // Без файла знака такой эфир не начинаем: видео без знака отдавать нельзя,
    // а молча продолжить — значит нарушить это правило незаметно.
    if (mark === 'frame' && !fs.existsSync(WATERMARK)) {
        errorLog.media(new Error(`нет файла водяного знака ${WATERMARK}`), 'hls.watermark', { streamKey });
        return;
    }

    // Останавливаемый конвейер уже не в счёте: его ffmpeg выходит до 5 с.
    // Место эфира на переподключении — в счёте (held).
    let full = 0;
    for (const j of jobs.values()) if (j.profile === 'full' && !j.stopping) full++;
    for (const [key, h] of held) {
        const j = jobs.get(key);
        if (key !== streamKey && h.profile === 'full' && h.until > Date.now() && !(j && !j.stopping)) full++;
    }
    // Полный — первым двум, и только пока живые конвейеры вместе с ним
    // укладываются в LIVE_CORES (план 02.10, п. 8): при десятках копий
    // третье и четвёртое ядро нужны Node, базе и очереди записей.
    const room = usage().cores + CORES.full <= LIVE_CORES;
    const profile = opts.profile || (kept && kept.profile) || (full < MAX_FULL_TRANSCODES && room ? 'full' : mark === 'frame' ? 'lite' : 'copy');
    if (!opts.profile) held.set(streamKey, { profile, mark, until: Infinity });

    const job = { proc: null, restarts: 0, stopping: false, timer: null, profile, mark, input: opts.input || null, log: opts.log || null, daily: !!opts.daily, audio: true, silent: false };
    job.done = new Promise((resolve) => { job.resolve = resolve; });
    jobs.set(streamKey, job);
    spawnFfmpeg(streamKey, job);
    cpuCheck();
    const what = profile === 'copy' ? 'копия видео' : 'транскод ' + PROFILES[profile].renditions.map((r) => r.height + 'p').join('/');
    const why = kept ? ' (режим эфира до обрыва)' : profile === 'lite' || profile === 'copy' ? ' (лимит полных транскодов)' : profile === 'venue' ? ' (камера заведения)' : '';
    console.log(`[hls ${streamKey}] ${what}, знак ${mark === 'frame' ? 'в кадре' : 'поверх плеера'}${why} → /live/${streamKey}/index.m3u8`);
    note(streamKey, job, 'hls.start', { profile, mark, kept: !!kept });
}

// Знак этого эфира — поверх плеера (страница зрителя кладёт его сама).
// Конвейера нет — эфир ещё не начат: по настройке, с ней он и начнётся.
function overlayMark(streamKey) {
    const job = jobs.get(streamKey);
    const h = heldFor(streamKey);
    return (job && !job.stopping ? job.mark : h ? h.mark : streamWatermark.mode()) === 'overlay';
}

// opts.hold — обрыв выхода Daily: эфир идёт, конвейер вернётся (held выше).
function stop(streamKey, opts = {}) {
    const h = held.get(streamKey);
    if (h && opts.hold) h.until = Date.now() + HOLD_MS;
    else held.delete(streamKey);

    const job = jobs.get(streamKey);
    if (!job) return;

    job.stopping = true;
    if (job.timer) clearTimeout(job.timer);
    note(streamKey, job, 'hls.stop');

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
module.exports = { start, stop, release, stopped, overlayMark, usage, HLS_ROOT, hlsBase };
