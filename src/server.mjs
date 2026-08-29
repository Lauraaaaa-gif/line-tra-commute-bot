import { loadLocalEnv, readConfig } from './config.mjs';
import { TdxClient } from './tdx.mjs';
import { TrainService } from './trains.mjs';
import { LineClient } from './line.mjs';
import { createBot } from './bot.mjs';
import { createApp } from './app.mjs';
import { RealtimeService } from './realtime.mjs';
import { copyBook } from './copy.mjs';

try {
  loadLocalEnv();
  const config = readConfig();
  const tdx = new TdxClient({ clientId: config.tdxClientId, clientSecret: config.tdxClientSecret, cacheMs: config.timetableCacheMs });
  const trainService = new TrainService(tdx, config);
  const lineClient = new LineClient({ accessToken: config.lineAccessToken, timeoutMs: config.lineTimeoutMs });
  const bot = createBot({ config, trainService, lineClient, realtime: new RealtimeService(tdx), copy: copyBook });
  const server = createApp({ secret: config.lineSecret, bot });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? '啟動失敗：PORT 已被其他程式使用。' : `啟動失敗：${error.code || 'SERVER_ERROR'}`);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`LINE 台鐵 Bot 已啟動：http://${config.host}:${config.port}`);
    console.log('Webhook：POST /webhook　健康檢查：GET /health');
    console.log(`去程：${config.routes.去程.from} → ${config.routes.去程.to}`);
    console.log(`回程：${config.routes.回程.from} → ${config.routes.回程.to}`);
    console.log('請把公開 HTTPS 網址加上 /webhook，填入 LINE Developers。');
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    bot.close();
    server.close(() => { process.exitCode = 0; });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 15000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  // 此處只涵蓋本機設定與啟動；絕不輸出 env 值。
  console.error(`啟動失敗：${error.message}`);
  process.exitCode = 1;
}
