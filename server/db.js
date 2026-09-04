// db.js
const mongoose = require('mongoose');

// Получаем настройки из переменных окружения
const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/webcabar';

mongoose.connect(uri, { 
  useNewUrlParser: true, 
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
})
.then(() => console.log('MongoDB connected...'))
.catch(err => {
  console.log('MongoDB connection error:', err.message);
  console.log('Connection string:', uri.replace(/\/\/.*@/, '//***:***@')); // Скрываем пароль в логах
});