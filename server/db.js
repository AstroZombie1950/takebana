// db.js
const mongoose = require('mongoose');

// Получаем настройки из переменных окружения
const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/webcabar';

mongoose.connect(uri, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
})
.then(() => console.log('MongoDB connected...'))
.catch(err => {
  console.log('MongoDB connection error:', err.message);
  console.log('Connection string:', uri.replace(/\/\/.*@/, '//***:***@')); // Скрываем пароль в логах
  // Первое подключение mongoose не повторяет: если при перезагрузке сервера
  // Mongo не поднялась за 10 с, процесс жил без базы, а pm2 его не трогал —
  // он же не упал. Выходим: pm2 перезапустит, и подключение будет новое.
  // Обрывы после подключения mongoose переживает сам.
  process.exit(1);
});
