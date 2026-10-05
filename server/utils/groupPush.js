// Пуш о сообщении группы — тем участникам, кто его ещё не прочитал и не
// выключил звук. Правило ожидания — как у личной переписки
// (routes/streaming/messages.js, PUSH_WAIT_MS): у кого вкладка на экране,
// тому — через полминуты и только если так и не прочитал; остальным — сразу.
// Служебные строки («Анна добавила Бориса») не будят никого.

const Group = require('../models/Group');
const Notification = require('../models/Notification');
const User = require('../models/User');
const push = require('./push');
const errorLog = require('./errorLog');
const userView = require('./userView');

const PUSH_WAIT_MS = 30000;

function send(group, message, sender) {
  if (message.system && message.system.kind) return;
  const now = new Date();
  const targets = group.members
    .filter((m) => String(m.user) !== String(sender._id) && !(m.mutedUntil && m.mutedUntil > now))
    .map((m) => String(m.user));
  if (!targets.length) return;

  const name = userView.displayName(sender);
  const content = String(message.content || '').trim();
  const kind = (message.attachments && message.attachments[0] && message.attachments[0].kind) || (message.share && message.share.kind ? 'share' : '');
  const note = {
    topic: 'message',
    title: group.title,
    bodyKey: 'push.groupMessage',
    bodyVars: { name },
    // Текст с автором; без текста — вид вложения словарём, автор — в bodyKey
    // для тех, кто текст на заблокированном экране скрыл.
    ...(content ? { preview: name + ': ' + content } : kind ? { previewKey: 'chats.att.' + kind } : {}),
    // Одна метка на группу: пять сообщений подряд — одно уведомление.
    tag: 'group-' + String(group._id),
    url: '/chatsPage?group=' + String(group._id),
  };

  const fire = (ids) => Group.findById(group._id).select('members.user members.readAt').lean()
    .then((fresh) => {
      const still = fresh ? fresh.members.filter((m) => ids.includes(String(m.user)) && m.readAt < message.sentAt).map((m) => m.user) : [];
      return push.sendMany(still, note);
    })
    .catch((e) => errorLog.server(e, 'push.group'));

  const online = targets.filter((id) => push.onScreen(id));
  const offline = targets.filter((id) => !online.includes(id));
  if (offline.length) fire(offline);
  // unref: недоотправленный пуш не повод держать процесс живым при остановке.
  if (online.length) setTimeout(() => fire(online), PUSH_WAIT_MS).unref();
}

// Звонок группе, до которого человек так и не дошёл (правки 29.09): звонило
// и не взял, или был не в сети. Как пропущенный один на один
// (utils/callLog.js): строка в колокольчике всем, пуш «вам звонили» — у кого
// вкладки на экране нет (свёрнутый айфон звонка не слышал) и у кого звук
// группы не выключен. Ждать, как с сообщением, нечего — звонок уже кончился.
// call — звонок из sockets/index.js или routes/groups.js; missed он отдаёт
// один раз: второй конец того же звонка ничего не повторит.
function missedCall(io, call) {
  if (!call.missed) return;
  const ids = [...call.missed];
  call.missed = null;
  if (ids.length) sendMissed(io, call, ids).catch((e) => errorLog.server(e, 'push.groupCall'));
}

async function sendMissed(io, call, ids) {
  const [group, caller] = await Promise.all([
    Group.findById(call.groupId).select('title members.user members.mutedUntil').lean(),
    User.findById(call.callerId).select('nickname login email').lean(),
  ]);
  if (!group || !caller) return;
  const now = new Date();
  // Вышел из группы, пока звонило, — ему уже ничего.
  const members = new Map(group.members.map((m) => [String(m.user), m]));
  const to = ids.filter((id) => members.has(id));
  if (!to.length) return;
  const url = '/chatsPage?group=' + String(group._id);
  await Notification.insertMany(to.map((id) => ({ recipient: id, sender: call.callerId, type: 'call', content: group.title, link: url })));
  if (io) io.to(to.map((id) => 'user:' + id)).emit('notification:new');
  const loud = to.filter((id) => !push.onScreen(id) && !(members.get(id).mutedUntil > now));
  if (!loud.length) return;
  return push.sendMany(loud, {
    topic: 'call',
    title: group.title,
    bodyKey: 'push.missedGroupCall',
    bodyVars: { name: userView.displayName(caller) },
    tag: 'group-call-' + String(group._id),
    url,
  });
}

module.exports = { send, missedCall };
