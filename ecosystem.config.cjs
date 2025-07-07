module.exports = {
  apps: [
    {
      name: 'tribalwars-bot',
      script: 'index.js',
      // Do not restart automatically if the bot exits (e.g., on captcha)
      autorestart: false,
      watch: false,
      max_memory_restart: '300M', // Optional: restart if memory usage is too high
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
}; 