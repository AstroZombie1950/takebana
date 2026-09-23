/* Камера заведения через свой приём: публикация по WHIP, просмотр по WHEP.
 *
 * Зачем. До 23.09.2026 камера была комнатой Daily на двоих: вещатель
 * отдавал картинку каждому зрителю отдельно, и каждая зрительская минута
 * стоила денег. Теперь заведение вещает один раз на наш MediaMTX
 * (ops/mediamtx/), а зрителей он обслуживает сам — платим только за трафик.
 *
 * Почему это короткий файл. Вся сложная часть WebRTC — согласование ролей,
 * повторы, перезапуск ICE — нужна в звонке, где две равные стороны
 * (public/tk-peer.js). Здесь сигналинг — один POST с описанием сессии
 * и ответ на него: WHIP и WHEP этим и хороши.
 *
 * Разрешение на подключение — одноразовый ключ в адресе, его выдаёт
 * server/routes/venueLive.js, а спрашивает MediaMTX у нас же
 * (server/utils/mediamtx.js).
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
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: pc.localDescription.sdp,
        });
      })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var place = res.headers.get('Location') || '';
        return res.text().then(function (sdp) {
          return pc.setRemoteDescription({ type: 'answer', sdp: sdp }).then(function () {
            // Адрес сессии приходит относительным — доводим до полного.
            return place ? new URL(place, url).href : '';
          });
        });
      });
  }

  // Общая часть публикации и просмотра: соединение, состояния, уход.
  // opts: onState('connecting' | 'live' | 'ended'), onMediaError
  function session(url, opts, build) {
    var closed = false;
    var place = '';
    var pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });

    function emit(name) { if (opts[name]) opts[name].apply(null, [].slice.call(arguments, 1)); }

    pc.onconnectionstatechange = function () {
      if (closed) return;
      if (pc.connectionState === 'connected') emit('onState', 'live');
      // Разорвалось и не вернулось само — показ кончился. Пересобирать
      // соединение здесь незачем: страница просто включает камеру заново.
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') leave('ended');
    };

    function leave(why) {
      if (closed) return Promise.resolve();
      closed = true;
      pc.close();
      if (place) fetch(place, { method: 'DELETE', keepalive: true }).catch(noop);
      if (why) emit('onState', why);
      return Promise.resolve();
    }

    emit('onState', 'connecting');
    var ready = Promise.resolve(build(pc))
      .then(function () { return exchange(url, pc); })
      .then(function (location) {
        if (closed) return leave();
        place = location;
      })
      .catch(function (e) {
        if (closed) return;
        emit('onError', e);
        leave('ended');
      });

    return { pc: pc, ready: ready, leave: leave };
  }

  // Вещание: камера и микрофон заведения уходят на сервер.
  function publish(url, opts) {
    opts = opts || {};
    var tracks = [];
    var s = session(url, opts, function (pc) {
      return navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      }).then(function (stream) {
        tracks = stream.getTracks();
        // Кодек выбирает браузер. Ставить H.264 первым мы пробовали
        // (23.09) — и видео пропадало совсем: браузер соглашался на него
        // в согласовании, а закодировать не мог, и на сервер приходил один
        // звук. Сегодня это и не нужно: WHEP отдаёт что пришло, а ветку
        // HLS — ей H.264 обязателен — включим отдельно и с проверкой
        // на живых устройствах (docs/ROADMAP.md, очередь HLS).
        tracks.forEach(function (t) { pc.addTransceiver(t, { direction: 'sendonly', streams: [stream] }); });
        if (opts.onLocal) opts.onLocal(stream);
      }).catch(function (e) {
        if (opts.onMediaError) opts.onMediaError(e);
        throw e;
      });
    });
    var leave = s.leave;
    s.leave = function (why) {
      tracks.forEach(function (t) { t.stop(); });
      return leave(why);
    };
    return s;
  }

  // Просмотр: с сервера приходят звук и видео, отправлять нам нечего.
  function view(url, opts) {
    opts = opts || {};
    var media = new MediaStream();
    var s = session(url, opts, function (pc) {
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.ontrack = function (e) {
        media.addTrack(e.track);
        if (opts.onStream) opts.onStream(media, e.track);
      };
    });
    s.stream = media;
    return s;
  }

  window.TKWhip = { publish: publish, view: view };
})();
