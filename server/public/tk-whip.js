/* Камера заведения: публикация по WHIP на наш приёмник (MediaMTX).
 *
 * Зачем. До 23.09.2026 камера была комнатой Daily: каждая зрительская
 * минута стоила денег. Теперь заведение вещает один раз на наш MediaMTX
 * (ops/mediamtx/), а зрители смотрят HLS через Bunny — его режет наш
 * ffmpeg со знаком (server/utils/venueCam.js). Смотреть по WHEP больше
 * некому: с 25.09 MediaMTX — только приёмник.
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

  // Потолок видео: 480p и 15 кадров просит страница у камеры, а битрейт —
  // здесь. Больше сервер всё равно не отдаст (профиль venue, utils/hls.js),
  // а лишнее — входящий трафик нашего канала.
  var VIDEO = { maxBitrate: 800000, maxFramerate: 15 };

  // Вещание: дорожки stream уходят на сервер. Дорожки — страницы, публикация
  // их не останавливает. opts: onState('connecting' | 'live' | 'ended'),
  // onError(e). Возвращает { pc, leave(), replaceTrack(track) }.
  function publish(url, stream, opts) {
    opts = opts || {};
    var closed = false;
    var place = '';
    var pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });

    function emit(name, v) { if (opts[name]) opts[name](v); }

    pc.onconnectionstatechange = function () {
      if (closed) return;
      if (pc.connectionState === 'connected') emit('onState', 'live');
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

    // Кодек выбирает браузер (сегодня VP8): ffmpeg на сервере переводит
    // в H.264 сам. Ставить H.264 первым пробовали 23.09 — видео пропадало
    // совсем: браузер соглашался в согласовании, а закодировать не мог.
    stream.getTracks().forEach(function (t) {
      var tr = pc.addTransceiver(t, { direction: 'sendonly', streams: [stream], sendEncodings: t.kind === 'video' ? [VIDEO] : undefined });
      if (t.kind !== 'video') return;
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
