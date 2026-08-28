import { createServer } from 'node:http';
import { verifySignature } from './line.mjs';
import { safeError, ServiceError } from './errors.mjs';

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > maxBytes) {
      req.resume();
      throw new ServiceError('BODY_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createApp({ secret, bot, clock = () => new Date(), logger = console, maxBytes = 256 * 1024 }) {
  const server = createServer(async (req, res) => {
    // 以 Bot 收到 webhook 的時間查詢，不用重送事件的舊 timestamp。
    const receivedAt = clock();
    const path = req.url?.split('?')[0];
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, service: 'line-tra-bot' });
    if (path !== '/webhook') return json(res, 404, { error: 'NOT_FOUND' });
    if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'JSON_REQUIRED' });
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return json(res, 415, { error: 'ENCODING_NOT_SUPPORTED' });
    if (Number(req.headers['content-length']) > maxBytes) return json(res, 413, { error: 'BODY_TOO_LARGE' });
    try {
      const raw = await readBody(req, maxBytes);
      // 必須先對原始 bytes 驗章，再 parse JSON；不可 stringify 後驗章。
      if (!verifySignature(raw, req.headers['x-line-signature'], secret)) return json(res, 401, { error: 'INVALID_SIGNATURE' });
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: 'INVALID_JSON' }); }
      if (!body || !Array.isArray(body.events) || body.events.length > 100 || body.events.some(e => !e || typeof e !== 'object' || Array.isArray(e))) {
        return json(res, 400, { error: 'INVALID_EVENTS' });
      }
      // Verify 按鈕送 events: []，不呼叫 TDX 或 LINE，直接成功。
      await bot.handleEvents(body.events, receivedAt);
      json(res, 200, { ok: true });
    } catch (error) {
      logger.error('webhook_failed', safeError(error));
      const status = error.code === 'BODY_TOO_LARGE' ? 413 : error.code === 'BOT_BUSY' ? 503 : 502;
      if (!res.headersSent && !res.destroyed) json(res, status, { error: 'WEBHOOK_FAILED' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}
