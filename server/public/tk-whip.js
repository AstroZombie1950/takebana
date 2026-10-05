/* Камера заведения: публикация по WHIP на наш приёмник (MediaMTX).
 *
 * Зачем. До 23.09.2026 камера была комнатой Daily: каждая зрительская
 * минута стоила денег. Теперь заведение вещает один раз на наш MediaMTX
 * (ops/mediamtx/), а зрители смотрят HLS через Bunny — его режет наш
 * ffmpeg, знак рисует страница зрителя (server/utils/venueCam.js). Смотреть
 * по WHEP больше некому: с 25.09 MediaMTX — только приёмник.
 *
 * Почему это короткий файл. Вся сложная часть WebRTC — согласование ролей,
 * повторы, перезапуск ICE — нужна в звонке, где две равные стороны
 * (public/tk-peer.js). Здесь сигналинг — один POST с описанием сессии
 * и ответ на него: WHIP этим и хорош. Камеру и микрофон держит страница
 * (public/tk-venue-live.js): они живут дольше публикации — вещание идёт,
 * только пока камеру смотрят, а своя картинка у владельца есть всегда.
 *
 * Разрешение на подключение — одноразовый ключ в адресе, его выдаёт
 * server/routes/venueLive.js, а спрашивает MediaMTX у нас же.
 */
