import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJson } from '../src/http-client.mjs';
import { LineClient, verifySignature } from '../src/line.mjs';
import { createHmac } from 'node:crypto';
import { reply } from '../fixtures/sample.mjs';

test('HMAC 使用原始 bytes，防止竄改與錯誤 secret', () => {
  const raw = Buffer.from('{"events":[],"text":"中文🚆\\n"}');
  const secret = 'test-secret';
  const signature = createHmac('sha256', secret).update(raw).digest('base64');
  assert.equal(verifySignature(raw, signature, secret), true);
  assert.equal(verifySignature(Buffer.concat([raw, Buffer.from(' ')]), signature, secret), false);
  assert.equal(verifySignature(raw, signature, 'wrong'), false);
  for (const s of [null, '', 'bad', signature + ' ', [signature]]) assert.equal(verifySignature(raw, s, secret), false);
});

test('JSON 格式錯誤與網路錯誤都不包含敏感回傳內容', async () => {
  await assert.rejects(requestJson('https://example.invalid', {}, { fetchImpl: async () => new Response('PRIVATE KEY') }), /UPSTREAM_INVALID_JSON/);
  await assert.rejects(requestJson('https://example.invalid', {}, { fetchImpl: async () => { throw new Error('secret'); } }), /UPSTREAM_NETWORK_ERROR/);
});

test('上游連線與回應 body 都有 timeout', async () => {
  // 維持 event loop 存活，AbortSignal.timeout 本身使用 unref timer。
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const waitForAbort = signal => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    await assert.rejects(requestJson('https://example.invalid', {}, {
      timeoutMs: 20, fetchImpl: async (_, init) => waitForAbort(init.signal),
    }), /UPSTREAM_TIMEOUT/);
    await assert.rejects(requestJson('https://example.invalid', {}, {
      timeoutMs: 20, fetchImpl: async (_, init) => ({ ok: true, json: () => waitForAbort(init.signal) }),
    }), /UPSTREAM_TIMEOUT/);
  } finally { clearTimeout(keepAlive); }
});

test('LINE replyToken 與單筆 text message 結構正確，拒絕 redirect', async () => {
  const message = { type: 'text', text: '測試' };
  const line = new LineClient({ accessToken: 'mock-access-token', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.line.me/v2/bot/message/reply');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer mock-access-token');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(init.body), { replyToken: 'mock-reply-token', messages: [message] });
    return reply({ sentMessages: [] });
  } });
  await line.reply('mock-reply-token', message);
});
