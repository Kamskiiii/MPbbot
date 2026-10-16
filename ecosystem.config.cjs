/**
 * PM2: агент ВП. Рабочий каталог на сервере — /root/vdv/vp-bot
 * (или путь к клону репозитория + /vp-bot).
 *
 *   cd /root/vdv/vp-bot && npm install && npm run build
 *   pm2 start /root/vdv/vp-bot/ecosystem.config.cjs
 *   pm2 save
 *   pm2 logs vdv-vp-bot
 */
module.exports = {
  apps: [
    {
      name: 'vdv-vp-bot',
      cwd: '/root/vdv/vp-bot',
      script: 'dist/index.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      time: true,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '200M',
      max_restarts: 20,
      min_uptime: 5000,
      exp_backoff_restart_delay: 500,
    },
  ],
};
