/* Переписка: вкладки «Сообщения» и «Звонки», лента со звонками между
 * сообщениями, отправка, вложения и голосовые, пересылка, удаление,
 * статусы «доставлено» и «прочитано».
 *
 * Новое приходит сокетом: tk-app.js пересылает события сервера в document
 * как tk:message:new, tk:message:read и т. д. Раньше открытый диалог
 * опрашивал сервер раз в три секунды, а о прочтении никто не узнавал.
 */
(function () {
  var t = window.t || function () { return ''; };
  var ME = (window.TK && window.TK.userId) || '';
  var PAGE = 15;

  var $ = function (id) { return document.getElementById(id); };
  var feed = $('feed');
  var list = $('conversationsList');
  var input = $('messageInput');

  var peer = null;          // { id, name, url, bg, initial }
  var messages = [];        // лента открытого диалога, от старых к новым
  var calls = [];           // звонки с собеседником за загруженный отрезок
  var loadingOld = false;
  var allLoaded = false;

  function uiLang() { return window.tkLang ? window.tkLang() : 'ru'; }

  // Экранная клавиатура. На Android её берёт на себя браузер: страница
  // ужимается (interactive-widget=resizes-content в partials/tkHead.ejs),
  // вместе с ней ужимается и 100dvh. Safari на айфоне этого не умеет —
  // он кладёт клавиатуру поверх страницы, и поле ввода оказывалось под ней.
  // Считаем, сколько экрана она закрыла, и на столько же укорачиваем
  // переписку: высота .tk-chat вычитает --tk-kb (chats.css).
  //
  // Порог в 80px — чтобы не принять за клавиатуру адресную строку Safari:
  // её появление и так учитывает dvh.
  var vv = window.visualViewport;
  if (vv) {
    var keyboard = function () {
      var hidden = Math.max(0, window.innerHeight - vv.height);
      document.documentElement.style.setProperty('--tk-kb', hidden > 80 ? hidden + 'px' : '0px');
    };
    vv.addEventListener('resize', keyboard);
    keyboard();
  }

  // Выпадающие меню кладём в живую часть экрана: по краям лежат системные
  // панели (чёлка, полоса кнопок Android), их размеры — в токенах --tk-safe-*
  // (tk.css). Без этого меню сообщения у нижнего края открывалось под кнопками.
  function safe(side) {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tk-safe-' + side)) || 0;
  }

  // «5 минут назад» на языке интерфейса — так же, как сервер
  // (routes/streaming/messages.js).
  var AGO_STEPS = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  function timeAgo(value) {
    var sec = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    var step = AGO_STEPS.find(function (x) { return sec >= x[1]; }) || AGO_STEPS[AGO_STEPS.length - 1];
    return new Intl.RelativeTimeFormat(uiLang(), { numeric: 'auto' }).format(-Math.floor(sec / step[1]), step[0]);
  }

  function refreshTimes() {
    document.querySelectorAll('[data-time]').forEach(function (el) {
      el.textContent = timeAgo(el.getAttribute('data-time'));
    });
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.message || 'HTTP ' + r.status);
        return data;
      });
    });
  }

  // ── Аватар ────────────────────────────────────────────────────────────
  // Фото — картинкой, без фото — градиент с буквой. Раньше фото узнавали по
  // началу адреса «http», а загруженные аватары лежат по /uploads/… — и вместо
  // фото рисовался фон с адресом внутри.
  // tag — 'a' для аватара-ссылки (шапка диалога ведёт в профиль), по умолчанию span.
  function avatar(cls, p, attrs, tag) {
    tag = tag || 'span';
    if (p.url) return '<' + tag + ' class="' + cls + '"' + (attrs || '') + '><img src="' + escapeHtml(p.url) + '" alt=""></' + tag + '>';
    return '<' + tag + ' class="' + cls + '"' + (attrs || '') + ' style="background: ' + escapeHtml(p.bg || '') + '">' + escapeHtml(p.initial || '?') + '</' + tag + '>';
  }

  function peerOf(el) {
    return {
      id: el.getAttribute('data-id'),
      name: el.getAttribute('data-name'),
      url: el.getAttribute('data-ava-url'),
      bg: el.getAttribute('data-ava-bg'),
      initial: el.getAttribute('data-ava-initial')
    };
  }

  function dialogEl(id) {
    return list.querySelector('.tk-dialog[data-id="' + CSS.escape(String(id)) + '"]');
  }

  // ── Лента ─────────────────────────────────────────────────────────────
  var TICK = '<path d="M3 12.5l4.5 4.5L17 7.5"></path>';
  var TICKS = '<path d="M1.5 12.5 6 17l9.5-9.5"></path><path d="M11 16.5l.5.5L21 7.5"></path>';

  function status(m) {
    if (m.readAt) return { key: 'chats.status.read', cls: 'is-read', icon: TICKS };
    if (m.deliveredAt) return { key: 'chats.status.delivered', cls: '', icon: TICKS };
    return { key: 'chats.status.sent', cls: '', icon: TICK };
  }

  // Пересланное. Сообщения одной пачки (forwardedFrom.batch), идущие подряд,
  // лента собирает в общую рамку: заголовок «Переслано» над первым, имя
  // автора — там, где он сменился, как в исходной переписке; время и галочки —
  // под последним. g — место в пачке: { first, last, name } (name — автор
  // предыдущего в пачке).
  var FWD_TIME = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };

  // ── Вложения ──────────────────────────────────────────────────────────
  // Одно на сообщение (routes/streaming/messages.js, /messages/attach).
  // Картинка и видео открываются окном во весь экран, звук играет прямо
  // в ленте, документ — ссылкой на файл.
  var PLAY = '<path d="M8 5.5v13L20 12z" fill="currentColor"></path>';
  var PAUSE = '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"></path>';

  function clock(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  function fileSize(bytes) {
    var units = uiLang() === 'ru' ? ['Б', 'КБ', 'МБ'] : ['B', 'KB', 'MB'];
    var i = bytes >= 1048576 ? 2 : bytes >= 1024 ? 1 : 0;
    var n = bytes / Math.pow(1024, i);
    return (i && n < 10 ? n.toFixed(1) : Math.round(n)) + '\u00a0' + units[i];
  }

  // Картинка и кадр видео — в рамке своих пропорций, вписанной в 320×360,
  // чтобы лента не прыгала, пока они грузятся, а вертикальное не обрезалось.
  function frame(a) {
    if (!a.width || !a.height) return '';
    var w = Math.round(Math.min(320, a.width, 360 * a.width / a.height));
    return ' style="width: ' + w + 'px; aspect-ratio: ' + a.width + ' / ' + a.height + '"';
  }

  function attachmentHtml(a) {
    if (a.kind === 'image') {
      return '<button type="button" class="tk-att tk-att--media" data-img="' + escapeHtml(a.url) + '" aria-label="' + escapeHtml(t('chats.openImage')) + '"' + frame(a) + '>' +
        '<img src="' + escapeHtml(a.preview || a.url) + '" alt="" loading="lazy" decoding="async"></button>';
    }
    if (a.kind === 'video') {
      return '<button type="button" class="tk-att tk-att--media" data-video="' + escapeHtml(a.url) + '" data-poster="' + escapeHtml(a.preview || '') + '" aria-label="' + escapeHtml(t('chats.openVideo')) + '"' + frame(a) + '>' +
        (a.preview ? '<img src="' + escapeHtml(a.preview) + '" alt="" loading="lazy" decoding="async">' : '') +
        '<span class="tk-att__play" aria-hidden="true"><svg viewBox="0 0 24 24" width="28" height="28">' + PLAY + '</svg></span>' +
        (a.duration ? '<span class="tk-att__len">' + clock(a.duration) + '</span>' : '') + '</button>';
    }
    if (a.kind === 'round') {
      // Кружок: кадр-обложка в круге; видео одно на страницу и вставляется
      // сюда при воспроизведении (roundPlay). Ход — кольцом по краю, от
      // двенадцати часов; в покое кольца нет вовсе. На паузе поверх кадра —
      // знак «пустить дальше».
      // Играющий после перерисовки ленты сразу рождается крупным: иначе он
      // сжимался бы до 240 и заново «вырастал» на каждом новом сообщении.
      var live = roundPlayer && roundPlayer.url === a.url ? ' is-live' : '';
      return '<button type="button" class="tk-att tk-round' + live + '" data-round="' + escapeHtml(a.url) + '" data-duration="' + (a.duration || 0) + '" aria-label="' + escapeHtml(t('chats.play')) + '">' +
        (a.preview ? '<img src="' + escapeHtml(a.preview) + '" alt="" loading="lazy" decoding="async">' : '') +
        '<svg class="tk-round__ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="48"></circle></svg>' +
        '<span class="tk-round__sign" aria-hidden="true"><svg viewBox="0 0 24 24" width="30" height="30">' + PLAY + '</svg></span>' +
        '<span class="tk-att__len">' + clock(a.duration) + '</span></button>';
    }
    if (a.kind === 'audio' || a.kind === 'voice') {
      // Голосовое — волной, файл звука — именем над полосой.
      var track = a.wave && a.wave.length
        ? '<span class="tk-audio__wave">' + a.wave.map(function (v) { return '<i style="height:' + (12 + v * 88 / 31).toFixed(0) + '%"></i>'; }).join('') + '</span>'
        : '<span class="tk-audio__line"></span>';
      return '<div class="tk-att tk-audio" data-audio="' + escapeHtml(a.url) + '" data-duration="' + (a.duration || 0) + '">' +
        '<button type="button" class="tk-audio__btn" data-play aria-label="' + escapeHtml(t('chats.play')) + '">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' + PLAY + '</svg></button>' +
        '<span class="tk-audio__body">' +
          (a.kind === 'audio' ? '<span class="tk-audio__name">' + escapeHtml(a.name) + '</span>' : '') +
          '<span class="tk-audio__track" data-seek>' + track + '</span>' +
          '<span class="tk-audio__time">' + clock(a.duration) + '</span>' +
        '</span></div>';
    }
    var ext = (/\.([a-z0-9]{1,5})$/i.exec(a.name || '') || [])[1] || '';
    return '<a class="tk-att tk-file" href="' + escapeHtml(a.url) + '" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(t('chats.download')) + '">' +
      '<span class="tk-file__ext">' + escapeHtml(ext.toUpperCase() || '?') + '</span>' +
      '<span class="tk-file__body"><span class="tk-file__name">' + escapeHtml(a.name) + '</span>' +
      '<span class="tk-file__size">' + escapeHtml(fileSize(a.size || 0)) + '</span></span>' +
      '<svg class="tk-file__dl" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path></svg></a>';
  }

  // Подпись сообщения в списке диалогов и в окне пересылки: текст, а у файла —
  // «Фото», «Голосовое» и т. п. перед подписью. Уже экранировано.
  function summaryHtml(m) {
    if (m.expired || m.limit) {
      var k = m.expired ? 'chats.gone' : 'chats.sealed.' + ((m.attachments[0] || {}).kind || 'text');
      return '<span data-i18n="' + k + '">' + escapeHtml(t(k)) + '</span>';
    }
    var a = m.attachments && m.attachments[0];
    var label = a ? '<span data-i18n="chats.att.' + a.kind + '">' + escapeHtml(t('chats.att.' + a.kind)) + '</span>' : '';
    return label + (label && m.content ? ' · ' : '') + escapeHtml(m.content || '');
  }

  function summaryText(m) {
    if (m.expired) return t('chats.gone');
    if (m.limit) return t('chats.sealed.' + ((m.attachments[0] || {}).kind || 'text'));
    var a = m.attachments && m.attachments[0];
    return (a ? t('chats.att.' + a.kind) + (m.content ? ' · ' : '') : '') + (m.content || '');
  }

  // ── Исчезающие ──────────────────────────────────────────────────────
  // Сообщение с ограничением (utils/messageLimit.js): в ленте — карточка
  // с условиями, содержимое сервер выдаёт только получателю по «Открыть».
  // Текст, звук и кружок раскрываются прямо в ленте (revealed), фото
  // и видео — окном просмотра (viewing). Исчерпано — заглушка «исчезло».
  var FLAME = '<path d="M12 3c1 4 5 5.5 5 10a5 5 0 01-10 0c0-2.5 1.5-3.5 2-5 1 1.5 1.5 2.5 3 3 .5-3-1-5.5 0-8z"></path>';
  var revealed = {};        // id → { content, att, until }
  var viewing = null;       // id исчезающего, открытого окном просмотра

  function span(sec) {
    sec = Math.max(0, Math.ceil(sec));
    if (sec >= 3600) return t('chats.unit.h', { n: Math.round(sec / 3600) });
    if (sec >= 60) return t('chats.unit.m', { n: Math.round(sec / 60) });
    return t('chats.unit.s', { n: sec });
  }

  function policy(l) {
    if (l.mode === 'timer') {
      return l.until ? t('chats.policy.running', { t: span((new Date(l.until) - Date.now()) / 1000) }) : t('chats.policy.timer', { t: span(l.seconds) });
    }
    var left = Math.max(0, l.n - l.used);
    if (l.mode === 'downloads') return t('chats.policy.downloads', { left: left, n: l.n });
    return l.n === 1 ? t('chats.policy.once') : t('chats.policy.views', { left: left, n: l.n });
  }

  function sealedHtml(m) {
    var kind = (m.attachments[0] || {}).kind || 'text';
    var l = m.limit;
    var mine = m.sender === ME;
    var hint = mine ? t(l.opened ? 'chats.sealed.opened' : 'chats.sealed.notOpened')
      : t(kind === 'file' ? 'chats.sealed.tapDownload' : 'chats.sealed.tapOpen');
    var inner = '<span class="tk-sealed__icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">' + FLAME + '</svg></span>' +
      '<span class="tk-sealed__body"><span class="tk-sealed__kind">' + escapeHtml(t('chats.sealed.' + kind)) + '</span>' +
      '<span class="tk-sealed__policy"' + (l.until ? ' data-until="' + escapeHtml(l.until) + '"' : '') + '>' + escapeHtml(policy(l)) + '</span>' +
      '<span class="tk-sealed__hint">' + escapeHtml(hint) + '</span></span>';
    return mine ? '<div class="tk-sealed">' + inner + '</div>'
      : '<button type="button" class="tk-sealed" data-open-sealed="' + escapeHtml(m._id) + '">' + inner + '</button>';
  }

  // Раскрытое в ленте: текст или звук и полоса с условиями; у просмотров —
  // «Скрыть» (закрыть и стереть), у таймера — сколько осталось.
  function revealedHtml(m, r) {
    var bar = '<span class="tk-sealed__bar"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">' + FLAME + '</svg>' +
      '<span class="tk-sealed__policy"' + (r.until && m.limit.mode === 'timer' ? ' data-until="' + escapeHtml(r.until) + '"' : '') + '>' + escapeHtml(policy(m.limit)) + '</span>' +
      (m.limit.mode === 'timer' ? '' : '<button type="button" class="tk-sealed__hide" data-hide-sealed="' + escapeHtml(m._id) + '">' + escapeHtml(t('chats.sealed.hide')) + '</button>') + '</span>';
    return (r.att ? attachmentHtml(r.att) : '') + (r.content ? '<p class="tk-msg__text">' + escapeHtml(r.content) + '</p>' : '') + bar;
  }

  function goneHtml() {
    return '<div class="tk-sealed is-gone"><span class="tk-sealed__icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M6 18L18 6"></path></svg></span>' +
      '<span class="tk-sealed__kind">' + escapeHtml(t('chats.gone')) + '</span></div>';
  }

  function messageHtml(m, g) {
    var out = m.sender === ME;
    var f = m.forwardedFrom;
    g = g || { first: true, last: true, name: null };
    var head = '';
    if (f) {
      if (g.first) head += '<span class="tk-msg__fwd-head">' + escapeHtml(t('chats.forwarded')) + '</span>';
      if (g.first || g.name !== f.name) {
        head += '<span class="tk-msg__fwd-name">' + escapeHtml(f.name) +
          (f.sentAt ? ' <time>' + escapeHtml(tkDate(f.sentAt, FWD_TIME)) + '</time>' : '') + '</span>';
      }
    }
    var body;
    var bare = false;
    if (m.expired) body = goneHtml();
    else if (m.limit && revealed[m._id]) body = revealedHtml(m, revealed[m._id]);
    else if (m.limit) body = sealedHtml(m);
    else {
      var att = (m.attachments || []).map(attachmentHtml).join('');
      // Картинка, видео или кружок без подписи — пузырь без полей.
      bare = att && !m.content && !head && /^(image|video|round)$/.test(m.attachments[0].kind);
      body = att + (m.content ? '<p class="tk-msg__text">' + escapeHtml(m.content) + '</p>' : '');
    }
    var special = m.expired || m.limit || (m.attachments && m.attachments.length);
    var bubble = '<div class="tk-msg__bubble' + (special ? ' has-att' : '') + (bare ? ' is-bare' : '') + (m.limit || m.expired ? ' is-sealed' : '') + '" tabindex="0" role="button" aria-haspopup="menu" aria-label="' + escapeHtml(t('chats.actions')) + '">' +
      head + body + '</div>';
    var when = '<time>' + escapeHtml(tkDate(m.sentAt)) + '</time>';
    if (out) {
      var s = status(m);
      when += ' <svg class="tk-msg__tick ' + s.cls + '" viewBox="0 0 22 24" width="17" height="16" fill="none" stroke="currentColor" stroke-width="2" role="img" aria-label="' +
        escapeHtml(t(s.key)) + '"><title>' + escapeHtml(t(s.key)) + '</title>' + s.icon + '</svg>';
    }
    var key = 'm:' + m._id;
    var cls = 'tk-msg ' + (out ? 'tk-msg--out' : 'tk-msg--in') + (isPicked(key) ? ' is-picked' : '') +
      (f ? ' tk-msg--fwd' + (g.first ? ' is-first' : '') + (g.last ? ' is-last' : '') : '');
    // Аватар собеседника — у первого в пачке; у остальных место под него
    // остаётся, чтобы рамка пачки шла ровным столбцом.
    var ava = avatar('tk-msg__ava' + (g.first ? '' : ' is-blank'), peer, g.first ? ' data-peer' : ' aria-hidden="true"');
    return '<div class="' + cls + '" data-mid="' + escapeHtml(m._id) + '" data-key="' + escapeHtml(key) + '">' +
      (out ? bubble : '<div class="tk-msg__row">' + ava + bubble + '</div>') +
      (g.last ? '<p class="tk-msg__when">' + when + '</p>' : '') + '</div>';
  }

  // Место каждого сообщения в пачке пересланного: соседи в ленте с той же
  // пачкой и тем же отправителем. Звонок посередине пачку разрывает.
  function groups(items) {
    items.forEach(function (x, i) {
      if (!x.m) return;
      var batch = x.m.forwardedFrom && x.m.forwardedFrom.batch;
      var same = function (y) {
        return y && y.m && batch && y.m.sender === x.m.sender && y.m.forwardedFrom && y.m.forwardedFrom.batch === batch;
      };
      var prev = items[i - 1], next = items[i + 1];
      x.g = { first: !same(prev), last: !same(next), name: same(prev) ? prev.m.forwardedFrom.name : null };
    });
  }

  // ── Звонки ────────────────────────────────────────────────────────────
  // Одна запись приходит обоим (utils/callLog.js): входящий он или исходящий,
  // пропущенный или отменённый — решаем здесь. Те же подписи у вкладки
  // «Звонки» и у строки звонка в ленте.
  var PHONE = '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2Z"></path>';
  var CAMERA = '<rect x="3" y="6" width="12" height="12"></rect><path d="M15 10l6-3v10l-6-3"></path>';
  var CALL_TIME = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };

  function callInfo(c) {
    var out = c.caller === ME;
    var missed = !out && (c.status === 'missed' || c.status === 'canceled');
    var outcome = missed ? 'calls.missed'
      : c.status === 'declined' ? 'calls.declined'
      : c.status === 'failed' ? 'calls.failed'
      : out && c.status === 'canceled' ? 'calls.canceled'
      : out && c.status === 'missed' ? 'calls.noAnswer'
      : '';
    var parts = [t((out ? 'calls.out.' : 'calls.in.') + c.type)];
    if (outcome) parts.push(t(outcome));
    if (c.duration) parts.push(Math.floor(c.duration / 60) + ':' + String(c.duration % 60).padStart(2, '0'));
    return { out: out, missed: missed, text: parts.join(' · ') };
  }

  // Строка звонка выделяется и удаляется так же, как сообщение: у неё тот же
  // data-key и та же доступность с клавиатуры.
  function callNoteHtml(c) {
    var info = callInfo(c);
    var key = 'c:' + c.id;
    return '<div class="tk-callnote' + (info.missed ? ' is-missed' : '') + (isPicked(key) ? ' is-picked' : '') +
      '" data-key="' + escapeHtml(key) + '" tabindex="0" role="button" aria-haspopup="menu" aria-label="' + escapeHtml(t('chats.callActions')) + '">' +
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" aria-hidden="true">' +
      (c.type === 'video' ? CAMERA : PHONE) + '</svg>' +
      '<span>' + escapeHtml(info.text) + '</span>' +
      '<time>' + escapeHtml(tkDate(c.startedAt, CALL_TIME)) + '</time></div>';
  }

  function render() {
    var waiting = uploads.filter(function (u) { return peer && u.peerId === peer.id; }).map(uploadHtml).join('');
    if (!messages.length && !calls.length) {
      feed.innerHTML = waiting || '<p class="tk-note tk-note--center">' + escapeHtml(t('chats.dialogEmpty')) + '</p>';
      return;
    }
    var items = messages.map(function (m) { return { at: m.sentAt, m: m }; })
      .concat(calls.map(function (c) { return { at: c.startedAt, c: c }; }));
    items.sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
    groups(items);
    feed.innerHTML = items.map(function (x) { return x.m ? messageHtml(x.m, x.g) : callNoteHtml(x.c); }).join('') + waiting;
    if (sound.el) relinkSound();
    if (roundPlayer.url) relinkRound();
  }

  function atBottom() {
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  }

  function scrollToBottom() {
    feed.scrollTop = feed.scrollHeight;
  }

  function merge(fresh, freshCalls) {
    var seen = {};
    messages.forEach(function (m) { seen[m._id] = true; });
    fresh.forEach(function (m) { if (!seen[m._id]) messages.push(m); });
    messages.sort(function (a, b) { return new Date(a.sentAt) - new Date(b.sentAt); });
    (freshCalls || []).forEach(function (c) {
      if (!calls.some(function (x) { return x.id === c.id; })) calls.push(c);
    });
  }

  // Страница истории: сообщения старше before (без него — последние)
  // и звонки за тот же отрезок.
  function load(recipientId, before) {
    return fetch('/getMessages?recipientId=' + encodeURIComponent(recipientId) + (before ? '&before=' + encodeURIComponent(before) : ''))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  function openHistory() {
    var id = peer.id;
    load(id).then(function (page) {
      if (!peer || peer.id !== id) return;
      messages = page.messages;
      calls = page.calls;
      allLoaded = page.messages.length < PAGE;
      render();
      scrollToBottom();
      markRead();
    }).catch(function (e) { console.error('getMessages:', e); });
  }

  // Прокрутили к началу — дозагрузка старых. Высоту запоминаем до отрисовки,
  // иначе лента прыгает.
  // Пока первая страница не пришла, сообщений нет и дозагружать не от чего:
  // открытие диалога очищает ленту, и прокрутка срабатывала раньше истории
  // (TypeError 'sentAt' из журнала ошибок, 17.09).
  feed.addEventListener('scroll', function () {
    if (!peer || loadingOld || allLoaded || !messages.length || feed.scrollTop > 40) return;
    loadingOld = true;
    var id = peer.id;
    load(id, messages[0].sentAt).then(function (page) {
      if (!peer || peer.id !== id) return;
      allLoaded = page.messages.length < PAGE;
      var before = feed.scrollHeight;
      merge(page.messages, page.calls);
      render();
      feed.scrollTop = feed.scrollHeight - before;
    }).catch(function (e) { console.error('getMessages (старые):', e); })
      .finally(function () { loadingOld = false; });
  });

  // ── Прочтение ─────────────────────────────────────────────────────────
  // Входящие открытого диалога читаются, только пока вкладку видно: иначе
  // собеседник видел бы «прочитано» у сообщения, которого никто не видел.
  function markRead() {
    if (!peer || document.visibilityState !== 'visible') return;
    var unread = messages.some(function (m) { return m.sender === peer.id && !m.readAt; });
    var el = dialogEl(peer.id);
    var badge = el && el.querySelector('.tk-dialog__unread');
    if (!unread && !(badge && !badge.classList.contains('hidden'))) return;
    var now = new Date().toISOString();
    messages.forEach(function (m) { if (m.sender === peer.id && !m.readAt) m.readAt = now; });
    if (badge) { badge.textContent = '0'; badge.classList.add('hidden'); }
    post('/messages/read', { peerId: peer.id })
      .then(function (r) {
        if (window.setNotificationDot) window.setNotificationDot(r.unread > 0);
        if (window.tkChatBadge) window.tkChatBadge({ messages: r.unreadMessages });
      })
      .catch(function (e) { console.error('read:', e); });
  }

  document.addEventListener('visibilitychange', markRead);

  // ── Список диалогов ───────────────────────────────────────────────────
  function setLast(el, m) {
    var last = el.querySelector('.tk-dialog__last');
    last.innerHTML = (m.sender === ME ? '<span data-i18n="chats.you">' + escapeHtml(t('chats.you')) + '</span> ' : '') + summaryHtml(m);
    var when = el.querySelector('.tk-dialog__when');
    when.setAttribute('data-time', m.sentAt);
    when.textContent = timeAgo(m.sentAt);
    list.prepend(el);
  }

  function addDialog(p) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'tk-dialog';
    el.setAttribute('data-id', p.id);
    el.setAttribute('data-name', p.displayName);
    el.setAttribute('data-ava-url', p.avatarStyle.url || '');
    el.setAttribute('data-ava-bg', p.avatarStyle.gradient || '');
    el.setAttribute('data-ava-initial', p.avatarStyle.initial || '');
    el.setAttribute('data-presence-user', p.id);
    el.innerHTML =
      avatar('tk-dialog__ava', peerOf(el)) +
      '<span class="tk-dialog__body">' +
        '<span class="tk-dialog__top"><span class="tk-dialog__who"><span class="tk-dialog__name">' + escapeHtml(p.displayName) + '</span>' +
        '<span class="presence-dot presence-offline"></span></span><span class="tk-dialog__when"></span></span>' +
        '<span class="tk-dialog__bottom"><span class="tk-dialog__last"></span><span class="tk-dialog__unread hidden">0</span></span>' +
      '</span>';
    list.prepend(el);
    $('conversationsEmpty').classList.add('hidden');
    if (window.subscribePresence) window.subscribePresence([p.id]);
    return el;
  }

  list.addEventListener('click', function (e) {
    var el = e.target.closest('.tk-dialog');
    if (el) select(el);
  });

  // ── Недавние ──────────────────────────────────────────────────────────
  // Лента над списком диалогов: кто ближе и чаще (utils/recentPeers.js).
  // Порядок приходит от сервера один раз, при открытии страницы; дальше его
  // двигает сама страница — написали или позвонили, и человек уезжает
  // в начало, не дожидаясь перезагрузки.
  var recentBox = $('recentPeers');
  var recentRow = $('recentRow');
  var RECENT_MAX = 12;

  function recentEl(id) {
    return recentRow.querySelector('.tk-recent__item[data-id="' + CSS.escape(String(id)) + '"]');
  }

  // p — как у addDialog: { id, displayName, avatarStyle }.
  function recentAdd(p) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'tk-recent__item';
    el.setAttribute('data-id', p.id);
    el.setAttribute('data-name', p.displayName);
    el.setAttribute('data-ava-url', (p.avatarStyle || {}).url || '');
    el.setAttribute('data-ava-bg', (p.avatarStyle || {}).gradient || '');
    el.setAttribute('data-ava-initial', (p.avatarStyle || {}).initial || '');
    el.setAttribute('data-presence-user', p.id);
    el.title = p.displayName;
    var a = peerOf(el);
    el.innerHTML =
      avatar('tk-recent__ava', a, ' data-slot="ava"') +
      '<span class="tk-recent__name">' + escapeHtml(p.displayName) + '</span>';
    el.querySelector('[data-slot="ava"]').insertAdjacentHTML('beforeend', '<span class="presence-dot presence-offline"></span>');
    if (window.subscribePresence) window.subscribePresence([p.id]);
    return el;
  }

  // Наверх ленты: уже был — переставляем, не был — заводим. Хвост длиннее
  // дюжины обрезаем: ряд прокручивается, но бесконечным ему быть незачем.
  function bumpRecent(p) {
    if (!p || !p.id || p.id === ME) return;
    var el = recentEl(p.id) || recentAdd(p);
    if (recentRow.firstChild !== el) recentRow.prepend(el);
    while (recentRow.children.length > RECENT_MAX) recentRow.lastChild.remove();
    if (!callsList.hidden) return; // на вкладке звонков ленту не показываем
    recentBox.hidden = false;
  }

  recentRow.addEventListener('click', function (e) {
    var el = e.target.closest('.tk-recent__item');
    if (!el) return;
    var r = peerOf(el);
    openPeer({ id: r.id, displayName: r.name, avatarStyle: { url: r.url, gradient: r.bg, initial: r.initial } });
  });

  // ── Выбор диалога ─────────────────────────────────────────────────────
  function select(el) {
    closeAllSealed();
    stopVoice(false);
    stopPicking();
    closeMenu();
    peer = peerOf(el);
    messages = [];
    calls = [];
    allLoaded = false;
    feed.innerHTML = '';
    setTab('messages');

    list.querySelectorAll('.tk-dialog').forEach(function (d) {
      d.classList.toggle('tk-dialog--on', d === el);
    });

    $('peerName').textContent = peer.name;
    // Аватар ведёт в профиль, как и имя рядом.
    $('chatAvatar').outerHTML = avatar('tk-chat__ava-big', peer,
      ' id="chatAvatar" href="/userPage/' + encodeURIComponent(peer.id) + '" aria-label="' + escapeHtml(peer.name) + '"', 'a');

    var presence = $('chatHeaderPresence');
    presence.setAttribute('data-presence-user', peer.id);
    if (window.subscribePresence) window.subscribePresence([peer.id]);
    fetch('/api/presence?ids=' + encodeURIComponent(peer.id))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var u = (data.users || [])[0];
        if (u) window.dispatchEvent(new CustomEvent('presence:init', { detail: u }));
      })
      .catch(function () {});

    input.removeAttribute('data-i18n-placeholder');
    input.placeholder = t('chats.messageTo') + ' ' + peer.name + '…';

    history.replaceState(null, '', '/chatsPage?peer=' + encodeURIComponent(peer.id));
    // has-peer — показать правую часть, is-open — на узком экране она
    // вместо списка.
    $('chat').classList.add('has-peer', 'is-open');
    openHistory();
  }

  function closeDialog() {
    closeAllSealed();
    stopVoice(false);
    stopPicking();
    closeMenu();
    peer = null;
    messages = [];
    calls = [];
    feed.innerHTML = '';
    list.querySelectorAll('.tk-dialog--on').forEach(function (d) { d.classList.remove('tk-dialog--on'); });
    input.setAttribute('data-i18n-placeholder', 'chats.messagePh');
    input.placeholder = t('chats.messagePh');
    history.replaceState(null, '', '/chatsPage');
    $('chat').classList.remove('has-peer', 'is-open');
  }

  $('backToList').addEventListener('click', function () {
    $('chat').classList.remove('is-open');
  });

  function goToPeer() {
    if (peer) location.href = '/userPage/' + encodeURIComponent(peer.id);
  }
  $('peerLink').addEventListener('click', goToPeer);

  // ── Отправка ──────────────────────────────────────────────────────────
  $('composeForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (rec) return stopVoice(true);
    var content = input.value.trim();
    if (!peer || !content) return;
    input.value = '';
    var limit = limitOpt;
    setLimit('');
    post('/sendMessage', { recipientId: peer.id, content: content, limit: limit })
      .then(function (m) {
        merge([m]);
        render();
        scrollToBottom();
        var el = dialogEl(m.recipient);
        if (el) setLast(el, m);
      })
      .catch(function (err) {
        console.error('sendMessage:', err);
        if (!input.value) { input.value = content; setLimit(limit); } // текст не теряем
        toast(t('chats.sendFailed'), 'error');
      });
  });

  // ── Отправка файлов ───────────────────────────────────────────────────
  // Файлы уходят по одному, в порядке выбора; пока идут, в конце ленты
  // стоит заглушка с полосой загрузки. Текст из поля — подпись к первому.
  // Видео сервер пережимает со знаком: ответ 202 приходит сразу, а готовое
  // сообщение — сокетом, с тем же ref (tk:message:new или tk:message:failed).
  var uploads = [];         // { ref, peerId, name, kind, pct, state, xhr, error }
  var sending = false;

  function uploadHtml(u) {
    var state = u.state === 'failed' ? escapeHtml(u.error || t('chats.uploadFailed'))
      : u.state === 'processing' ? escapeHtml(t('chats.processing'))
      : escapeHtml(t('chats.uploading')) + ' ' + u.pct + '%';
    return '<div class="tk-msg tk-msg--out tk-msg--pending' + (u.state === 'failed' ? ' is-failed' : '') + '" data-ref="' + escapeHtml(u.ref) + '">' +
      '<div class="tk-msg__bubble has-att"><div class="tk-upload">' +
        '<span class="tk-upload__name">' + escapeHtml(u.name) + '</span>' +
        '<span class="tk-upload__bar' + (u.state === 'processing' ? ' is-busy' : '') + '"><i style="width:' + (u.state === 'uploading' ? u.pct : 100) + '%"></i></span>' +
        '<span class="tk-upload__state">' + state + '</span>' +
        (u.state === 'processing' ? '' : '<button type="button" class="tk-upload__x" data-drop-upload="' + escapeHtml(u.ref) + '" aria-label="' + escapeHtml(t('chats.uploadCancel')) + '">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button>') +
      '</div></div></div>';
  }

  function uploadEl(ref) { return feed.querySelector('[data-ref="' + CSS.escape(ref) + '"]'); }

  // Перерисовать одну заглушку, не всю ленту: прогресс меняется часто.
  function redrawUpload(u) {
    var el = uploadEl(u.ref);
    if (el) el.outerHTML = uploadHtml(u);
  }

  function dropUpload(ref) {
    uploads = uploads.filter(function (u) {
      if (u.ref !== ref) return true;
      if (u.watch) clearInterval(u.watch);
      return false;
    });
    var el = uploadEl(ref);
    if (el) el.remove();
  }

  // Видео и кружок сервер пережимает в фоне: в ответ приходит 202, а готовое
  // сообщение — сокетом (routes/streaming/messages.js). Сокета в эту минуту
  // может не быть — у человека за прокси он может не встать вовсе, — и тогда
  // заглушка «Обрабатываем видео…» висела бы вечно: отправленного кружка
  // не видел бы даже сам отправитель. Сторож перечитывает переписку и снимает
  // заглушку, когда сообщение в ней нашлось.
  //
  // Узнаём его по виду вложения и времени: ref до базы не доходит, он метка
  // вкладки. Два кружка подряд сторож может перепутать между собой — на итог
  // это не влияет, оба сообщения на месте, снимутся обе заглушки.
  var WATCH_EVERY = 20000;
  var WATCH_TRIES = 15;   // пять минут — дольше любого пережатия

  function watchProcessing(u) {
    var since = Date.now();
    var tries = 0;
    u.watch = setInterval(function () {
      if (u.state !== 'processing') return clearInterval(u.watch);
      if (++tries > WATCH_TRIES) {
        clearInterval(u.watch);
        failUpload(u);
        return;
      }
      load(u.peerId).then(function (page) {
        var found = page.messages.some(function (m) {
          return m.sender === ME && new Date(m.sentAt).getTime() >= since &&
            m.attachments && m.attachments[0] && m.attachments[0].kind === u.kind;
        });
        if (!found) return;
        dropUpload(u.ref);
        if (peer && peer.id === u.peerId) openHistory();
      }).catch(function () {});
    }, WATCH_EVERY);
  }

  function kindOf(file, special) {
    if (special) return special;
    var type = file.type || '';
    return /^image\//.test(type) ? 'image' : /^video\//.test(type) ? 'video' : /^audio\//.test(type) ? 'audio' : 'file';
  }

  // special — 'voice' или 'round': записанное на странице. Выбранное
  // ограничение действует на всю пачку и после неё сбрасывается.
  function queueFiles(files, special) {
    if (!peer || !files.length) return;
    var caption = input.value.trim();
    var limit = limitOpt;
    input.value = '';
    setLimit('');
    Array.prototype.forEach.call(files, function (file, i) {
      uploads.push({
        ref: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        peerId: peer.id, file: file, special: special || '', limit: limit, caption: i === 0 ? caption : '',
        name: special ? t('chats.att.' + special) : file.name, kind: kindOf(file, special), pct: 0, state: 'queued'
      });
    });
    render();
    scrollToBottom();
    pump();
  }

  function pump() {
    if (sending) return;
    var u = uploads.find(function (x) { return x.state === 'queued'; });
    if (!u) return;
    sending = true;
    u.state = 'uploading';
    redrawUpload(u);
    var form = new FormData();
    form.append('recipientId', u.peerId);
    form.append('content', u.caption);
    form.append('ref', u.ref);
    if (u.special) form.append('special', u.special);
    if (u.limit) form.append('limit', u.limit);
    form.append('file', u.file, u.file.name);

    var xhr = u.xhr = new XMLHttpRequest();
    xhr.open('POST', '/messages/attach');
    xhr.responseType = 'json';
    // Без него ошибка приходит страницей, и причина отказа теряется.
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      var pct = Math.min(99, Math.floor(e.loaded / e.total * 100));
      if (pct === u.pct) return;
      u.pct = pct;
      var bar = uploadEl(u.ref);
      if (!bar) return;
      bar.querySelector('.tk-upload__bar i').style.width = pct + '%';
      bar.querySelector('.tk-upload__state').textContent = t('chats.uploading') + ' ' + pct + '%';
    };
    xhr.onload = function () {
      var data = xhr.response || {};
      if (xhr.status === 202) {
        u.state = 'processing';
        u.file = null;
        redrawUpload(u);
        watchProcessing(u);
      } else if (xhr.status >= 200 && xhr.status < 300) {
        dropUpload(u.ref);
        delivered(data);
      } else {
        failUpload(u, data.message);
      }
      next();
    };
    xhr.onerror = function () { failUpload(u); next(); };
    xhr.onabort = next;
    xhr.send(form);

    function next() { u.xhr = null; sending = false; pump(); }
  }

  function failUpload(u, message) {
    if (u.watch) { clearInterval(u.watch); u.watch = null; }
    u.state = 'failed';
    u.error = message || t('chats.uploadFailed');
    u.file = null;
    redrawUpload(u);
    toast(u.error, 'error');
  }

  // Своё сообщение готово: в ленту и наверх списка диалогов.
  function delivered(m) {
    if (peer && (m.recipient === peer.id)) {
      merge([m]);
      render();
      scrollToBottom();
    }
    var el = dialogEl(m.recipient);
    if (el) setLast(el, m);
  }

  feed.addEventListener('click', function (e) {
    var x = e.target.closest('[data-drop-upload]');
    if (!x) return;
    var ref = x.getAttribute('data-drop-upload');
    var u = uploads.find(function (y) { return y.ref === ref; });
    if (u && u.xhr) u.xhr.abort();
    dropUpload(ref);
  });

  var fileInput = $('attachInput');
  $('attachBtn').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    queueFiles(Array.prototype.slice.call(fileInput.files));
    fileInput.value = '';
  });

  // Снимок из буфера — вставкой в поле.
  input.addEventListener('paste', function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (!files || !files.length) return;
    e.preventDefault();
    queueFiles(Array.prototype.slice.call(files));
  });

  // Перетаскивание в открытый диалог. Счётчик — потому что dragenter
  // и dragleave приходят от каждого вложенного элемента.
  var area = document.querySelector('.tk-chat__area');
  var drop = $('dropZone');
  var dragDepth = 0;
  var hasFiles = function (e) { return peer && e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1; };
  area.addEventListener('dragenter', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    drop.hidden = false;
  });
  area.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
  area.addEventListener('dragleave', function () {
    if (dragDepth && --dragDepth === 0) drop.hidden = true;
  });
  area.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    drop.hidden = true;
    queueFiles(Array.prototype.slice.call(e.dataTransfer.files));
  });

  // ── Голосовое ─────────────────────────────────────────────────────────
  // Микрофон держат — идёт запись, отпустили — ушла: так это сделано
  // в мессенджерах, и так не нужна кнопка отмены, которая налезала на полосу
  // записи. Чтобы отменить, палец (или курсор) уводят от микрофона в сторону
  // и отпускают там. Вместо голого таймера — живая волна: видно, что запись
  // идёт и что микрофон слышит. Пять минут — предел сервера, на нём запись
  // отправляется сама. Chrome и Firefox пишут webm/opus, Safari — mp4/aac.
  var VOICE_MAX = 5 * 60;
  var CANCEL_AWAY = 60;     // на сколько увести от кнопки, чтобы запись отменилась
  var WAVE_BARS = 28;
  var composeForm = $('composeForm');
  var micBtn = $('micBtn');
  var recBar = $('recBar');
  var recWave = $('recWave');
  var recHint = $('recHint');
  var rec = null;           // { recorder, stream, chunks, started, timer, send, meter }
  var voiceHold = false;    // микрофон ещё держат
  var voiceKeep = true;     // отпустят здесь — отправим, в стороне — выбросим
  var micBox = null;        // рамка кнопки, снятая на нажатии: за запись она не двигается

  function say(el, key) {
    el.setAttribute('data-i18n', key);
    el.textContent = t(key);
  }

  function voiceType() {
    if (!window.MediaRecorder) return null;
    var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (var i = 0; i < types.length; i++) if (MediaRecorder.isTypeSupported(types[i])) return types[i];
    return '';
  }

  // Волна: полоски заводим один раз, дальше самую старую переносим в конец
  // и задаём ей высоту — одна перестановка на кадр вместо перерисовки всей.
  function waveReset() {
    if (!recWave.firstChild) {
      var f = document.createDocumentFragment();
      for (var i = 0; i < WAVE_BARS; i++) f.appendChild(document.createElement('i'));
      recWave.appendChild(f);
    }
    for (var b = recWave.firstElementChild; b; b = b.nextElementSibling) b.style.height = '';
  }

  function waveStep(level) {
    var bar = recWave.firstElementChild;
    bar.style.height = (6 + level * 94).toFixed(0) + '%';
    recWave.appendChild(bar);
  }

  // Громкость берём анализатором: MediaRecorder её не отдаёт. Нет Web Audio —
  // волна просто стоит, запись от этого не страдает.
  function meterOn(stream) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      var ctx = new AC();
      var node = ctx.createAnalyser();
      node.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(node);
      return { ctx: ctx, node: node, data: new Uint8Array(node.fftSize) };
    } catch (e) { return null; }
  }

  function meterLevel(m) {
    m.node.getByteTimeDomainData(m.data);
    var sum = 0;
    for (var i = 0; i < m.data.length; i++) { var v = (m.data[i] - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / m.data.length) * 3.2);
  }

  function recording(on) {
    composeForm.classList.toggle('is-recording', on);
    recBar.hidden = !on;
    micBtn.setAttribute('aria-label', t(on ? 'chats.voiceSend' : 'chats.voice'));
    micBtn.title = micBtn.getAttribute('aria-label');
    if (!on) voiceAim(true);
  }

  // Палец увели от кнопки — отпускание отменит запись. Подпись меняется
  // сразу, чтобы это было видно до того, как палец подняли.
  function voiceAim(keep) {
    if (keep === voiceKeep) return;
    voiceKeep = keep;
    recBar.classList.toggle('is-cancel', !keep);
    say(recHint, keep ? 'chats.recHint' : 'chats.recCancelHint');
  }

  function startVoice() {
    if (rec || !peer) return;
    var type = voiceType();
    if (type === null || !navigator.mediaDevices) return toast(t('chats.recUnsupported'), 'error');
    voiceHold = true;
    micBox = micBtn.getBoundingClientRect();
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      // Пока браузер спрашивал разрешение, кнопку могли отпустить.
      // Так бывает при первом разрешении: кнопку отпускают, чтобы нажать
      // «Разрешить». Молчать нельзя — подсказываем, что теперь её держат.
      if (!voiceHold || !peer) {
        stream.getTracks().forEach(function (tr) { tr.stop(); });
        if (peer) toast(t('chats.recHold'));
        return;
      }
      var recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
      rec = { recorder: recorder, stream: stream, chunks: [], started: Date.now(), send: false, peerId: peer.id, meter: meterOn(stream) };
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) rec.chunks.push(e.data); };
      recorder.onstop = finishVoice;
      recorder.start(1000);
      waveReset();
      $('recTime').textContent = '0:00';
      var shown = 0;
      rec.timer = setInterval(function () {
        var sec = Math.floor((Date.now() - rec.started) / 1000);
        if (sec !== shown) { shown = sec; $('recTime').textContent = clock(sec); }
        if (rec.meter) waveStep(meterLevel(rec.meter));
        if (sec >= VOICE_MAX) { voiceHold = false; stopVoice(true); }
      }, 80);
      recording(true);
    }).catch(function () { voiceHold = false; toast(t('chats.micDenied'), 'error'); });
  }

  function stopVoice(send) {
    if (!rec) return;
    rec.send = send;
    clearInterval(rec.timer);
    if (rec.recorder.state !== 'inactive') rec.recorder.stop();
    else finishVoice();
  }

  // Микрофон бросаем и не отправляем — из тех мест, где начинается что-то
  // другое: запись кружка, уход со страницы.
  function cancelVoice() {
    voiceHold = false;
    stopVoice(false);
  }

  function finishVoice() {
    var r = rec;
    rec = null;
    recording(false);
    r.stream.getTracks().forEach(function (tr) { tr.stop(); });
    if (r.meter) try { r.meter.ctx.close(); } catch (e) {}
    // Короткое нажатие — не запись, а промах по кнопке: подсказываем, что её
    // надо держать. Молча ничего не делать хуже: кажется, что не работает.
    if (Date.now() - r.started < 700) { if (r.send) toast(t('chats.recHold')); return; }
    if (!r.send || !r.chunks.length) return;
    if (!peer || peer.id !== r.peerId) return;
    var type = r.recorder.mimeType || r.chunks[0].type || 'audio/webm';
    var ext = /mp4/.test(type) ? 'm4a' : 'webm';
    var blob = new Blob(r.chunks, { type: type.split(';')[0] });
    queueFiles([new File([blob], 'voice.' + ext, { type: blob.type })], 'voice');
  }

  // Нажатие ловим на кнопке, отпускание — на всём документе: палец к этому
  // времени может быть где угодно, в том числе за окном.
  micBtn.addEventListener('pointerdown', function (e) {
    if (e.button) return;
    startVoice();
  });

  // Android на удержании шлёт contextmenu — меню над кнопкой записи ни к чему.
  micBtn.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // Далеко ли указатель от кнопки. Считаем и на движении (чтобы подпись
  // менялась заранее), и на отпускании: указатель может оказаться в стороне
  // и без единого pointermove — например, после прокрутки страницы.
  function nearMic(e) {
    if (!micBox) return true;
    var dx = Math.max(micBox.left - e.clientX, e.clientX - micBox.right, 0);
    var dy = Math.max(micBox.top - e.clientY, e.clientY - micBox.bottom, 0);
    return dx * dx + dy * dy < CANCEL_AWAY * CANCEL_AWAY;
  }

  document.addEventListener('pointermove', function (e) {
    if (voiceHold) voiceAim(nearMic(e));
  });

  document.addEventListener('pointerup', function (e) {
    if (!voiceHold) return;
    voiceHold = false;
    stopVoice(nearMic(e));
  });

  document.addEventListener('pointercancel', cancelVoice);

  // С клавиатуры кнопку так же «держат»: пробел или Enter. preventDefault
  // снимает и повтор нажатия, и click, который иначе пришёл бы следом.
  micBtn.addEventListener('keydown', function (e) {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (!e.repeat) startVoice();
  });

  micBtn.addEventListener('keyup', function (e) {
    if ((e.key !== ' ' && e.key !== 'Enter') || !voiceHold) return;
    voiceHold = false;
    stopVoice(true);
  });

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && rec) cancelVoice(); });

  // ── Когда медиа не играет ─────────────────────────────────────────────
  // Кружки и голосовые лежат на стороннем домене (Bunny, utils/storage.js),
  // и отказ их загрузки браузер сообщает событием error у элемента: промис
  // play() при этом может не отклониться вовсе. Раньше оба пути кончались
  // пустым catch — человек видел кружок, который «просто не открывается»,
  // и ни одной ошибки ни в консоли, ни в журнале. Теперь отказ видно ему
  // и видно нам: причину с чужого телефона иначе не узнать.
  //
  // Одна автоматическая попытка на сетевой отказ: на сотовой связи первый
  // запрос к CDN срывается заметно чаще следующего.
  var MEDIA_ERR = ['none', 'aborted', 'network', 'decode', 'unsupported'];
  var mediaRetried = {};

  function hostOf(url) {
    try { return new URL(url, location.href).host; } catch (e) { return '?'; }
  }

  // true — отказ сетевой и попытка пошла: звать mediaFailed рано.
  function mediaRetry(el, url) {
    if (!url || !el.error || el.error.code !== 2 || mediaRetried[url]) return false;
    mediaRetried[url] = 1;
    toast(t('chats.mediaRetry'));
    setTimeout(function () {
      if (el.currentSrc || el.src) { el.load(); el.play().catch(function () {}); }
    }, 700);
    return true;
  }

  function mediaFailed(kind, url, el) {
    var e = el.error;
    toast(t('chats.mediaFailed'), 'error');
    try {
      var body = JSON.stringify({
        page: location.pathname,
        name: 'MediaError',
        message: kind + ': ' + (e ? (MEDIA_ERR[e.code] || e.code) : 'no-error') + ' @ ' + hostOf(url),
        details: [
          'kind=' + kind,
          'host=' + hostOf(url),
          'code=' + (e ? e.code : '-') + ' ' + (e && e.message ? e.message : ''),
          'networkState=' + el.networkState + ' readyState=' + el.readyState,
          'online=' + navigator.onLine,
          'ua=' + navigator.userAgent
        ]
      });
      if (navigator.sendBeacon) navigator.sendBeacon('/api/client-error', new Blob([body], { type: 'application/json' }));
      else fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true });
    } catch (err) {}
  }

  // ── Звук в ленте ──────────────────────────────────────────────────────
  // Один проигрыватель на страницу: новое голосовое останавливает прежнее.
  // Ход — переменной --p у строки, волна и полоса красятся по ней в CSS.
  var sound = { audio: new Audio(), el: null, url: '' };
  sound.audio.preload = 'none';

  function soundState(playing) {
    var el = sound.el;
    if (!el) return;
    el.classList.toggle('is-playing', playing);
    var btn = el.querySelector('[data-play]');
    btn.setAttribute('aria-label', t(playing ? 'chats.pause' : 'chats.play'));
    btn.querySelector('svg').innerHTML = playing ? PAUSE : PLAY;
  }

  function soundTick() {
    var el = sound.el;
    if (!el) return;
    var a = sound.audio;
    var total = a.duration && isFinite(a.duration) ? a.duration : Number(el.getAttribute('data-duration')) || 0;
    el.style.setProperty('--p', total ? Math.min(1, a.currentTime / total) : 0);
    el.querySelector('.tk-audio__time').textContent = clock(a.currentTime > 0 ? a.currentTime : total);
  }

  // Лента перерисовалась — играющая строка теперь новый элемент.
  function relinkSound() {
    var el = feed.querySelector('[data-audio="' + CSS.escape(sound.url) + '"]');
    sound.el = el;
    if (!el) return;
    soundState(!sound.audio.paused);
    soundTick();
  }

  sound.audio.addEventListener('timeupdate', soundTick);
  sound.audio.addEventListener('play', function () { soundState(true); });
  sound.audio.addEventListener('pause', function () { soundState(false); });
  sound.audio.addEventListener('ended', function () {
    // Исчезающее голосовое дослушали — один просмотр израсходован.
    var sealed = sealedOf(sound.url);
    if (sealed) closeSealed(sealed);
    soundState(false);
    if (sound.el) {
      sound.el.style.setProperty('--p', 0);
      sound.el.querySelector('.tk-audio__time').textContent = clock(Number(sound.el.getAttribute('data-duration')));
    }
  });

  sound.audio.addEventListener('error', function () {
    if (!sound.url) return; // источник сняли сами — это не отказ
    if (mediaRetry(sound.audio, sound.url)) return;
    soundState(false);
    mediaFailed('voice', sound.url, sound.audio);
  });

  function playSound(el) {
    var url = el.getAttribute('data-audio');
    if (sound.url === url) {
      if (sound.audio.paused) sound.audio.play().catch(function () { soundState(false); }); else sound.audio.pause();
      return;
    }
    if (sound.el) { soundState(false); sound.el.style.setProperty('--p', 0); }
    sound.url = url;
    sound.el = el;
    sound.audio.src = url;
    // Отказ загрузки приходит отдельным событием error (см. выше): здесь
    // остаётся только запрет автозапуска — он не про файл и не про сеть.
    sound.audio.play().catch(function () { soundState(false); });
  }

  function seekSound(el, e) {
    if (sound.el !== el || !sound.audio.duration) return;
    var r = el.querySelector('[data-seek]').getBoundingClientRect();
    sound.audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * sound.audio.duration;
  }

  // ── Просмотр фото и видео ─────────────────────────────────────────────
  var box = $('lightbox');
  var videoBox = $('videoBox');
  var player = null;
  var playerLoading = null;

  // quiet — окно закрыл сервер (сообщение истекло): говорить ему «закрыто»
  // уже незачем.
  function closeViewers(quiet) {
    var was = !box.classList.contains('hidden') || !videoBox.classList.contains('hidden');
    box.classList.add('hidden');
    if (!videoBox.classList.contains('hidden')) {
      videoBox.classList.add('hidden');
      if (player) player.stop();
    }
    if (viewing) {
      // Исчезающее не оставляем в окне: адрес уже не отдаст файл.
      $('lightboxImg').removeAttribute('src');
      var id = viewing;
      viewing = null;
      onceTimer.hidden = true;
      if (quiet !== true) closeSealed(id);
    }
    return was;
  }

  // Плеер Takebana — только когда впервые понадобился: скрипт и стили.
  function loadPlayer() {
    if (window.TKPlayer) return Promise.resolve();
    if (playerLoading) return playerLoading;
    playerLoading = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = videoBox.getAttribute('data-player-css');
      document.head.appendChild(css);
      var js = document.createElement('script');
      js.src = videoBox.getAttribute('data-player-js');
      js.onload = resolve;
      js.onerror = function () { playerLoading = null; reject(new Error('player')); };
      document.head.appendChild(js);
    });
    return playerLoading;
  }

  function openVideo(url, poster) {
    videoBox.classList.remove('hidden');
    loadPlayer().then(function () {
      if (videoBox.classList.contains('hidden')) return;
      if (!player) player = TKPlayer.mount(videoBox.querySelector('.tk-player'));
      player.load(url, poster);
    }).catch(function () { videoBox.classList.add('hidden'); toast(t('player.error'), 'error'); });
  }

  $('lightboxClose').addEventListener('click', function () { closeViewers(); });
  $('videoBoxClose').addEventListener('click', function () { closeViewers(); });
  box.addEventListener('click', function (e) { if (e.target === box) closeViewers(); });
  videoBox.addEventListener('click', function (e) { if (e.target === videoBox) closeViewers(); });

  // Клик по вложению: вне режима выбора — открыть или играть. В режиме
  // выбора клик отмечает сообщение (обработчик ниже), ссылка на файл
  // тоже не открывается.
  feed.addEventListener('click', function (e) {
    if (picking || longPressed) return;
    var img = e.target.closest('[data-img]');
    var vid = e.target.closest('[data-video]');
    var aud = e.target.closest('[data-audio]');
    var round = e.target.closest('[data-round]');
    var seal = e.target.closest('[data-open-sealed]');
    var hide = e.target.closest('[data-hide-sealed]');
    if (seal) return openSealed(seal.getAttribute('data-open-sealed'));
    if (hide) return closeSealed(hide.getAttribute('data-hide-sealed'));
    if (round) return playRound(round);
    if (img) {
      $('lightboxImg').src = img.getAttribute('data-img');
      box.classList.remove('hidden');
    } else if (vid) {
      openVideo(vid.getAttribute('data-video'), vid.getAttribute('data-poster'));
    } else if (aud) {
      if (e.target.closest('[data-play]')) playSound(aud);
      else if (e.target.closest('[data-seek]')) seekSound(aud, e);
    }
  });

  // ── Кружки в ленте ────────────────────────────────────────────────────
  // Видео одно на страницу, как звук: вставляется в круг, который играет;
  // после перерисовки ленты переезжает в новый элемент того же кружка.
  var roundPlayer = { video: document.createElement('video'), el: null, url: '' };
  roundPlayer.video.playsInline = true;
  roundPlayer.video.setAttribute('playsinline', '');
  roundPlayer.video.className = 'tk-round__video';

  function roundTick() {
    var el = roundPlayer.el, v = roundPlayer.video;
    if (!el) return;
    var total = v.duration && isFinite(v.duration) ? v.duration : Number(el.getAttribute('data-duration')) || 0;
    el.style.setProperty('--p', total ? Math.min(1, v.currentTime / total) : 0);
    el.querySelector('.tk-att__len').textContent = clock(v.currentTime > 0 ? total - v.currentTime : total);
  }

  function relinkRound() {
    var el = feed.querySelector('[data-round="' + CSS.escape(roundPlayer.url) + '"]');
    roundPlayer.el = el;
    if (!el) { roundPlayer.video.pause(); return; }
    el.appendChild(roundPlayer.video);
    el.classList.add('is-live');
    el.classList.toggle('is-playing', !roundPlayer.video.paused);
    roundTick();
  }

  function stopRound() {
    var v = roundPlayer.video;
    roundPlayer.url = ''; // снятие src ниже само поднимет error — обработчик его пропустит
    v.pause();
    v.removeAttribute('src');
    v.load();
    if (roundPlayer.el) {
      roundPlayer.el.classList.remove('is-live', 'is-playing');
      roundPlayer.el.style.setProperty('--p', 0);
    }
    if (v.parentNode) v.parentNode.removeChild(v);
    roundPlayer.el = null;
  }

  function playRound(el) {
    var url = el.getAttribute('data-round');
    var v = roundPlayer.video;
    if (roundPlayer.url === url) {
      if (v.paused) v.play().catch(function () {}); else v.pause();
      return;
    }
    stopRound();
    if (!sound.audio.paused) sound.audio.pause();
    roundPlayer.url = url;
    roundPlayer.el = el;
    v.src = url;
    el.appendChild(v);
    el.classList.add('is-live');
    v.play().catch(function () {});
    // Открытый кружок вырос — если он при этом ушёл за нижний край ленты,
    // подтягиваем его обратно. nearest: стоящий на виду не дёргаем.
    setTimeout(function () {
      if (roundPlayer.el === el) el.scrollIntoView({ block: 'nearest' });
    }, 280);
  }

  roundPlayer.video.addEventListener('error', function () {
    if (!roundPlayer.url) return; // источник сняли сами (stopRound) — это не отказ
    if (mediaRetry(roundPlayer.video, roundPlayer.url)) return;
    var url = roundPlayer.url;
    mediaFailed('round', url, roundPlayer.video);
    stopRound();
  });

  roundPlayer.video.addEventListener('timeupdate', roundTick);
  roundPlayer.video.addEventListener('play', function () { if (roundPlayer.el) roundPlayer.el.classList.add('is-playing'); });
  roundPlayer.video.addEventListener('pause', function () { if (roundPlayer.el) roundPlayer.el.classList.remove('is-playing'); });
  roundPlayer.video.addEventListener('ended', function () {
    var sealed = sealedOf(roundPlayer.url);
    stopRound();
    if (sealed) closeSealed(sealed);
  });

  // ── Исчезающие: открыть, закрыть, таймер ──────────────────────────────
  var onceTimer = $('onceTimer');

  // Адрес выдачи исчезающего → его id (звук и кружок узнают своё по адресу).
  function sealedOf(url) {
    var m = /^\/messages\/([a-f0-9]{24})\/file/.exec(url || '');
    return m && revealed[m[1]] ? m[1] : null;
  }

  function findMessage(id) { return messages.find(function (m) { return m._id === id; }); }

  function openSealed(id) {
    var m = findMessage(id);
    if (!m || m.sender === ME || m.expired || revealed[id]) return;
    fetch('/messages/' + encodeURIComponent(id) + '/open', { method: 'POST', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (res) {
        if (res.status === 410) { m.expired = true; m.limit = null; render(); return; }
        if (!res.ok) throw new Error(res.d.message || 'HTTP ' + res.status);
        var d = res.d;
        var a = d.attachment;
        var kind = a ? a.kind : 'text';
        m.limit = d.limit;
        var until = d.limit.mode === 'timer' ? d.until : null;
        if (kind === 'file') {
          // Скачивание засчитано сервером; последний раз стирается по концу
          // скачивания или по сроку выдачи.
          var link = document.createElement('a');
          link.href = a.url;
          link.rel = 'noopener';
          document.body.appendChild(link);
          link.click();
          link.remove();
          render();
          return;
        }
        if (kind === 'image' || kind === 'video') {
          viewing = id;
          if (kind === 'image') {
            $('lightboxImg').src = a.url;
            box.classList.remove('hidden');
          } else {
            openVideo(a.url, a.preview);
          }
          showOnceTimer(until);
          render();
          return;
        }
        revealed[id] = { content: d.content, att: a, until: until };
        render();
        var el = feed.querySelector('[data-mid="' + CSS.escape(id) + '"]');
        var play = el && (el.querySelector('[data-round]') || el.querySelector('[data-audio]'));
        if (play && play.hasAttribute('data-round')) playRound(play);
        else if (play) playSound(play);
      })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  // Закрыть раскрытое или окно: сервер стирает, если раз был последним.
  function closeSealed(id) {
    if (revealed[id]) {
      delete revealed[id];
      if (roundPlayer.url.indexOf('/messages/' + id + '/') === 0) stopRound();
      if (sound.url.indexOf('/messages/' + id + '/') === 0) { sound.audio.pause(); sound.url = ''; sound.el = null; }
      var top = feed.scrollTop;
      render();
      feed.scrollTop = top;
    }
    post('/messages/' + encodeURIComponent(id) + '/close', {}).catch(function () {});
  }

  function closeAllSealed() {
    if (viewing) closeViewers();
    Object.keys(revealed).forEach(closeSealed);
  }

  // Ушёл со страницы — закрыть всё открытое: sendBeacon доходит и при
  // закрытии вкладки.
  window.addEventListener('pagehide', function () {
    var ids = Object.keys(revealed);
    if (viewing) ids.push(viewing);
    ids.forEach(function (id) { navigator.sendBeacon('/messages/' + encodeURIComponent(id) + '/close'); });
  });

  function showOnceTimer(until) {
    onceTimer.hidden = !until;
    if (until) onceTimer.setAttribute('data-until', until);
    tickSealed();
  }

  // Раз в секунду: подписи «исчезнет через…» и конец таймера. Сервер сотрёт
  // сам и пришлёт message:expired; здесь — чтобы не ждать его уборки.
  function tickSealed() {
    var now = Date.now();
    var els = Array.prototype.slice.call(document.querySelectorAll('[data-until]'));
    els.forEach(function (el) {
      var left = (new Date(el.getAttribute('data-until')) - now) / 1000;
      if (el === onceTimer) {
        if (onceTimer.hidden) return;
        el.textContent = clock(Math.max(0, Math.ceil(left)));
        if (left <= 0) closeViewers();
        return;
      }
      el.textContent = t('chats.policy.running', { t: span(Math.max(0, left)) });
      var row = el.closest('[data-mid]');
      if (left <= 0 && row) {
        var id = row.getAttribute('data-mid');
        var m = findMessage(id);
        if (m && !m.expired) { delete revealed[id]; m.expired = true; m.limit = null; render(); }
      }
    });
  }
  setInterval(tickSealed, 1000);

  // ── Выбор ограничения ─────────────────────────────────────────────────
  var limitOpt = '';
  var limitBtn = $('limitBtn');
  var limitMenu = $('limitMenu');

  function setLimit(v) {
    limitOpt = v || '';
    var badge = $('limitBadge');
    badge.hidden = !limitOpt;
    badge.textContent = limitOpt ? t('chats.limit.badge.' + limitOpt) : '';
    limitBtn.classList.toggle('is-on', !!limitOpt);
    limitMenu.querySelectorAll('[data-limit]').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-limit') === limitOpt));
    });
  }

  function closeLimitMenu() {
    if (limitMenu.hidden) return;
    limitMenu.hidden = true;
    limitBtn.setAttribute('aria-expanded', 'false');
  }

  limitBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!limitMenu.hidden) return closeLimitMenu();
    limitMenu.hidden = false;
    limitBtn.setAttribute('aria-expanded', 'true');
    var r = limitBtn.getBoundingClientRect();
    limitMenu.style.left = Math.max(8 + safe('l'), Math.min(r.left, innerWidth - safe('r') - limitMenu.offsetWidth - 8)) + 'px';
    limitMenu.style.top = Math.max(8 + safe('t'), Math.min(r.top - limitMenu.offsetHeight - 8, innerHeight - safe('b') - limitMenu.offsetHeight - 8)) + 'px';
    (limitMenu.querySelector('[aria-checked="true"]') || limitMenu.querySelector('[data-limit]')).focus();
  });
  limitMenu.addEventListener('click', function (e) {
    var b = e.target.closest('[data-limit]');
    if (!b) return;
    setLimit(b.getAttribute('data-limit'));
    closeLimitMenu();
    input.focus();
  });
  document.addEventListener('click', function (e) { if (!limitMenu.contains(e.target)) closeLimitMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLimitMenu(); });

  // ── Запись кружка ─────────────────────────────────────────────────────
  // Камера и микрофон, квадрат из середины кадра, до минуты — на минуте
  // отправляется сама. Сервер пережимает в 480×480 со знаком.
  //
  // Три кнопки: отмена, пауза, отправить. С паузой хронометраж считается
  // не «сколько прошло с начала», а суммой записанных отрезков: ms — что
  // записано до нынешнего, at — когда он начался.
  var ROUND_MAX = 60;
  var roundRec = $('roundRec');
  var roundPreview = $('roundPreview');
  var roundPauseBtn = $('roundPause');
  var rrec = null;          // { recorder, stream, chunks, at, ms, timer, send, peerId }

  function roundSec() {
    return (rrec.ms + (rrec.recorder.state === 'paused' ? 0 : Date.now() - rrec.at)) / 1000;
  }

  // Картинку тоже останавливаем: замерший кадр — самый понятный знак, что
  // запись стоит, и его видно раньше, чем подпись кнопки.
  function roundPaused(on) {
    roundRec.classList.toggle('is-paused', on);
    say(roundPauseBtn, on ? 'stream.resume' : 'chats.pause');
    if (on) roundPreview.pause(); else roundPreview.play().catch(function () {});
  }

  function roundType() {
    if (!window.MediaRecorder) return null;
    var types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    for (var i = 0; i < types.length; i++) if (MediaRecorder.isTypeSupported(types[i])) return types[i];
    return '';
  }

  function startRound() {
    var type = roundType();
    if (type === null || !navigator.mediaDevices) return toast(t('chats.recUnsupported'), 'error');
    if (rec) cancelVoice();
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 } },
      audio: true
    }).then(function (stream) {
      if (!peer) { stream.getTracks().forEach(function (tr) { tr.stop(); }); return; }
      var recorder = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 1200000 } : undefined);
      rrec = { recorder: recorder, stream: stream, chunks: [], at: Date.now(), ms: 0, send: false, peerId: peer.id };
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) rrec.chunks.push(e.data); };
      recorder.onstop = finishRound;
      roundPreview.srcObject = stream;
      recorder.start(1000);
      roundRec.classList.remove('hidden');
      roundRec.style.setProperty('--p', 0);
      roundPaused(false);
      $('roundTime').textContent = '0:00';
      rrec.timer = setInterval(function () {
        var sec = roundSec();
        $('roundTime').textContent = clock(Math.floor(sec));
        roundRec.style.setProperty('--p', Math.min(1, sec / ROUND_MAX));
        if (sec >= ROUND_MAX) stopRoundRec(true);
      }, 200);
      $('roundSend').focus();
    }).catch(function () { toast(t('chats.camDenied'), 'error'); });
  }

  function stopRoundRec(send) {
    if (!rrec) return;
    rrec.send = send;
    rrec.sec = roundSec();
    clearInterval(rrec.timer);
    if (rrec.recorder.state !== 'inactive') rrec.recorder.stop();
    else finishRound();
  }

  function finishRound() {
    var r = rrec;
    rrec = null;
    roundRec.classList.add('hidden');
    roundPreview.srcObject = null;
    r.stream.getTracks().forEach(function (tr) { tr.stop(); });
    if (!r.send || !r.chunks.length || r.sec < 1) return;
    if (!peer || peer.id !== r.peerId) return;
    var type = (r.recorder.mimeType || r.chunks[0].type || 'video/webm').split(';')[0];
    var blob = new Blob(r.chunks, { type: type });
    queueFiles([new File([blob], 'round.' + (/mp4/.test(type) ? 'mp4' : 'webm'), { type: type })], 'round');
  }

  $('roundBtn').addEventListener('click', startRound);

  roundPauseBtn.addEventListener('click', function () {
    if (!rrec) return;
    var pause = rrec.recorder.state === 'recording';
    if (pause) { rrec.ms += Date.now() - rrec.at; rrec.recorder.pause(); }
    else { rrec.at = Date.now(); rrec.recorder.resume(); }
    roundPaused(pause);
  });

  $('roundSend').addEventListener('click', function () { stopRoundRec(true); });
  $('roundCancel').addEventListener('click', function () { stopRoundRec(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && rrec) stopRoundRec(false); });

  // ── События сокета ────────────────────────────────────────────────────
  document.addEventListener('tk:message:new', function (e) {
    var m = e.detail.message;
    var p = e.detail.peer;
    var el = dialogEl(p.id) || addDialog(p);
    setLast(el, m);
    bumpRecent(p);
    // Готово вложение, которое отправляла эта вкладка: заглушку — прочь.
    if (e.detail.ref) dropUpload(e.detail.ref);

    if (peer && peer.id === p.id) {
      var stick = atBottom() || m.sender === ME;
      merge([m]);
      render();
      if (stick) scrollToBottom();
      markRead();
    } else if (m.sender !== ME) {
      var badge = el.querySelector('.tk-dialog__unread');
      badge.textContent = String((parseInt(badge.textContent, 10) || 0) + 1);
      badge.classList.remove('hidden');
    }
  });

  // Исчезающее истекло — у обоих на его месте заглушка.
  document.addEventListener('tk:message:expired', function (e) {
    var fresh = e.detail.message;
    var i = messages.findIndex(function (m) { return m._id === fresh._id; });
    delete revealed[fresh._id];
    if (viewing === fresh._id) closeViewers(true);
    if (roundPlayer.url && roundPlayer.url.indexOf('/messages/' + fresh._id + '/') === 0) stopRound();
    if (sound.url && sound.url.indexOf('/messages/' + fresh._id + '/') === 0) { sound.audio.pause(); sound.url = ''; sound.el = null; }
    if (i === -1) return;
    messages[i] = fresh;
    var top = feed.scrollTop;
    render();
    feed.scrollTop = top;
    var last = messages[messages.length - 1];
    var el = dialogEl(peer.id);
    if (el && last && last._id === fresh._id) el.querySelector('.tk-dialog__last').innerHTML = summaryHtml(fresh);
  });

  // Собеседник открыл моё исчезающее — «Открыто» и сколько осталось.
  document.addEventListener('tk:message:limit', function (e) {
    var m = messages.find(function (x) { return x._id === e.detail.id; });
    if (!m) return;
    m.limit = e.detail.limit;
    var top = feed.scrollTop;
    render();
    feed.scrollTop = top;
  });

  // Видео не пережалось — заглушка этой вкладки показывает почему.
  document.addEventListener('tk:message:failed', function (e) {
    var u = uploads.find(function (x) { return x.ref === e.detail.ref; });
    if (u) failUpload(u, e.detail.message);
  });

  document.addEventListener('tk:message:delivered', function (e) {
    var ids = e.detail.ids || [];
    var changed = false;
    messages.forEach(function (m) {
      if (ids.indexOf(m._id) !== -1 && !m.deliveredAt) { m.deliveredAt = e.detail.at; changed = true; }
    });
    if (changed) render();
  });

  document.addEventListener('tk:message:read', function (e) {
    if (!peer || peer.id !== e.detail.readerId) return;
    var changed = false;
    messages.forEach(function (m) {
      if (m.sender === ME && !m.readAt && new Date(m.sentAt) <= new Date(e.detail.at)) {
        m.readAt = e.detail.at;
        m.deliveredAt = m.deliveredAt || e.detail.at;
        changed = true;
      }
    });
    if (changed) render();
  });

  document.addEventListener('tk:message:deleted', function (e) {
    dropMessages(e.detail.ids || []);
    // Непрочитанные в диалогах — точным числом с сервера.
    var dialogs = e.detail.dialogs || {};
    Object.keys(dialogs).forEach(function (id) {
      var badge = dialogEl(id) && dialogEl(id).querySelector('.tk-dialog__unread');
      if (!badge) return;
      badge.textContent = String(dialogs[id]);
      badge.classList.toggle('hidden', !dialogs[id]);
    });
    if (picking) updatePickBar();
  });

  // Звонки, убранные в другой вкладке этого же человека.
  document.addEventListener('tk:call:deleted', function (e) {
    dropCalls(e.detail.ids || []);
    if (picking) updatePickBar();
  });

  document.addEventListener('tk:conversation:deleted', function (e) {
    var el = dialogEl(e.detail.peerId);
    if (el) el.remove();
    if (peer && peer.id === e.detail.peerId) closeDialog();
    if (!list.querySelector('.tk-dialog')) $('conversationsEmpty').classList.remove('hidden');
  });

  // Звонок кончился: строка в ленте открытого диалога с этим человеком
  // и свежий журнал на вкладке «Звонки».
  document.addEventListener('tk:call:logged', function (e) {
    var c = e.detail.call;
    // Звонок — тоже общение: собеседник уезжает в начало ленты недавних.
    // Карточку берём из списка диалогов: в записи звонка её нет, а ставить
    // в ленту человека, которого ещё нет на экране, незачем — он появится
    // там при следующем открытии страницы.
    var other = c.caller === ME ? c.callee : c.caller;
    var row = dialogEl(other);
    if (row) {
      var a = peerOf(row);
      bumpRecent({ id: a.id, displayName: a.name, avatarStyle: { url: a.url, gradient: a.bg, initial: a.initial } });
    }
    if (peer && (c.caller === peer.id || c.callee === peer.id)) {
      var stick = atBottom();
      merge([], [c]);
      render();
      if (stick) scrollToBottom();
    }
    journalStale = true;
    if (!callsList.hidden) loadJournal();
  });

  // Пока сокета не было, что-то могло прийти или прочитаться — перечитываем
  // открытый диалог целиком.
  document.addEventListener('tk:reconnect', function () {
    if (peer) openHistory();
    journalStale = true;
    if (!callsList.hidden) loadJournal();
  });

  // ── Вкладки ───────────────────────────────────────────────────────────
  var callsList = $('callsList');
  var journal = null;       // звонки вкладки, пока не загружены — null
  var journalStale = true;

  function setTab(name) {
    var onCalls = name === 'calls';
    $('tabMessages').setAttribute('aria-selected', String(!onCalls));
    $('tabCalls').setAttribute('aria-selected', String(onCalls));
    list.hidden = onCalls;
    callsList.hidden = !onCalls;
    // Лента недавних — часть списка диалогов: на журнале звонков ей не место.
    recentBox.hidden = onCalls || !recentRow.children.length;
    var q = new URLSearchParams(location.search);
    if (onCalls) q.set('tab', 'calls'); else q.delete('tab');
    var qs = q.toString();
    history.replaceState(null, '', '/chatsPage' + (qs ? '?' + qs : ''));
    if (onCalls && journalStale) loadJournal();
  }

  document.querySelector('.tk-chat__tabs').addEventListener('click', function (e) {
    var tab = e.target.closest('[data-tab]');
    if (!tab) return;
    e.preventDefault();
    setTab(tab.getAttribute('data-tab'));
  });

  // ── Журнал звонков ────────────────────────────────────────────────────
  // Открыли — пропущенные увидены: сервер гасит их у себя, здесь гаснут
  // счётчики и, если больше нечего читать, колокольчик.
  function loadJournal() {
    journalStale = false;
    fetch('/api/calls')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        journal = data.calls;
        renderJournal();
        document.querySelectorAll('[data-missed-calls]').forEach(function (b) {
          b.textContent = '0';
          b.classList.add('hidden');
        });
        if (window.tkChatBadge) window.tkChatBadge({ calls: 0 });
        if (window.setNotificationDot) window.setNotificationDot(data.unread > 0);
      })
      .catch(function (e) { journalStale = true; console.error('calls:', e); });
  }

  function journalPeer(c) {
    var a = c.peer.avatarStyle || {};
    return { id: c.peer.id, name: c.peer.displayName, url: a.url, bg: a.gradient, initial: a.initial };
  }

  function renderJournal() {
    if (!journal) return;
    if (!journal.length) {
      callsList.innerHTML = '<p class="tk-note tk-chat__empty-list">' + escapeHtml(t('calls.empty')) + '</p>';
      return;
    }
    callsList.innerHTML = journal.map(function (c, i) {
      var info = callInfo(c);
      var p = journalPeer(c);
      var arrow = info.out ? '<path d="M7 17L17 7M9 7h8v8"></path>' : '<path d="M17 7L7 17M15 17H7V9"></path>';
      var button = function (type, icon, key) {
        return '<button type="button" class="tk-callrow__btn" data-call="' + type + '" data-row="' + i + '" aria-label="' + escapeHtml(t(key)) + '" title="' + escapeHtml(t(key)) + '">' +
          '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true">' + icon + '</svg></button>';
      };
      return '<div class="tk-callrow' + (info.missed ? ' is-missed' : '') + '">' +
        '<button type="button" class="tk-callrow__main" data-open="' + i + '">' +
          avatar('tk-callrow__ava', p) +
          '<span class="tk-callrow__body">' +
            '<span class="tk-callrow__name">' + escapeHtml(p.name) + '</span>' +
            '<span class="tk-callrow__meta"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true">' + arrow + '</svg>' + escapeHtml(info.text) + '</span>' +
            '<time class="tk-callrow__when">' + escapeHtml(tkDate(c.startedAt, CALL_TIME)) + '</time>' +
          '</span>' +
        '</button>' +
        button('audio', PHONE, 'calls.audio') + button('video', CAMERA, 'calls.video') +
        '<button type="button" class="tk-callrow__btn tk-callrow__del" data-del="' + i + '" aria-label="' + escapeHtml(t('calls.delete')) + '" title="' + escapeHtml(t('calls.delete')) + '">' +
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button>' +
      '</div>';
    }).join('');
  }

  callsList.addEventListener('click', function (e) {
    var call = e.target.closest('[data-call]');
    var open = e.target.closest('[data-open]');
    var del = e.target.closest('[data-del]');
    if (del) {
      var gone = journal[Number(del.getAttribute('data-del'))];
      confirmDialog(t('calls.deleteQ'), { okText: t('chats.delete') }).then(function (yes) {
        if (!yes) return;
        return post('/api/calls/delete', { ids: [gone.id] }).then(afterCallsDeleted.bind(null, [gone.id]));
      }).catch(function (err) { toast(t('calls.deleteFailed') + ': ' + err.message, 'error'); });
    } else if (call && window.showOutgoingCall) {
      var c = journal[Number(call.getAttribute('data-row'))];
      var type = call.getAttribute('data-call');
      window.showOutgoingCall({
        userId: c.peer.id,
        displayName: c.peer.displayName,
        avatarUrl: (c.peer.avatarStyle || {}).url || '',
        callType: type
      });
      if (type === 'audio') window.startAudioCall(c.peer.id);
      else window.startVideoCall(c.peer.id);
    } else if (open) {
      openPeer(journal[Number(open.getAttribute('data-open'))].peer);
    }
  });

  // Строка звонка открывает переписку с этим человеком. Её ещё нет —
  // заводим, как кнопка «Сообщение» на его странице; не вышло (например,
  // аккаунт ограничен) — ведём на страницу человека.
  function openPeer(p) {
    var el = dialogEl(p.id);
    if (el) return select(el);
    post('/start-conversation', { recipientId: p.id })
      .then(function () { select(dialogEl(p.id) || addDialog(p)); })
      .catch(function () { location.href = '/userPage/' + encodeURIComponent(p.id); });
  }

  // ── Действия с сообщением и звонком ───────────────────────────────────
  // Меню — правым кликом, на телефоне — удержанием, с клавиатуры — Enter.
  // Обычный клик по сообщению меню не открывает: им выделяют текст мышью.
  // Раньше меню было на левом клике, а удержание на телефоне не ловилось
  // вовсе — удалить сообщение с телефона было нельзя.
  //
  // «Выделить» в меню включает режим выбора: клик отмечает или снимает
  // отметку, Shift+клик — всё подряд от предыдущей отметки. Вместо шапки
  // диалога — полоса «Выбрано: N» с теми же действиями на всю пачку.
  var menu = $('msgMenu');
  var menuKey = null;       // над чем открыто меню
  var picked = {};          // 'm:<id>' — сообщение, 'c:<id>' — звонок
  var picking = false;
  var anchor = null;        // от какой отметки считать Shift+клик
  var pressTimer = null;
  // Сработало удержание: клик и contextmenu, которыми кончается этот же жест,
  // не должны ничего делать. Сбрасывается следующим касанием — не по времени:
  // иначе быстрое касание сразу после удержания терялось бы.
  var longPressed = false;

  function isPicked(key) { return !!picked[key]; }
  function pickedKeys() { return Object.keys(picked); }

  function itemEl(key) { return feed.querySelector('[data-key="' + CSS.escape(key) + '"]'); }
  function itemOf(el) { return el && el.closest('[data-key]'); }

  // Что стоит за ключом — сообщение или звонок из загруженной ленты.
  function resolve(key) {
    var id = key.slice(2);
    return key[0] === 'm'
      ? { kind: 'message', m: messages.find(function (x) { return x._id === id; }) }
      : { kind: 'call', c: calls.find(function (x) { return x.id === id; }) };
  }

  function mark(key, on) {
    if (on) picked[key] = true; else delete picked[key];
    var el = itemEl(key);
    if (el) el.classList.toggle('is-picked', !!on);
  }

  function openMenu(el) {
    var key = el.getAttribute('data-key');
    var what = resolve(key);
    if (!what.m && !what.c) return;
    closeMenu();
    menuKey = key;
    el.classList.add('is-picked');   // правый клик выделяет то, над чем меню
    // Исчезающее не копируется и не пересылается.
    menu.querySelectorAll('[data-for="message"]').forEach(function (b) { b.hidden = what.kind !== 'message' || !plain(what.m); });
    menu.hidden = false;
    var target = el.querySelector('.tk-msg__bubble') || el;
    var r = target.getBoundingClientRect();
    var w = menu.offsetWidth;
    var h = menu.offsetHeight;
    var left = el.classList.contains('tk-msg--out') ? r.right - w : el.classList.contains('tk-callnote') ? r.left + (r.width - w) / 2 : r.left;
    var top = r.bottom + 6 + h > innerHeight - safe('b') ? r.top - h - 6 : r.bottom + 6;
    menu.style.left = Math.max(8 + safe('l'), Math.min(left, innerWidth - safe('r') - w - 8)) + 'px';
    menu.style.top = Math.max(8 + safe('t'), Math.min(top, innerHeight - safe('b') - h - 8)) + 'px';
    menu.querySelector('button:not([hidden])').focus();
  }

  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    // Подсветка, поставленная меню, уходит вместе с ним — если это не отметка.
    if (menuKey && !picked[menuKey]) { var el = itemEl(menuKey); if (el) el.classList.remove('is-picked'); }
    menuKey = null;
  }

  // ── Режим выбора ──
  function startPicking(key) {
    picking = true;
    // В режиме выбора клик — это отметка, не выделение текста: старое
    // выделение снимаем, чтобы оно не путалось с отметками.
    window.getSelection().removeAllRanges();
    $('chat').classList.add('is-picking');
    $('pickBar').hidden = false;
    document.querySelector('.tk-chat__head').hidden = true;
    mark(key, true);
    anchor = key;
    updatePickBar();
  }

  function stopPicking() {
    if (!picking) return;
    picking = false;
    pickedKeys().forEach(function (k) { mark(k, false); });
    anchor = null;
    $('chat').classList.remove('is-picking');
    $('pickBar').hidden = true;
    document.querySelector('.tk-chat__head').hidden = false;
  }

  // Копировать и переслать можно только сообщения: у звонка нет текста.
  function updatePickBar() {
    var keys = pickedKeys();
    if (!keys.length) return stopPicking();
    $('pickCount').textContent = t('chats.picked', { n: keys.length });
    var hasText = keys.some(function (k) { var x = k[0] === 'm' && resolve(k).m; return x && plain(x); });
    document.querySelectorAll('#pickBar [data-pick="forward"], #pickBar [data-pick="copy"]').forEach(function (b) { b.disabled = !hasText; });
  }

  function toggle(key, range) {
    if (range && anchor && itemEl(anchor)) {
      // Всё между предыдущей отметкой и этой — в порядке ленты.
      var all = Array.prototype.map.call(feed.querySelectorAll('[data-key]'), function (el) { return el.getAttribute('data-key'); });
      var a = all.indexOf(anchor), b = all.indexOf(key);
      all.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(function (k) { mark(k, true); });
    } else {
      mark(key, !picked[key]);
    }
    anchor = key;
    updatePickBar();
  }

  $('pickCancel').addEventListener('click', stopPicking);
  $('pickBar').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-pick]');
    if (!btn || btn.disabled) return;
    var keys = pickedKeys();
    var act = btn.getAttribute('data-pick');
    if (act === 'copy') copy(keys);
    else if (act === 'forward') openForward(keys);
    else if (act === 'delete') removeItems(keys);
  });

  // ── Мышь, палец, клавиатура ──
  feed.addEventListener('contextmenu', function (e) {
    var el = itemOf(e.target);
    if (!el) return;
    e.preventDefault();
    // Android после удержания шлёт ещё и contextmenu — меню уже открыто им.
    if (longPressed) return;
    if (picking) toggle(el.getAttribute('data-key'), e.shiftKey);
    else openMenu(el);
  });

  feed.addEventListener('click', function (e) {
    if (e.target.closest('[data-peer]') && !picking) return goToPeer();
    var el = itemOf(e.target);
    if (!el || !picking) return;
    if (longPressed) return;   // клик, которым кончилось удержание
    e.preventDefault();
    toggle(el.getAttribute('data-key'), e.shiftKey);
  });

  // Shift+клик браузер понимает ещё и как «растянуть выделение текста».
  // В режиме выбора текст не выделяем вовсе: иначе следующий клик попадал
  // внутрь выделенного, браузер его не сбрасывал, и отметка не снималась.
  feed.addEventListener('mousedown', function (e) {
    if (picking && itemOf(e.target)) e.preventDefault();
  });

  // Новое касание где угодно — новый жест: флаг удержания снимаем. Не только
  // в ленте — иначе касание шапки, чтобы закрыть меню, его бы не закрыло.
  document.addEventListener('touchstart', function () { longPressed = false; }, { capture: true, passive: true });

  // Удержание пальцем: iOS не шлёт contextmenu, поэтому считаем время сами.
  // Сдвинул палец — это прокрутка, не удержание.
  var pressFrom = null;
  feed.addEventListener('touchstart', function (e) {
    var el = itemOf(e.target);
    if (!el || e.touches.length > 1) return;
    pressFrom = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(function () {
      longPressed = true;
      if (navigator.vibrate) navigator.vibrate(12);
      if (picking) toggle(el.getAttribute('data-key'), false);
      else openMenu(el);
    }, 450);
  }, { passive: true });
  feed.addEventListener('touchmove', function (e) {
    if (!pressFrom) return;
    var dx = e.touches[0].clientX - pressFrom.x, dy = e.touches[0].clientY - pressFrom.y;
    if (dx * dx + dy * dy > 100) { clearTimeout(pressTimer); pressFrom = null; }
  }, { passive: true });
  ['touchend', 'touchcancel'].forEach(function (name) {
    feed.addEventListener(name, function () { clearTimeout(pressTimer); pressFrom = null; });
  });

  feed.addEventListener('keydown', function (e) {
    var el = itemOf(e.target);
    if (!el || e.target !== (el.querySelector('.tk-msg__bubble') || el)) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (picking) toggle(el.getAttribute('data-key'), e.shiftKey);
      else openMenu(el);
    }
  });

  document.addEventListener('click', function (e) {
    // Клик, которым кончилось удержание (так делают некоторые Android),
    // не «мимо меню»: оно только что открылось этим же жестом.
    if (longPressed) return;
    if (!menu.hidden && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (closeViewers()) return;
    if (!menu.hidden) closeMenu();
    else if (picking && fwd.classList.contains('hidden')) stopPicking();
  });
  feed.addEventListener('scroll', closeMenu);

  menu.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn || !menuKey) return;
    var key = menuKey;
    var act = btn.getAttribute('data-act');
    closeMenu();
    if (act === 'select') startPicking(key);
    else if (act === 'copy') copy([key]);
    else if (act === 'forward') openForward([key]);
    else if (act === 'delete') removeItems([key]);
  });

  function plain(m) { return !m.limit && !m.expired; }

  // Сообщения выбранного — в порядке ленты, без звонков.
  function pickedMessages(keys) {
    return keys.filter(function (k) { return k[0] === 'm'; })
      .map(function (k) { return resolve(k).m; })
      .filter(Boolean)
      .sort(function (a, b) { return new Date(a.sentAt) - new Date(b.sentAt); });
  }

  function copy(keys) {
    var text = pickedMessages(keys).filter(plain).map(function (m) { return m.content; }).filter(Boolean).join('\n\n');
    if (!text) return;
    navigator.clipboard.writeText(text)
      .then(function () { toast(t('chats.copied'), 'ok'); stopPicking(); })
      .catch(function () {});
  }

  // Удаление выбранного одним окном. Своё сообщение можно убрать у всех,
  // чужое и звонок — только у себя (сервер следит за этим сам). Если в
  // выбранном есть и то и другое, в вопросе сказано, что уйдёт только у вас.
  function removeItems(keys) {
    var msgs = pickedMessages(keys);
    var callIds = keys.filter(function (k) { return k[0] === 'c'; }).map(function (k) { return k.slice(2); });
    var mine = msgs.filter(function (m) { return m.sender === ME; }).length;
    var n = msgs.length + callIds.length;
    if (!n) return;

    var q = n > 1 ? t('chats.deleteManyQ', { n: n }) : msgs.length ? t('chats.deleteMsgQ') : t('chats.deleteCallQ');
    if (mine && mine < n) q += ' ' + t('chats.deleteMixedNote');
    var choices = mine
      ? [{ value: 'me', text: t('chats.deleteForMe'), danger: false }, { value: 'all', text: t('chats.deleteForAll') }]
      : [{ value: 'me', text: t('chats.delete') }];

    chooseDialog(q, choices).then(function (v) {
      if (!v) return;
      var jobs = [];
      if (msgs.length) jobs.push(post('/messages/delete', { ids: msgs.map(function (m) { return m._id; }), forAll: v === 'all' }));
      if (callIds.length) jobs.push(post('/api/calls/delete', { ids: callIds }).then(afterCallsDeleted.bind(null, callIds)));
      return Promise.all(jobs).then(function () {
        // Сокет пришлёт то же самое, но лента не должна ждать его.
        dropMessages(msgs.map(function (m) { return m._id; }));
        stopPicking();
      });
    }).catch(function (e) { toast(t('chats.deleteFailed') + ': ' + e.message, 'error'); });
  }

  function dropMessages(ids) {
    if (!ids.length) return;
    var before = messages.length;
    messages = messages.filter(function (m) { return ids.indexOf(m._id) === -1; });
    ids.forEach(function (id) { delete picked['m:' + id]; });
    if (messages.length === before) return;
    var top = feed.scrollTop;
    render();
    feed.scrollTop = top;
    var last = messages[messages.length - 1];
    var el = peer && dialogEl(peer.id);
    if (el && last) el.querySelector('.tk-dialog__last').innerHTML =
      (last.sender === ME ? '<span data-i18n="chats.you">' + escapeHtml(t('chats.you')) + '</span> ' : '') + summaryHtml(last);
  }

  // Звонки ушли — из ленты открытого диалога и из вкладки «Звонки».
  // Ответ сервера несёт, сколько пропущенных осталось, — это счётчик у иконки.
  function dropCalls(ids) {
    var feedBefore = calls.length;
    calls = calls.filter(function (c) { return ids.indexOf(c.id) === -1; });
    ids.forEach(function (id) { delete picked['c:' + id]; });
    if (calls.length !== feedBefore) { var top = feed.scrollTop; render(); feed.scrollTop = top; }
    if (journal) {
      var jBefore = journal.length;
      journal = journal.filter(function (c) { return ids.indexOf(c.id) === -1; });
      if (journal.length !== jBefore) renderJournal();
    }
  }

  function afterCallsDeleted(ids, r) {
    dropCalls(ids);
    document.querySelectorAll('[data-missed-calls]').forEach(function (b) {
      b.textContent = String(r.missed || 0);
      b.classList.toggle('hidden', !r.missed);
    });
    if (window.tkChatBadge) window.tkChatBadge({ calls: r.missed || 0 });
  }

  $('deleteChat').addEventListener('click', function () {
    if (!peer) return;
    var p = peer;
    chooseDialog(t('chats.deleteChatQ', { name: p.name }), [
      { value: 'me', text: t('chats.deleteForMe'), danger: false },
      { value: 'all', text: t('chats.deleteChatForAll') }
    ]).then(function (v) {
      if (!v) return;
      return post('/conversations/delete', { peerId: p.id, forAll: v === 'all' });
    }).catch(function (e) { toast(t('chats.deleteFailed') + ': ' + e.message, 'error'); });
  });

  // ── Пересылка ─────────────────────────────────────────────────────────
  var fwd = $('forwardModal');
  var fwdList = $('forwardList');
  var fwdSearch = $('forwardSearch');
  var fwdSend = $('forwardSend');
  var fwdMessages = [];     // что пересылаем, в порядке ленты
  var fwdComment = $('forwardComment');
  var fwdPicked = {};      // id → true
  var fwdTimer = null;

  // Кандидаты — собеседники из списка слева; поиск добавляет остальных.
  function known() {
    return Array.prototype.map.call(list.querySelectorAll('.tk-dialog'), peerOf);
  }

  function fwdRender(people) {
    if (!people.length) {
      fwdList.innerHTML = '<p class="tk-note tk-note--center">' + escapeHtml(t('chats.forwardEmpty')) + '</p>';
      return;
    }
    fwdList.innerHTML = people.map(function (p) {
      return '<label class="tk-fwd__row">' +
        '<input type="checkbox" value="' + escapeHtml(p.id) + '"' + (fwdPicked[p.id] ? ' checked' : '') + '>' +
        avatar('tk-fwd__ava', p) +
        '<span class="tk-fwd__name">' + escapeHtml(p.name) + '</span></label>';
    }).join('');
  }

  function fwdCount() {
    var n = Object.keys(fwdPicked).length;
    fwdSend.disabled = !n;
    $('forwardCount').textContent = n ? '\u00a0(' + n + ')' : '';
  }

  function openForward(keys) {
    fwdMessages = pickedMessages(keys).filter(plain);
    if (!fwdMessages.length) return;
    fwdPicked = {};
    fwdSearch.value = '';
    fwdComment.value = '';
    // Одно — его текст; несколько — сколько и начало первого.
    $('forwardQuote').textContent = fwdMessages.length === 1
      ? summaryText(fwdMessages[0])
      : t('chats.forwardMany', { n: fwdMessages.length }) + ' · ' + summaryText(fwdMessages[0]);
    fwdRender(known());
    fwdCount();
    fwd.classList.remove('hidden');
    fwdSearch.focus();
  }

  function closeForward() {
    fwd.classList.add('hidden');
    fwdMessages = [];
  }

  $('forwardClose').addEventListener('click', closeForward);
  fwd.addEventListener('click', function (e) { if (e.target === fwd) closeForward(); });

  fwdList.addEventListener('change', function (e) {
    var box = e.target;
    if (box.checked) fwdPicked[box.value] = true;
    else delete fwdPicked[box.value];
    fwdCount();
  });

  fwdSearch.addEventListener('input', function () {
    clearTimeout(fwdTimer);
    var q = fwdSearch.value.trim();
    var mine = known().filter(function (p) { return p.name.toLowerCase().indexOf(q.toLowerCase()) !== -1; });
    fwdRender(mine);
    if (q.length < 2) return;
    fwdTimer = setTimeout(function () {
      // Тот же поиск, что в шапке (utils/search.js); пересылке нужны только люди.
      fetch('/api/search?type=people&limit=7&q=' + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (found) {
          var users = found.people || [];
          if (fwdSearch.value.trim() !== q) return;
          var seen = {};
          mine.forEach(function (p) { seen[p.id] = true; });
          var more = users.filter(function (u) { return String(u._id) !== ME && !seen[u._id]; }).map(function (u) {
            var a = u.avatarStyle || {};
            return { id: String(u._id), name: u.displayName, url: a.url, bg: a.gradient, initial: a.initial };
          });
          fwdRender(mine.concat(more));
        })
        .catch(function () {});
    }, 300);
  });

  fwdSend.addEventListener('click', function () {
    if (!fwdMessages.length) return;
    fwdSend.disabled = true;
    post('/messages/forward', {
      messageIds: fwdMessages.map(function (m) { return m._id; }),
      recipientIds: Object.keys(fwdPicked),
      comment: fwdComment.value.trim()
    })
      .then(function () {
        toast(t('chats.forwardDone'), 'ok');
        closeForward();
        stopPicking();
      })
      .catch(function (e) {
        toast(t('chats.forwardFailed') + ': ' + e.message, 'error');
        fwdCount();
      });
  });

  // ── Язык и время ──────────────────────────────────────────────────────
  // Лента, даты и подсказка поля собираются скриптом, а переключатель языка
  // переводит только разметку с ключами — поэтому пересобираем сами.
  document.addEventListener('tk:lang', function () {
    refreshTimes();
    renderJournal();
    if (!peer) return;
    var fromBottom = feed.scrollHeight - feed.scrollTop;
    render();
    feed.scrollTop = feed.scrollHeight - fromBottom;
    input.placeholder = t('chats.messageTo') + ' ' + peer.name + '…';
  });

  refreshTimes();
  // Подписи «N минут назад» стареют, пока страница открыта.
  setInterval(refreshTimes, 60000);

  // Переход с профиля («Сообщение») или из уведомления: открыть нужный диалог
  // или вкладку звонков.
  var params = new URLSearchParams(location.search);
  var target = params.get('peer') && dialogEl(params.get('peer'));
  if (target) select(target);
  else if (params.get('tab') === 'calls') loadJournal();
})();
