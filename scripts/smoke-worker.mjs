// Run after: wrangler deploy --dry-run --outdir .wrangler/tracking-check
// Real workerd/SQLite/alarm runtime, with EVERY outgoing request intercepted.
// No local .env, Cloudflare Secrets, production traffic or real LINE messages.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { train, stations } from '../fixtures/sample.mjs';
import { taipeiTime } from '../src/trains.mjs';

const now = new Date();
const current = taipeiTime(now);
const departure = taipeiTime(new Date(now.getTime() + 2 * 60000));
const arrival = taipeiTime(new Date(now.getTime() + 26 * 60000));
assert.equal(departure.date, current.date, 'Run this smoke check more than two minutes before midnight.');
const replies = [], pushes = [];
let onPush;
const pushed = new Promise(resolve => { onPush = resolve; });
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  scriptPath: fileURLToPath(new URL('../.wrangler/tracking-check/worker.js', import.meta.url)),
  compatibilityDate: '2026-08-29', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { BOT_STATE: { className: 'BotState', useSQLite: true } },
  bindings: { LINE_CHANNEL_SECRET: 'smoke-only', LINE_CHANNEL_ACCESS_TOKEN: 'smoke-only',
    TDX_CLIENT_ID: 'smoke-only', TDX_CLIENT_SECRET: 'smoke-only' },
  async outboundService(request) {
    const url = new URL(request.url);
    if (url.hostname === 'api.line.me') {
      const body = await request.json();
      if (url.pathname.endsWith('/push')) {
        assert.ok(request.headers.get('x-line-retry-key'));
        pushes.push(body);
        if (pushes.length === 2) onPush();
      } else replies.push(body.messages[0]);
      return Response.json({});
    }
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'smoke-only', expires_in: 3600 });
    if (url.pathname.endsWith('/Station')) return Response.json({ Stations: stations, Count: stations.length });
    if (url.pathname.includes('/TrainLiveBoard/')) return Response.json({ TrainLiveBoards: [{
      TrainNo: '3238', DelayTime: 10, StationID: '4340', TrainStationStatus: 0, UpdateTime: new Date().toISOString(),
    }] });
    if (url.pathname.includes('/OD/')) return Response.json({ TrainDate: current.date, Count: 1,
      TrainTimetables: [train('3238', departure.time, { arrival: arrival.time })] });
    throw new Error('Unexpected outbound service in smoke test');
  },
}));
let timer;
try {
  await mf.ready;
  const ns = await mf.getDurableObjectNamespace('BOT_STATE');
  const stub = ns.get(ns.idFromName('local-smoke-only'));
  let sequence = 0;
  const send = async text => {
    const id = String(++sequence);
    const response = await stub.fetch('https://bot-state.internal/event', { method: 'POST',
      body: JSON.stringify({ receivedAt: new Date().toISOString(), event: {
        type: 'message', webhookEventId: id, replyToken: id,
        source: { type: 'group', groupId: 'local-smoke-group', userId: 'local-member-' + id },
        message: { type: 'text', text },
      } }),
    });
    assert.equal(response.status, 200, await response.text());
  };
  await send('回程'); await send('1');
  assert.match(replies.at(-1).text, /已選擇/);
  await Promise.race([pushed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Alarm did not push')), 15000); })]);
  assert.match(pushes[0].messages[0].text, /超過 4 分鐘/);
  assert.match(pushes[1].messages[0].text, /超過 9 分鐘/);
  assert.equal(pushes[0].to, 'local-smoke-group');
  await send('停止追蹤');
  assert.match(replies.at(-1).text, /已停止/);
  console.log('workerd smoke passed: shared group, SQLite transactions, real alarm, two mock pushes and stop. No external traffic.');
} finally {
  clearTimeout(timer);
  await mf.dispose();
}