(function () {
  function noop() {}

  // Кандидаты собираем до отправки: без них MediaMTX не с чем соединяться,
  // а трикл-обновления потребовали бы второго запроса с тем же ключом.
  // Таймаут — чтобы медленный STUN не держал показ: того, что собралось,
  // обычно достаточно.
  var GATHER_MS = 3000;

  function gathered(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(); } };
      var timer = setTimeout(finish, GATHER_MS);
      pc.addEventListener('icegatheringstatechange', function () {
        if (pc.iceGatheringState === 'complete') { clearTimeout(timer); finish(); }
      });
    });
  }

  // Обмен описаниями: наше предложение — в теле, ответ сервера — в ответе.
  // Location — адрес сессии: по нему её и закрывают.
  function exchange(url, pc) {
    return pc.createOffer()
      .then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () { return gathered(pc); })
      .then(function () {
        return tkFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: pc.localDescription.sdp,
        });
      })
      .then(function (res) {
        if (!res.ok) {
          var err = new Error(TKNet.explain(res));
          err.status = res.status;
          throw err;
        }
        var place = res.headers.get('Location') || '';
        return res.text().then(function (sdp) {
          return pc.setRemoteDescription({ type: 'answer', sdp: sdp }).then(function () {
            // Адрес сессии приходит относительным — доводим до полного.
            return place ? new URL(place, url).href : '';
          });
        });
      });
  }

  // Потолок видео: 480p и 15 кадров просит страница у камеры, а битрейт —
  // здесь. Больше сервер всё равно не отдаст (профиль venue, utils/hls.js),
  // а лишнее — входящий трафик нашего канала.
  var VIDEO = { maxBitrate: 800000, maxFramerate: 15 };

  // H.264 сервер берёт копией (utils/hls.js, venueCopy) — в разы дешевле
  // пережатия VP8. Но 23.09 зонд поймал браузер, который на H.264
  // соглашается и не шлёт ни кадра. Поэтому с h264 «в эфире» — только
  // когда кадры пошли; не пошли за VERIFY_MS — ошибка с codec: true,
  // и страница публикует заново без него (tk-venue-live.js).
  var VERIFY_MS = 4000;

  function preferH264(tr) {
    var caps = window.RTCRtpSender && RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('video');
    var all = (caps && caps.codecs) || [];
    var isH264 = function (c) { return /h264/i.test(c.mimeType); };
    if (!tr.setCodecPreferences || !all.some(isH264)) return false;
    try {
      tr.setCodecPreferences(all.filter(isH264).concat(all.filter(function (c) { return !isH264(c); })));
      return true;
    } catch (e) { return false; }
  }

  function framesSent(pc) {
    return pc.getStats().then(function (stats) {
      var n = 0;
      stats.forEach(function (s) { if (s.type === 'outbound-rtp' && s.kind === 'video') n += s.framesEncoded || 0; });
      return n;
    });
  }

  // Каким путём пошло видео: host / srflx / relay и протокол — для
  // телеметрии владельца (docs/TELEMETRY.md, venue.host).
  function route(pc) {
    return pc.getStats().then(function (stats) {
      var out = '';
      stats.forEach(function (s) {
        if (out || s.type !== 'candidate-pair' || !s.nominated || s.state !== 'succeeded') return;
        var c = stats.get(s.localCandidateId);
        if (c) out = c.candidateType + '/' + (c.relayProtocol || c.protocol);
      });
      return out;
    });
  }

  // Вещание: дорожки stream уходят на сервер. Дорожки — страницы, публикация
  // их не останавливает. opts: onState('connecting' | 'live' | 'ended'),
  // onError(e) — e.status у отказа сервера, e.codec — H.264 не пошёл,
  // onRoute('host/udp'), h264 — просить H.264 первым.
  // Возвращает { pc, leave(), replaceTrack(track) }.
  function publish(url, stream, opts) {
    opts = opts || {};
    var closed = false;
    var place = '';
    var pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });

    var h264 = false;

    function emit(name, v) { if (opts[name]) opts[name](v); }

    function wentLive() {
      emit('onState', 'live');
      route(pc).then(function (r) { if (r) emit('onRoute', r); }, noop);
    }

    // Кадры пошли — в эфире; нет за VERIFY_MS — H.264 у этого браузера
    // не работает.
    function verify(t0) {
      framesSent(pc).then(function (n) {
        if (closed) return;
        if (n > 0) return wentLive();
        if (Date.now() - t0 < VERIFY_MS) return setTimeout(function () { verify(t0); }, 500);
        var e = new Error('H.264: кадры не идут');
        e.codec = true;
        emit('onError', e);
        leave('ended');
      }, wentLive);
    }

    pc.onconnectionstatechange = function () {
      if (closed) return;
      if (pc.connectionState === 'connected') {
        if (h264) verify(Date.now()); else wentLive();
      }
      // Разорвалось и не вернулось само — публикация кончилась. Пересобирать
      // соединение здесь незачем: страница попросит новую, если камеру ещё смотрят.
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') leave('ended');
    };

    function leave(why) {
      if (closed) return;
      closed = true;
      pc.close();
      if (place) fetch(place, { method: 'DELETE', keepalive: true }).catch(noop);
      if (why) emit('onState', why);
    }

    // Без opts.h264 кодек выбирает браузер (обычно VP8) — сервер его
    // пережмёт сам.
    stream.getTracks().forEach(function (t) {
      var tr = pc.addTransceiver(t, { direction: 'sendonly', streams: [stream], sendEncodings: t.kind === 'video' ? [VIDEO] : undefined });
      if (t.kind !== 'video') return;
      if (opts.h264) h264 = preferH264(tr);
      // При слабом канале — меньше кадров, но не меньше кадр. По умолчанию
      // браузер первые секунды шлёт 320×180, пока оценивает канал (зонд
      // 25.09), а зрителю вид зала нужен резким, плавность — дело второе.
      try {
        var p = tr.sender.getParameters();
        p.degradationPreference = 'maintain-resolution';
        tr.sender.setParameters(p).catch(noop);
      } catch (e) { /* браузер без этой настройки — пусть решает сам */ }
    });

    emit('onState', 'connecting');
    exchange(url, pc).then(function (location) {
      if (closed) return leave();
      place = location;
    }).catch(function (e) {
      if (closed) return;
      emit('onError', e);
      leave('ended');
    });

    return {
      pc: pc,
      leave: function () { leave(); },
      // Другая камера: новая дорожка встаёт на место прежней в том же
      // соединении — сервер и зрители ничего не замечают.
      replaceTrack: function (track) {
        var sender = pc.getSenders().filter(function (x) { return x.track && x.track.kind === track.kind; })[0];
        return sender ? sender.replaceTrack(track) : Promise.resolve();
      },
    };
  }

  window.TKWhip = { publish: publish };
})();
