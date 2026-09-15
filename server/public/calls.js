/* Журнал звонков: перезвонить из строки. Окно звонка и сам звонок —
 * tk-app.js, так же, как кнопки на странице человека (profile.js). */
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-call]');
  if (!btn || !window.showOutgoingCall) return;
  var type = btn.getAttribute('data-call');
  var userId = btn.getAttribute('data-user');
  window.showOutgoingCall({
    userId: userId,
    displayName: btn.getAttribute('data-name'),
    avatarUrl: btn.getAttribute('data-ava'),
    callType: type
  });
  if (type === 'audio') window.startAudioCall(userId);
  else window.startVideoCall(userId);
});
