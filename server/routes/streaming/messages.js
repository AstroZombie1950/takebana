// Личная переписка: список диалогов, история, отправка, дозагрузка новых.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const mongoose = require('mongoose');
const User = require('../../models/User');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Notification = require('../../models/Notification');
const { validate } = require('../../middleware/validate');
const { commonDataMiddleware, getRandomGradient } = require('./shared');

function timeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  let interval = seconds / 31536000;

  if (interval > 1) {
    return Math.floor(interval) + ' years ago';
  }
  interval = seconds / 2592000;
  if (interval > 1) {
    return Math.floor(interval) + ' months ago';
  }
  interval = seconds / 86400;
  if (interval > 1) {
    return Math.floor(interval) + ' days ago';
  }
  interval = seconds / 3600;
  if (interval > 1) {
    return Math.floor(interval) + ' hours ago';
  }
  interval = seconds / 60;
  if (interval > 1) {
    return Math.floor(interval) + ' minutes ago';
  }
  return Math.floor(seconds) + ' seconds ago';
}

router.get('/chatsPage', commonDataMiddleware, async (req, res) => {
  if (!req.session.userId) { // Проверка авторизации
    return res.redirect('/');
  }

  try {
    // Проверяем, авторизован ли пользователь
    const currentUserId = res.locals.currentUser ? res.locals.currentUser._id : null;

    if (!currentUserId) {
      return res.status(401).send('Необходима авторизация');
    }

    // Получение всех диалогов текущего пользователя
    const conversations = await Conversation.find({
      $or: [{ userOne: currentUserId }, { userTwo: currentUserId }]
    })
      .populate('userOne userTwo lastMessage') // Подгружаем участников и последнее сообщение
      .lean(); // Используем lean() для облегчения работы с объектами

    // Получаем все непрочитанные уведомления для текущего пользователя
    const unreadNotifications = await Notification.find({
      recipient: currentUserId, // Уведомления для текущего пользователя
      isRead: false, // Только непрочитанные
      type: 'message' // Только уведомления о сообщениях
    }).lean();

    // Добавляем свойство `hasUnreadMessages` в диалоги на основе уведомлений
    conversations.forEach(conversation => {
      const interlocutor = conversation.userOne._id.toString() === currentUserId.toString() 
        ? conversation.userTwo 
        : conversation.userOne;

      const displayName = interlocutor.login || 
        (interlocutor.email ? interlocutor.email.split('@')[0] : 'Неизвестный пользователь');
      const avatarStyle = interlocutor.avatar
        ? { url: interlocutor.avatar }
        : { gradient: getRandomGradient(), initial: displayName.charAt(0).toUpperCase() };

      // Добавляем интерлокутора и последнюю активность
      conversation.interlocutor = {
        _id: interlocutor._id,
        displayName,
        avatarStyle,
        isOnline: !!interlocutor.isOnline,
        lastSeen: interlocutor.lastSeen || null
      };

      // Проверяем, есть ли непрочитанные уведомления от собеседника
      conversation.hasUnreadMessages = unreadNotifications.some(
        (notification) => notification.sender.toString() === interlocutor._id.toString()
      );

      // Определяем последнюю активность для сортировки
      conversation.lastActivity = conversation.lastMessage 
        ? new Date(conversation.lastMessage.sentAt) 
        : new Date(conversation.createdAt);
    });

    // Сортируем диалоги по времени последней активности (от свежих к старым)
    conversations.sort((a, b) => b.lastActivity - a.lastActivity);

    // Передача данных в шаблон
    res.render('chatsPage', {
      title: 'Личные сообщения',
      conversations, // Передаём отсортированный список диалогов
      timeAgo // Передаем функцию в шаблон
    });
  } catch (error) {
    console.error('Ошибка получения данных для страницы чатов:', error);
    res.status(500).send('Ошибка сервера');
  }
});


