// pm2. Применяется в день переезда:
//   pm2 start ops/ecosystem.config.js --env production
//   pm2 save && pm2 startup     ← без этого не поднимется после перезагрузки сервера
// Путь считается от самого файла, а не зашит строкой: ops/provision.sh умеет
// ставить приложение в любой каталог через APP_DIR, и зашитый /srv/takebana
// разошёлся бы с ним молча — pm2 просто не нашёл бы app.js.
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'takebana',
      script: 'app.js',
      cwd: path.join(__dirname, '..', 'server'),
      instances: 1,            // > 1 только после Redis-адаптера: состояние пока в памяти
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      min_uptime: '30s',
      max_restarts: 10,
      time: true,              // таймстемпы в логах
      error_file: '/var/log/takebana/error.log',
      out_file: '/var/log/takebana/out.log',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
