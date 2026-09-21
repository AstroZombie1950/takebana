/* Пуш-уведомления на стороне устройства: подписка, выбор «показывать текст»
 * и проверка. Приём уведомления — public/sw.js, отправка — server/utils/push.js,
 * тумблеры — /settings (public/settings.js).
 *
 * Чем это отличается от tk-notify.js. Тот показывает уведомление, пока
 * вкладка открыта, и живёт целиком в браузере. Пуш приходит, когда вкладки
 * нет вовсе, поэтому подписку хранит сервер — а значит, и выбор «показывать
 * текст» хранится там же, рядом с подпиской: собирает уведомление сервер.
 *
 * Подписка — свойство устройства, а не аккаунта: адрес выдаёт пуш-сервис
 * браузера. Поэтому на каждой странице мы сверяем её с сервером (sync):
 * браузер меняет адрес сам, когда считает нужным, и протухшая подписка
 * молча перестала бы работать — а человек об этом не узнал бы никогда.
 */
(function () {
  var KEY = (window.TK && TK.vapid) || '';

  function supported() {
    return !!(KEY && 'serviceWorker' in navigator && 'PushManager' in window &&
              'Notification' in window && window.isSecureContext);
  }

  // Ключ едет в разметке строкой base64url, а подписке нужны байты.
  function keyBytes(base64) {
    var pad = '='.repeat((4 - base64.length % 4) % 4);
    var raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.message || 'HTTP ' + r.status);
        return d;
      });
    });
  }

  function current() {
    if (!supported()) return Promise.resolve(null);
    return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); });
  }

  // Что показать в настройках: можно ли вообще, разрешил ли браузер,
  // подписано ли это устройство.
  function state() {
    return current().then(function (sub) {
      return {
        supported: supported(),
        permission: 'Notification' in window ? Notification.permission : 'denied',
        on: !!sub,
        endpoint: sub ? sub.endpoint : ''
      };
    });
  }

  // Включение. Разрешение спрашиваем здесь, а не при загрузке страницы:
  // без жеста браузер запрос блокирует, а спрошенное в лоб отклоняют —
  // и второй раз спросить он уже не даст.
  function enable(prefs) {
    if (!supported()) return Promise.reject(new Error('unsupported'));
    return Promise.resolve(Notification.permission === 'granted' ? 'granted' : Notification.requestPermission())
      .then(function (res) {
        if (res !== 'granted') throw new Error('denied');
        return navigator.serviceWorker.ready;
      })
      .then(function (reg) {
        // userVisibleOnly обязателен: Chrome иначе не подписывает вовсе.
        // Тихие пуши нам и не нужны — для фоновых дел есть сокет.
        return reg.pushManager.getSubscription().then(function (sub) {
          return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(KEY) });
        });
      })
      .then(function (sub) {
        var body = { subscription: sub.toJSON() };
        if (prefs && typeof prefs.preview === 'boolean') body.preview = prefs.preview;
        if (prefs && typeof prefs.live === 'boolean') body.live = prefs.live;
        return post('/api/push/subscribe', body).then(function () { return sub; });
      });
  }

  // Выключение: снимаем подписку и у браузера, и у себя. Порядок важен —
  // сначала сервер: если браузер отпишется, а запрос не дойдёт, мы будем
  // слать в никуда, и уборка случится только по ответу 410.
  function disable() {
    return current().then(function (sub) {
      if (!sub) return true;
      return post('/api/push/unsubscribe', { endpoint: sub.endpoint })
        .then(function () { return sub.unsubscribe(); });
    });
  }

  function prefs(patch) {
    return current().then(function (sub) {
      if (!sub) return null;
      return post('/api/push/prefs', Object.assign({ endpoint: sub.endpoint }, patch));
    });
  }

  function test() { return post('/api/push/test', {}); }

  // Сверка при загрузке страницы: подписка есть — напоминаем о ней серверу.
  // Заодно это переписывает запись на того, кто вошёл сейчас: на общем
  // телефоне подписка остаётся от прежнего владельца устройства.
  function sync() {
    if (!supported() || Notification.permission !== 'granted') return Promise.resolve(false);
    return current()
      .then(function (sub) { return sub ? post('/api/push/subscribe', { subscription: sub.toJSON() }) : false; })
      .then(function (r) { return !!r; })
      .catch(function () { return false; });
  }

  window.TKPush = { supported: supported, state: state, enable: enable, disable: disable, prefs: prefs, test: test, sync: sync };

  // Не на первой секунде загрузки: сверка никуда не спешит и не должна
  // мешать странице рисоваться.
  if (supported()) window.addEventListener('load', function () { setTimeout(sync, 2000); });
})();
