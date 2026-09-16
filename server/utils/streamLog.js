// Журнал эфиров (models/StreamSession.js): открыть отрезок, закрыть, копить
// зрителей.
//
// Нужен потому, что сам эфир следа не оставляет — документ Stream удаляется
// при завершении и уборке. Отрезок открывается на выходе в эфир и закрывается
// в любом из четырёх выходов: ведущий завершил, поставил паузу, модерация
// погасила, уборщик убрал брошенный.
//
// Ни одна функция здесь не имеет права уронить эфир: всё, что может не выйти,
// гасится и пишется в лог. Журнал — это наблюдение, а не часть вещания.

const StreamSession = require('../models/StreamSession');
const ChatMessage = require('../models/ChatMessage');
const errorLog = require('./errorLog');

const quiet = (p, what) => p.catch((e) => errorLog.server(e, 'streamLog.' + what));

// Веб или OBS. В Stream это два поля с историческими значениями, а в журнале
// нужен один понятный столбец.
const sourceOf = (stream) => (stream.streamProvider === 'obs' || stream.streamType === 'obs-stream' ? 'obs' : 'web');

// Выход в эфир. Повторный вызов на том же ключе новой сессии не заводит:
// /set-active зовут и при переподключении, и двумя вкладками сразу.
async function open(stream) {
  try {
    const exists = await StreamSession.exists({ streamKey: stream.streamKey, endedAt: null });
    if (exists) return null;

    return await StreamSession.create({
      stream: stream._id,
      user: stream.userId,
      streamKey: stream.streamKey,
      title: stream.title || '',
      category: stream.category || '',
      subcategory: stream.subcategory || '',
      city: stream.city || '',
      isAdult: !!stream.isAdult,
      source: sourceOf(stream),
      startedAt: stream.startedAt || new Date(),
      heartbeatAt: new Date(),
    });
  } catch (e) {
    errorLog.server(e, 'streamLog.open');
    return null;
  }
}

// Уход из эфира. duration считается на стороне базы одной операцией: иначе
// между чтением и записью успевает пройти время, и отрезки расходятся.
async function close(streamKey, { endedBy = 'owner', reason = '', by = null, streamId = null } = {}) {
  if (!streamKey) return null;

  try {
    const now = new Date();
    const session = await StreamSession.findOneAndUpdate(
      { streamKey, endedAt: null },
      [{
        $set: {
          endedAt: now,
          heartbeatAt: now,
          endedBy,
          stopReason: reason || '',
          stoppedBy: by || null,
          duration: { $max: [0, { $round: [{ $divide: [{ $subtract: [now, '$startedAt'] }, 1000] }, 0] }] },
        },
      }],
      { new: true, sort: { startedAt: -1 } }
    );

    if (!session) return null;

    // Сообщения чата считаем один раз, при закрытии: живой счётчик стоил бы
    // записи в базу на каждое сообщение эфира.
    const id = session.stream || streamId;
    if (id) {
      const chatMessages = await ChatMessage.countDocuments({ streamId: id });
      if (chatMessages) {
        await StreamSession.updateOne({ _id: session._id }, { $set: { chatMessages } });
        session.chatMessages = chatMessages;
      }
    }

    return session;
  } catch (e) {
    errorLog.server(e, 'streamLog.close');
    return null;
  }
}

// Запись прикрепляется к последнему отрезку эфира: размер файла — это деньги
// за хранение, и в панели они должны сходиться с эфиром, который их породил.
function attachRecording(streamKey, recording) {
  // findOneAndUpdate, а не updateOne: сортировка нужна, чтобы попасть
  // в последний отрезок, а updateOne её не принимает — молча взял бы первый
  // попавшийся отрезок этого ключа, то есть эфир недельной давности.
  return quiet(
    StreamSession.findOneAndUpdate(
      { streamKey },
      { $set: { recording: recording._id, recordingSize: recording.size || 0 } },
      { sort: { startedAt: -1 } }
    ),
    'привязка записи'
  );
}

// Размер известен только после склейки и выгрузки (utils/recording.js).
function recordingSize(recordingId, size) {
  return quiet(StreamSession.updateOne({ recording: recordingId }, { $set: { recordingSize: size || 0 } }), 'размер записи');
}

// Удар сэмплера: пики и зрителе-секунды по всем идущим эфирам разом.
// samples — массив { streamKey, viewers }, seconds — шаг сэмплера.
function sample(samples, seconds) {
  if (!samples.length) return Promise.resolve();

  const now = new Date();
  const ops = samples.map(({ streamKey, viewers }) => ({
    updateOne: {
      filter: { streamKey, endedAt: null },
      update: [{
        $set: {
          peakViewers: { $max: ['$peakViewers', viewers] },
          viewerSeconds: { $add: ['$viewerSeconds', viewers * seconds] },
          heartbeatAt: now,
        },
      }],
    },
  }));

  return quiet(StreamSession.bulkWrite(ops, { ordered: false }), 'сэмплер');
}

// Процесс перезапустили с открытыми отрезками. Закрываем их последним ударом
// сэмплера: он — последний миг, когда эфир заведомо шёл. Без этого такие
// отрезки остались бы открытыми навсегда и портили бы сумму часов.
async function sweep() {
  try {
    const open = await StreamSession.find({ endedAt: null }).select('_id startedAt heartbeatAt').lean();
    if (!open.length) return;

    const ops = open.map((s) => {
      const endedAt = s.heartbeatAt || s.startedAt;
      return {
        updateOne: {
          filter: { _id: s._id },
          update: { $set: { endedAt, endedBy: 'restart', duration: Math.max(0, Math.round((endedAt - s.startedAt) / 1000)) } },
        },
      };
    });

    await StreamSession.bulkWrite(ops, { ordered: false });
    console.log(`[streamlog] закрыто отрезков после перезапуска: ${open.length}`);
  } catch (e) {
    errorLog.server(e, 'streamLog.sweep');
  }
}

module.exports = { open, close, attachRecording, recordingSize, sample, sweep };
