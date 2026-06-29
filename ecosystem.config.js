"use strict";

module.exports = {
  apps: [
    {
      name: "playwright-shopee-api",
      script: "api-stack.js",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
