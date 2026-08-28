import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedNgrokToken, ngrokEnvironment, safeNgrokEvent } from '../src/ngrok.mjs';

test('ngrok token validates without including its content in errors', () => {
  const token = 'local_test_token_1234567890';
  assert.equal(checkedNgrokToken(` ${token} `), token);
  for (const value of ['', 'ngrok config add-authtoken ' + token, 'YOUR_AUTHTOKEN_123456789', 'secret with spaces']) {
    assert.throws(() => checkedNgrokToken(value), { message: 'NGROK_AUTHTOKEN_INVALID' });
  }
});
test('ngrok receives no LINE, TDX, or other application secrets', () => {
  const env = ngrokEnvironment({ Path: 'tools', SystemRoot: 'windows', LINE_CHANNEL_SECRET: 'private', TDX_CLIENT_SECRET: 'private', OTHER_SECRET: 'private' }, 'local_test_token_1234567890');
  assert.deepEqual(Object.keys(env).sort(), ['NGROK_AUTHTOKEN', 'Path', 'SystemRoot']);
});
test('ngrok startup URL is selected from a structured tunnel event', () => {
  assert.deepEqual(safeNgrokEvent(JSON.stringify({ msg: 'started tunnel', url: 'https://test.ngrok-free.dev', private: 'hidden' })), { type: 'url', url: 'https://test.ngrok-free.dev' });
});
test('ngrok rejects unrelated URLs, credentials, paths, and plaintext logs', () => {
  for (const url of ['http://test.ngrok-free.dev', 'https://evil.example', 'https://test.ngrok-free.dev.evil.example', 'https://user:secret@test.ngrok-free.dev', 'https://test.ngrok-free.dev/secret', 'https://test.ngrok-free.dev/?token=secret']) {
    assert.equal(safeNgrokEvent(JSON.stringify({ msg: 'started tunnel', url })), null);
  }
  assert.equal(safeNgrokEvent('a private token'), null);
  assert.equal(safeNgrokEvent(JSON.stringify({ msg: 'other', url: 'https://test.ngrok-free.dev' })), null);
});
test('ngrok errors expose only the official code', () => {
  assert.deepEqual(safeNgrokEvent('invalid token PRIVATE_VALUE ERR_NGROK_105'), { type: 'error', code: 'ERR_NGROK_105' });
  assert.equal(safeNgrokEvent('x'.repeat(65537)), null);
});
