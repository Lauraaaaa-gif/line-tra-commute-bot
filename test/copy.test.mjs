import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CopyBook, validateCopy } from '../src/copy.mjs';
import { LineClient } from '../src/line.mjs';
import { silentLogger } from '../fixtures/sample.mjs';

test('文案儲存即生效，JSON 錯誤保留上一版；修正後恢復更新', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tra-copy-'));
  const file = path.join(dir, 'copy.json');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });
  fs.writeFileSync(file, JSON.stringify({ header: '搭車：{from} → {to}' }));
  const copy = new CopyBook({ file, logger: silentLogger });
  assert.equal(copy.text('header', { from: '大湖', to: '新左營' }), '搭車：大湖 → 新左營');
  fs.writeFileSync(file, '{broken');
  assert.equal(copy.text('header', { from: '大湖', to: '新左營' }), '搭車：大湖 → 新左營');
  fs.writeFileSync(file, JSON.stringify({ header: '下一站 {to}' }));
  assert.equal(copy.text('header', { to: '大湖' }), '下一站 大湖');
});

test('文案檢查拒絕未知鍵、變數、超長按鈕及錯誤型態', () => {
  for (const value of [{ secret: 'x' }, { header: '{secret}' }, { header: 123 }, { header: ['x', 1] }, { buttonMissed: '長'.repeat(21) }]) {
    assert.throws(() => validateCopy(value));
  }
});

test('LINE 僅提供 reply；沒有 Push 介面', async () => {
  const calls = [];
  const line = new LineClient({ accessToken: 'test-token', fetchImpl: async (url, init) => {
    calls.push({ url, init }); return new Response('{}');
  } });
  const message = { type: 'text', text: 'test' };
  await line.reply('mock-reply', message);
  assert.equal(line.push, undefined);
  assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/reply');
  assert.deepEqual(JSON.parse(calls[0].init.body), { replyToken: 'mock-reply', messages: [message] });
});
