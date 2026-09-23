/* Звук в звонке: отчёт с устройства и живой уровень собеседника.
 *
 * Зачем. Жалоба «в звонке ничего не слышно, только по громкой связи» живёт
 * с сентября, а данных с устройства заказчика у нас нет ни одной строки.
 * Спрашивать бесполезно — ответы вроде «ну не слышно» мы уже получали.
 * Поэтому каждый звонок теперь присылает отчёт: что за телефон, как открыт
 * сайт, что с элементом звука и — главное — доходит ли звук вообще.
 *
 * Главная строка отчёта — totalAudioEnergy и audioLevel из getStats().
 * Энергия больше нуля значит, что звук пришёл и декодировался: тогда дело
 * в устройстве и маршруте вывода, а не в сети. Ноль — ищем в сети.
 *
 * WebAudio здесь нет и быть не может: 21.09 выяснилось, что запущенный
 * рядом с микрофоном AudioContext на iPhone уводит звук в разговорный
 * динамик. Уровень берём из статистики соединения, не из анализатора.
 *
 * Отчёты уходят в общий журнал панели (routes/clientErrors.js) видом
 * CallAudio — рядом с ошибками, но отдельной строкой.
 */
(function () {
  function yes(v) { return v ? 'да' : 'нет'; }

  // Как открыт сайт: обычной вкладкой или с иконки на домашнем экране.
  // На iPhone это разные режимы работы с WebRTC, и мы сами просили
  // заказчика поставить иконку ради пушей.
  function standalone() {
    try {
      return navigator.standalone === true ||
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    } catch (e) { return false; }
  }

  // Что за устройство и что оно само думает о звуке.
  function device() {
    var conn = navigator.connection || {};
    var session = navigator.audioSession;
    return [
      'браузер: ' + navigator.userAgent,
      'с домашнего экрана: ' + yes(standalone()),
      'audioSession: ' + (session ? (session.type || 'без типа') : 'нет'),
      'сеть: ' + (conn.type || '?') + ' / ' + (conn.effectiveType || '?'),
      'язык: ' + navigator.language,
    ];
  }

  // Состояние элемента, через который играет звук собеседника. Половина
  // жалоб «не слышно» объясняется прямо здесь: paused, muted или volume 0.
  function element(el, label) {
    if (!el) return [label + ': элемента нет'];
    var stream = el.srcObject;
    var tracks = stream && stream.getAudioTracks ? stream.getAudioTracks() : [];
    return [
      label + ': ' + (el.paused ? 'на паузе' : 'играет') +
        ', звук ' + (el.muted ? 'выключен' : 'включён') +
        ', громкость ' + el.volume +
        ', готовность ' + el.readyState +
        ', дорожек ' + tracks.length +
        (el.sinkId ? ', вывод ' + el.sinkId : ''),
    ];
  }

  // Настройки своей дорожки: эхоподавление и прочее телефон выставляет сам,
  // и от них зависит, каким режимом он считает разговор.
  function track(t, label) {
    if (!t || !t.getSettings) return [label + ': дорожки нет'];
    var s = t.getSettings() || {};
    return [
      label + ': ' + (t.label || 'без метки') +
        ', эхоподавление ' + yes(s.echoCancellation) +
        ', шумоподавление ' + yes(s.noiseSuppression) +
        ', автоусиление ' + yes(s.autoGainControl) +
        ', частота ' + (s.sampleRate || '?') +
        ', состояние ' + t.readyState,
    ];
  }

  // Что за устройства вывода вообще видит браузер. В WebKit их не видно
  // вовсе, и это само по себе ответ: выбрать динамик мы не можем.
  function outputs() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return Promise.resolve(['устройства вывода: браузер их не показывает']);
    }
    return navigator.mediaDevices.enumerateDevices().then(function (list) {
      var out = list.filter(function (d) { return d.kind === 'audiooutput'; });
      return ['устройства вывода: ' + (out.length
        ? out.map(function (d) { return d.label || 'без метки'; }).join(', ')
        : 'не показаны (так ведёт себя Safari)')];
    }).catch(function () { return ['устройства вывода: не спросить']; });
  }

  // Статистика входящего звука, как её отдаёт соединение (tk-peer.js).
  function heard(stats) {
    if (!stats) return ['звук собеседника: статистики нет (разговор через Daily)'];
    return [
      'звук собеседника: энергия ' + (stats.energy != null ? stats.energy.toFixed(4) : '?') +
        ', уровень ' + (stats.level != null ? stats.level.toFixed(3) : '?') +
        ', пакетов ' + (stats.packets || 0) +
        ', потеряно ' + (stats.lost || 0) +
        ', дрожание ' + (stats.jitter != null ? stats.jitter.toFixed(3) : '?'),
      'путь: ' + (stats.route || '?'),
    ];
  }

  // Отчёт в журнал панели. keepalive — чтобы отчёт при завершении звонка
  // ушёл, даже если страницу закрывают тем же движением.
  function send(message, details) {
    return fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CallAudio', page: location.pathname, message: message, details: details }),
      keepalive: true,
    }).catch(function () {});
  }

  window.TKAudio = { device: device, element: element, track: track, outputs: outputs, heard: heard, send: send, standalone: standalone };
})();