router.post('/start-conversation', validate({
  recipientId: { type: 'objectId', required: true, label: 'Собеседник' },
}), async (req, res) => {
  const currentUserId = req.session.userId; // Получаем ID текущего пользователя из сессии
  const { recipientId } = req.body; // ID получателя передается в теле запроса

  if (!currentUserId) {
    return res.status(401).json({ success: false, message: 'Пользователь не аутентифицирован' });
  }

  try {
    // Проверка существования конверсации
    let conversation = await Conversation.findOne({
      $or: [
        { userOne: currentUserId, userTwo: recipientId },
        { userOne: recipientId, userTwo: currentUserId }
      ]
    });

    if (!conversation) {
      // Если конверсации нет, создаем новую
      conversation = new Conversation({
        userOne: currentUserId,
        userTwo: recipientId
      });
      await conversation.save();
    }

    // Возвращаем JSON с успехом
    res.json({ success: true, conversationId: conversation._id });
  } catch (error) {
    console.error('Ошибка при создании или получении конверсации:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});


router.get('/getMessages', async (req, res) => {
  const { recipientId, offset = 0 } = req.query; // Смещение для пагинации
  const currentUserId = req.session.userId;

  if (!recipientId) {
    return res.status(400).send('Не указан ID получателя.');
  }

  try {
    const conversation = await Conversation.findOne({
      $or: [
        { userOne: currentUserId, userTwo: recipientId },
        { userOne: recipientId, userTwo: currentUserId }
      ]
    });

    if (!conversation) {
      return res.status(404).send('Диалог не найден.');
    }

    // Получение сообщений с учетом смещения и лимита
    const messages = await Message.find({ conversationId: conversation._id })
      .sort({ sentAt: -1 }) // Сортируем по времени отправки в обратном порядке
      .skip(parseInt(offset)) // Пропустить сообщения согласно смещению
      .limit(15); // Ограничиваем количество сообщений

    res.json(messages.reverse()); // Отправляем сообщения клиенту в формате JSON, меняем порядок на прямой
  } catch (error) {
    console.error('Ошибка при получении сообщений:', error);
    res.status(500).send('Ошибка сервера.');
  }
});

router.get('/getNewMessages', async (req, res) => {
  const { recipientId, after } = req.query;
  const currentUserId = req.session.userId;

  if (!recipientId) {
    return res.status(400).send('Не указан ID получателя.');
  }

  try {
    const conversation = await Conversation.findOne({
      $or: [
        { userOne: currentUserId, userTwo: recipientId },
        { userOne: recipientId, userTwo: currentUserId }
      ]
    });

    if (!conversation) {
      return res.status(404).send('Диалог не найден.');
    }

    let query = { conversationId: conversation._id };

    if (after) {
      query.sentAt = { $gt: new Date(after) };
    }

    const newMessages = await Message.find(query)
      .sort({ sentAt: 1 }); // Сортируем по времени отправки

    res.json(newMessages);
  } catch (error) {
    console.error('Ошибка при получении новых сообщений:', error);
    res.status(500).send('Ошибка сервера.');
  }
});


// Единственный маршрут, где не было ни одной проверки: recipientId уходил прямо
// в условие $or поиска диалога, а длина сообщения ничем не ограничивалась.
router.post('/sendMessage', validate({
  recipientId: { type: 'objectId', required: true, label: 'Собеседник' },
  content: { type: 'string', required: true, min: 1, max: 5000, label: 'Сообщение' },
}), async (req, res) => {
  const { recipientId, content } = req.body;
  const senderId = req.session.userId;


  try {
    // Найдем соответствующую конверсацию
    const conversation = await Conversation.findOne({
      $or: [
        { userOne: senderId, userTwo: recipientId },
        { userOne: recipientId, userTwo: senderId }
      ]
    });

    if (!conversation) {
      return res.status(404).send('Диалог не найден.');
    }

    // Создание нового сообщения
    const newMessage = await Message.create({
      conversationId: conversation._id,
      sender: senderId,
      recipient: recipientId,
      content: content,
      sentAt: new Date()
    });

    // Обновляем поле последнего сообщения в разговоре
    conversation.lastMessage = newMessage._id;
    await conversation.save();

    
    // Проверяем наличие существующего непрочитанного уведомления
    const existingNotification = await Notification.findOne({
      recipient: recipientId,
      sender: senderId,
      type: 'message',
      isRead: false
    });

    if (existingNotification) {
      // Обновляем уведомление, если оно уже существует
      await Notification.findByIdAndUpdate(existingNotification._id, {
        $set: {
          content: content, // Обновляем текст сообщения
          createdAt: new Date() // Обновляем время
        }
      });
    } else {
      // Создаём новое уведомление
      await Notification.create({
        recipient: recipientId,
        sender: senderId,
        type: 'message',
        content: content
      });
    }

    // Отправляем только что созданное сообщение клиенту
    res.json(newMessage);
  } catch (error) {
    console.error('Ошибка при отправке сообщения:', error);
    res.status(500).send('Ошибка сервера.');
  }
});


// Маршрут для проверки статуса стрима

module.exports = router;
