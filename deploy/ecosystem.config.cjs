// PM2 keeps SmartQ running on the VPS and restarts it if it stops or the
// server reboots. Started by setup.sh and reloaded by update.sh.
module.exports = {
  apps: [{
    name: 'smartq',
    script: 'app.js',
    cwd: '/var/www/smartq',
    instances: 1,                 // one process: the live updates and caches live in memory
    autorestart: true,
    max_memory_restart: '400M',
    env: { NODE_ENV: 'production', PORT: 3000, TZ: 'Asia/Manila' },
    out_file: '/home/smartq/smartq-out.log',
    error_file: '/home/smartq/smartq-error.log',
    time: true,
  }],
};
