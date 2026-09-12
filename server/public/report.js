/* Жалоба на эфир, пользователя или сообщение.
 *
 * Окно лежит в общем партиале шапки, поэтому кнопку можно поставить на любой
 * странице кабинета: достаточно атрибутов data-report и data-report-id.
 *
 *   <button data-report="user" data-report-id="..." data-report-name="anna">
 *
 * Отдельный файл, а не часть tk-app.js: тот отвечает за каркас приложения,
 * и функции здесь в общую область не выносятся — обёртка не даёт им
 * столкнуться с чужими.
 */
(function () {
'use strict';

  // Подписи — из общего словаря (public/tk-i18n.js).
  var t = function (key, arg) { return window.t ? window.t(key, arg) : ''; };

var modal = document.getElementById('reportModal');
if (!modal) return;

var targetLine = document.getElementById('reportTarget');
var reasonInput = document.getElementById('reportReason');
var commentInput = document.getElementById('reportComment');
var sendButton = document.getElementById('sendReport');

var KINDS = { stream: 'report.onStream', user: 'report.onUser', message: 'report.onMessage' };

var current = null;

function open(type, id, name) {
  current = { type: type, id: id };

  var what = KINDS[type] ? t(KINDS[type]) : type;
  targetLine.textContent = name
    ? t('report.targetNamed', { what: what, name: name })
    : t('report.target', { what: what });

  reasonInput.value = 'abuse';
  commentInput.value = '';
  modal.classList.remove('hidden');
  reasonInput.focus();
}

function close() {
  modal.classList.add('hidden');
  current = null;
}

document.addEventListener('click', function (e) {
  var trigger = e.target.closest('[data-report]');
  if (!trigger) return;

  e.preventDefault();
  open(trigger.dataset.report, trigger.dataset.reportId, trigger.dataset.reportName || '');
});

document.getElementById('closeReportModal').addEventListener('click', close);
modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
});

sendButton.addEventListener('click', async function () {
  if (!current) return;

  sendButton.disabled = true;
  try {
    var res = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetType: current.type,
        targetId: current.id,
        reason: reasonInput.value,
        comment: commentInput.value.trim()
      })
    });

    var data = await res.json().catch(function () { return {}; });

    if (res.ok) {
      close();
      toast(t('report.sent'), 'ok');
      return;
    }

    // 401 — гость: жаловаться может только вошедший, и об этом надо сказать
    // прямо, а не общим «не получилось».
    if (res.status === 401) {
      toast(t('report.needLogin'), 'error');
      return;
    }
    toast(data.message || t('report.failed'), 'error');
  } catch (err) {
    toast(t('report.failed'), 'error');
  } finally {
    sendButton.disabled = false;
  }
});
})();
