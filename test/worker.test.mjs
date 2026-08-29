import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { BotState, createWorker } from '../src/worker.mjs';
import { SelectionStore } from '../src/selections.mjs';
import { JourneyChoices } from '../src/journeys.mjs';
import { EventDeduplicator } from '../src/bot.mjs';
import { scheduledView } from '../src/realtime.mjs';
import { sampleTrains, stations, reply } from '../fixtures/sample.mjs';

const secret = 'worker-signature-secret';
const sign = raw => createHmac('sha256', secret).update(raw).digest('base64');

function request(path, body, headers = {}) {
  return new Request(`https://example.workers.dev${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', 'x-line-signature': sign(body), ...headers },
    body,
  });
}

test('Worker 健康檢查、路由與簽章驗證', async () => {
  const worker = createWorker();
  assert.equal((await worker.fetch(request('/health'), {})).status, 200);
  assert.equal((await worker.fetch(request('/.env'), {})).status, 404);
  const invalid = request('/webhook', '{"events":[]}', { 'x-line-signature': 'bad' });
  assert.equal((await worker.fetch(invalid, { LINE_CHANNEL_SECRET: secret })).status, 401);
});

test('Worker 驗章後以不可逆聊天室摘要分派 Durable Object', async () => {
  const calls = [];
  const names = [];
  const env = {
    LINE_CHANNEL_SECRET: secret,
    BOT_STATE: {
      idFromName(name) { names.push(name); return `id:${name}`; },
      get(id) {
        return { async fetch(url, init) { calls.push({ id, url, value: JSON.parse(init.body) }); return Response.json({ ok: true }); } };
      },
    },
  };
  const event = { type: 'message', webhookEventId: 'evt-1', replyToken: 'reply-1',
    message: { type: 'text', text: '回程' }, source: { type: 'group', groupId: 'C-secret-group', userId: 'U-secret-user' } };
  const body = JSON.stringify({ events: [event] });
  const response = await createWorker().fetch(request('/webhook', body), env);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(names[0], /^[0-9a-f]{64}$/);
  assert.doesNotMatch(names[0], /secret|group|user/);
  assert.deepEqual(calls[0].value.event, event);
  assert.ok(Number.isFinite(Date.parse(calls[0].value.receivedAt)));
});

test('Durable Object 快照可還原列表、選車與 webhook 去重', async () => {
  const now = Date.parse('2026-08-29T17:42:00+08:00');
  const source = { type: 'user', userId: 'U' + 'a'.repeat(32) };
  const result = { from: '新左營', to: '大湖', fromId: '4340', toId: '4290', date: '2026-08-29', time: '17:42',
    trains: [{ number: '3238', type: '區間車', departure: '17:48', arrival: '18:08', arrivalDayOffset: 0, afterDestination: [] }] };
  const selections = new SelectionStore({ clock: () => now });
  const entry = selections.prepare(source, '回程', result);
  selections.commit(entry, source, '回程', new Date(now));
  const journeys = new JourneyChoices({ selections, clock: () => now });
  const trip = journeys.prepare(source, entry, result.trains[0], scheduledView(result, result.trains[0]));
  journeys.remember(trip);
  const dedupe = new EventDeduplicator({ clock: () => now });
  let executions = 0;
  await dedupe.run('evt-1', async () => { executions++; });

  const restoredSelections = new SelectionStore({ clock: () => now });
  const restoredJourneys = new JourneyChoices({ selections: restoredSelections, clock: () => now });
  const restoredDedupe = new EventDeduplicator({ clock: () => now });
  assert.equal(restoredSelections.restore(selections.snapshot()), true);
  assert.equal(restoredJourneys.restore(journeys.snapshot()), true);
  assert.equal(restoredDedupe.restore(dedupe.snapshot()), true);
  assert.equal(restoredSelections.select(source, { index: 1 }, new Date(now)).train.number, '3238');
  assert.equal(restoredJourneys.choice(source).id, trip.id);
  await restoredDedupe.run('evt-1', async () => { executions++; });
  assert.equal(executions, 1);
});

test('Durable Object 被移出記憶體後仍可從前一次列表選車', async () => {
  const now = new Date('2026-08-28T17:42:00+08:00');
  const stored = new Map();
  const makeState = () => ({
    storage: {
      async get(key) { return structuredClone(stored.get(key)); },
      async put(key, value) { stored.set(key, structuredClone(value)); },
    },
    blockConcurrencyWhile(work) { return work(); },
  });
  const sent = [];
  const fakeFetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.line.me') { sent.push(JSON.parse(init.body)); return reply({}); }
    if (url.pathname.endsWith('/token')) return reply({ access_token: 'token', expires_in: 3600 });
    if (url.pathname.endsWith('/Station')) return reply({ Stations: stations, Count: stations.length });
    if (url.pathname.includes('/TrainLiveBoard/')) return reply({ TrainLiveBoards: [] });
    return reply({ TrainDate: '2026-08-28', TrainTimetables: sampleTrains(), Count: sampleTrains().length });
  };
  const env = {
    LINE_CHANNEL_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    TDX_CLIENT_ID: 'client', TDX_CLIENT_SECRET: 'client-secret',
  };
  const source = { type: 'user', userId: 'U' + 'a'.repeat(32) };
  const deliver = (object, event) => object.fetch(new Request('https://bot-state.internal/event', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, receivedAt: now.toISOString() }),
  }));
  const first = new BotState(makeState(), env, { fetchImpl: fakeFetch, clock: () => now.getTime() });
  const query = { type: 'message', webhookEventId: 'query', replyToken: 'reply-query', source,
    message: { type: 'text', text: '回程' } };
  assert.equal((await deliver(first, query)).status, 200);
  const data = sent[0].messages[0].quickReply.items[0].action.data;

  const restored = new BotState(makeState(), env, { fetchImpl: fakeFetch, clock: () => now.getTime() });
  const select = { type: 'postback', webhookEventId: 'select', replyToken: 'reply-select', source, postback: { data } };
  assert.equal((await deliver(restored, select)).status, 200);
  assert.match(sent[1].messages[0].text, /已選擇區間車 3238/);
});
