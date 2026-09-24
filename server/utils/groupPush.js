// Пуш о сообщении группы — тем участникам, кто его ещё не прочитал и не
// выключил звук. Правило ожидания — как у личной переписки
// (routes/streaming/messages.js, PUSH_WAIT_MS): кто на связи, тому — через
// полминуты и только если так и не прочитал; кто не на связи — сразу.
// Служебные строки («Анна добавила Бориса») не будят никого.

const Group = require('../models/Group');
const push = require('./push');
const errorLog = require('./errorLog');
const userView = require('./userView');

const PUSH_WAIT_MS = 30000;

function send(req, group, message, sender) {
  if (message.system && message.system.kind) return;
  const now = new Date();
  const targets = group.members
    .filter((m) => String(m.user) !== String(sender._id) && !(m.mutedUntil && m.mutedUntil > now))
    .map((m) => String(m.user));
  if (!targets.length) return;

  const name = userView.displayName(sender);
  const content = String(message.content || '').trim();
  const kind = message.attachments && message.attachments[0] && message.attachments[0].kind;
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

  const rooms = req.app.get('userRooms');
  const online = targets.filter((id) => rooms && rooms.has(id));
  const offline = targets.filter((id) => !online.includes(id));
  if (offline.length) fire(offline);
  // unref: недоотправленный пуш не повод держать процесс живым при остановке.
  if (online.length) setTimeout(() => fire(online), PUSH_WAIT_MS).unref();
}

module.exports = { send };
