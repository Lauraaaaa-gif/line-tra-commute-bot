import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import { createApp } from '../src/app.mjs';
import { createBot } from '../src/bot.mjs';
import { TdxClient } from '../src/tdx.mjs';
import { TrainService } from '../src/trains.mjs';
import { LineClient } from '../src/line.mjs';
import { readConfig } from '../src/config.mjs';
import { SelectionStore } from '../src/selections.mjs';
import { JourneyChoices } from '../src/journeys.mjs';
import { RealtimeService } from '../src/realtime.mjs';
import { sampleTrains, stations, reply, silentLogger } from '../fixtures/sample.mjs';

const secret = 'webhook-test-secret';
const now = new Date('2026-08-28T17:42:00+08:00');
const sign = raw => createHmac('sha256', secret).update(raw).digest('base64');
const event = { type: 'message', webhookEventId: 'integration-1', replyToken: 'mock-reply', message: { type: 'text', text: '回程' }, source: { type: 'user', userId: 'integration-user' } };

async function serve(t, options = {}) {
  const app = createApp({ secret, logger: silentLogger, clock: () => now, bot: { async handleEvents() {} }, ...options });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const url = `http://127.0.0.1:${app.address().port}`;
  const post = (body, headers = {}) => fetch(`${url}/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sign(body), ...headers }, body,
  });
  return { url, post };
}

test('HTTP 健康檢查、404、405 與 Webhook Verify 空 events', async t => {
  const { url, post } = await serve(t);
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await fetch(`${url}/.env`)).status, 404);
  assert.equal((await fetch(`${url}/webhook`)).status, 405);
  assert.equal((await post('{"events":[]}')).status, 200);
});

test('HTTP 無效簽章先拒絕，不呼叫 bot；無效 JSON/schema 拒絕', async t => {
  let calls = 0;
  const { post } = await serve(t, { bot: { async handleEvents() { calls++; } } });
  assert.equal((await post('{"events":[]}', { 'x-line-signature': 'bad' })).status, 401);
  assert.equal((await post('invalid json')).status, 400);
  assert.equal((await post('{"events":null}')).status, 400);
  assert.equal((await post('{"events":[null]}')).status, 400);
  assert.equal(calls, 0);
});

test('HTTP 拒絕錯誤 content type、壓縮 body 與過大 body', async t => {
  const { post } = await serve(t, { maxBytes: 30 });
  assert.equal((await post('{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('{}', { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal((await post(JSON.stringify({ text: 'x'.repeat(100) }))).status, 413);
});

test('完整 HTTP Webhook → TDX OAuth/車站/班表 → LINE reply，無外部網路', async t => {
  const sent = [];
  const calls = [];
  const fakeFetch = async (input, init) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.hostname === 'api.line.me') {
      sent.push(JSON.parse(init.body));
      return reply({ sentMessages: [] });
    }
    if (url.pathname.endsWith('/token')) return reply({ access_token: 'mock-token', expires_in: 3600 });
    if (url.pathname.endsWith('/Station')) return reply({ Stations: stations, Count: stations.length });
    assert.match(url.pathname, /\/OD\/4340\/to\/4290\/2026-08-28$/);
    return reply({ TrainDate: '2026-08-28', TrainTimetables: sampleTrains(), Count: sampleTrains().length });
  };
  const config = readConfig({}, { requireLine: false, requireTdx: false });
  const tdx = new TdxClient({ clientId: 'test', clientSecret: 'test', fetchImpl: fakeFetch });
  const bot = createBot({ config, logger: silentLogger, trainService: new TrainService(tdx, config), lineClient: new LineClient({ accessToken: 'test', fetchImpl: fakeFetch }) });
  const { post } = await serve(t, { bot });
  const body = JSON.stringify({ events: [event] });
  assert.equal((await post(body)).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].replyToken, 'mock-reply');
  assert.match(sent[0].messages[0].text, /① 17:48　區間車 3238/);
  assert.doesNotMatch(sent[0].messages[0].text, /④/);
  assert.equal(sent[0].messages[0].quickReply.items.length, 5);
  assert.equal(calls.length, 4);
  assert.equal((await post(body)).status, 200);
  assert.equal(sent.length, 1);
  const data = sent[0].messages[0].quickReply.items[0].action.data;
  const selectionBody = JSON.stringify({ events: [{ ...event, type: 'postback', message: undefined,
    webhookEventId: 'integration-selection', replyToken: 'selection-reply', postback: { data } }] });
  assert.equal((await post(selectionBody)).status, 200);
  assert.match(sent[1].messages[0].text, /【抵達大湖時間約 17:48】/);
  assert.equal(sent[1].replyToken, 'selection-reply');
  assert.equal(calls.length, 5); // 只新增 LINE reply，沒有再次查詢 TDX。
  assert.equal((await post(selectionBody)).status, 200);
  assert.equal(sent.length, 2);
});

test('LINE 回覆錯誤回傳非 2xx，允許 LINE Webhook redelivery', async t => {
  const { post } = await serve(t, { bot: { async handleEvents() { throw new Error('sensitive'); } } });
  const response = await post(JSON.stringify({ events: [event] }));
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /sensitive/);
});

test('完整簽章 HTTP 選車即時估算保留，舊上車指令及按鈕不回覆、不推播', async t => {
  const delay = 6;
  const sent = [];
  const fakeFetch = async (input, init) => {
    const url = new URL(input);
    if (url.hostname === 'api.line.me') { sent.push({ path: url.pathname, data: JSON.parse(init.body) }); return reply({}); }
    if (url.pathname.endsWith('/token')) return reply({ access_token: 'test', expires_in: 3600 });
    if (url.pathname.endsWith('/Station')) return reply({ Stations: stations, Count: stations.length });
    if (url.pathname.includes('/TrainLiveBoard/')) return reply({ TrainLiveBoards: [{ TrainNo: '3238', DelayTime: delay, StationID: '4340', UpdateTime: now.toISOString() }] });
    return reply({ TrainDate: '2026-08-28', TrainTimetables: sampleTrains(), Count: sampleTrains().length });
  };
  const config = readConfig({}, { requireLine: false, requireTdx: false });
  const tdx = new TdxClient({ clientId: 'test', clientSecret: 'test', fetchImpl: fakeFetch });
  const lineClient = new LineClient({ accessToken: 'test', fetchImpl: fakeFetch });
  const selections = new SelectionStore({ clock: () => now.getTime() });
  const realtime = new RealtimeService(tdx, { clock: () => now.getTime(), cacheMs: 0 });
  const journeys = new JourneyChoices({ selections, realtime, lineClient, clock: () => now.getTime(), logger: silentLogger });
  const bot = createBot({ config, selections, journeys, lineClient, logger: silentLogger, trainService: new TrainService(tdx, config) });
  const { post } = await serve(t, { bot });
  const command = async (id, text) => {
    const response = await post(JSON.stringify({ events: [{ ...event, webhookEventId: id, message: { type: 'text', text } }] }));
    assert.equal(response.status, 200);
  };
  await command('query', '回程'); await command('select', '1');
  const selected = sent.at(-1).data.messages[0];
  assert.deepEqual(selected.quickReply.items.map(x => x.action.label), ['已搭上', '沒搭上', '去程', '回程']);
  assert.match(selected.text, /抵達大湖時間約 17:54/);
  const oldId = selected.quickReply.items[0].action.data.split(':')[2];
  const count = sent.length;
  assert.equal((await post(JSON.stringify({ events: [{ ...event, type: 'postback', webhookEventId: 'board', postback: { data: 'trip:board:' + oldId } }] }))).status, 200);
  assert.equal(sent.length, count + 1);
  assert.equal(sent.at(-1).data.messages[0].text, '🛤️ 已經上車啦，目前順利回程中\n【預計於 17:54 抵達大湖】');
  assert.deepEqual(sent.at(-1).data.messages[0].quickReply.items.map(x => x.action.label), ['去程', '回程']);
  const afterBoard = sent.length;
  await command('board-alias', '上車了'); await command('stop-text', '停止通知');
  assert.equal((await post(JSON.stringify({ events: [{ ...event, type: 'postback', webhookEventId: 'stop', postback: { data: 'trip:stop:' + oldId } }] }))).status, 200);
  assert.equal(sent.length, afterBoard);
  assert.equal(sent.filter(x => x.path.endsWith('/push')).length, 0);
  bot.close();
});

test('分塊傳輸超過大小上限也回 413，不因串流關閉而斷線', async t => {
  const { url } = await serve(t, { maxBytes: 30 });
  const status = await new Promise((resolve, reject) => {
    const req = request(`${url}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.write('x'.repeat(20));
    req.end('x'.repeat(20));
  });
  assert.equal(status, 413);
});
