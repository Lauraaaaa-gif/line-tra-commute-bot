import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadLocalEnv() {
  // 固定從專案根目錄讀取；執行時不必正好位於此資料夾。
  const file = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(file)) process.loadEnvFile(file);
}

function integer(env, key, fallback, min, max) {
  const raw = env[key]?.trim() || String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} 必須是 ${min}～${max} 的整數。`);
  }
  return value;
}

function station(env, key, fallback) {
  const value = env[key]?.trim() || fallback;
  if (value.length > 30 || /[\r\n\x00-\x1f]/.test(value)) {
    throw new Error(`${key} 的車站名稱格式不正確。`);
  }
  return value;
}

function optionalUserId(env, key) {
  const value = env[key]?.trim() || '';
  if (value && !/^U[0-9a-f]{32}$/.test(value)) throw new Error(`${key} 必須是 LINE User ID（U 加 32 位小寫十六進位字元）。`);
  return value;
}

export function readConfig(env = process.env, { requireLine = true, requireTdx = true } = {}) {
  const required = [
    ...(requireLine ? ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN'] : []),
    ...(requireTdx ? ['TDX_CLIENT_ID', 'TDX_CLIENT_SECRET'] : []),
  ];
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`請先在 .env 設定：${missing.join('、')}。`);

  const routes = {
    去程: { from: station(env, 'OUTBOUND_FROM', '大湖'), to: station(env, 'OUTBOUND_TO', '新左營') },
    回程: { from: station(env, 'RETURN_FROM', '新左營'), to: station(env, 'RETURN_TO', '大湖') },
  };
  for (const route of Object.values(routes)) {
    if (route.from === route.to) throw new Error('起站與迄站不能相同。');
  }
  const trainTypeCodes = (env.TRAIN_TYPE_CODES || '').split(',').map(x => x.trim()).filter(Boolean);
  if (trainTypeCodes.some(x => !/^\d{1,3}$/.test(x))) {
    throw new Error('TRAIN_TYPE_CODES 請使用以逗號分隔的車種簡碼，例如 6,10。');
  }
  return {
    lineSecret: env.LINE_CHANNEL_SECRET?.trim() || '',
    lineAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN?.trim() || '',
    tdxClientId: env.TDX_CLIENT_ID?.trim() || '',
    tdxClientSecret: env.TDX_CLIENT_SECRET?.trim() || '',
    host: env.HOST?.trim() || '127.0.0.1',
    port: integer(env, 'PORT', 3000, 1, 65535),
    routes,
    groupControllerUserId: optionalUserId(env, 'GROUP_CONTROLLER_USER_ID'),
    resultLimit: integer(env, 'RESULT_LIMIT', 3, 1, 10),
    minLeadMinutes: integer(env, 'MIN_LEAD_MINUTES', 0, 0, 120),
    trainTypeCodes,
    timetableCacheMs: integer(env, 'TIMETABLE_CACHE_SECONDS', 60, 0, 300) * 1000,
    tdxTimeoutMs: integer(env, 'TDX_QUERY_TIMEOUT_MS', 8000, 100, 10000),
    lineTimeoutMs: integer(env, 'LINE_REPLY_TIMEOUT_MS', 4000, 100, 5000),
  };
}
