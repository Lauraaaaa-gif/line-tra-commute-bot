import { createHmac, timingSafeEqual } from 'node:crypto';
import { requestJson, runtimeFetch } from './http-client.mjs';

export function verifySignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !secret) return false;
  // SHA-256 簽章是 32 bytes 的標準 base64；拒絕缺漏、非標準或多重 header。
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(signature, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class LineClient {
  constructor({ accessToken, fetchImpl = runtimeFetch, timeoutMs = 4000 }) {
    this.accessToken = accessToken;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async reply(replyToken, message) {
    return requestJson('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyToken, messages: [message] }),
    }, { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, service: 'LINE' });
  }

  async push(to, message, retryKey) {
    return requestJson('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json', 'X-Line-Retry-Key': retryKey },
      body: JSON.stringify({ to, messages: [message] }),
    }, { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, service: 'LINE', acceptRetryConflict: true });
  }

}
