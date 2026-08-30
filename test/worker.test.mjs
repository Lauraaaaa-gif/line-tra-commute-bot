import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { BotState, createWorker } from '../src/worker.mjs';
import { SelectionStore } from '../src/selections.mjs';
import { JourneyChoices } from '../src/journeys.mjs';
import { EventDeduplicator } from '../src/bot.mjs';
import { scheduledView } from '../src/realtime.mjs';
import { train, sampleTrains, stations, reply } from '../fixtures/sample.mjs';

const secret = 'worker-signature-secret';
const sign = raw => createHmac('sha256', secret).update(raw).digest('base64');

// 人工車站與班表，僅攔截 TDX／LINE 傳輸；其餘使用正式 Worker 業務流程。
function routeWorker({ empty = false, failure = false } = {}) {
  const now = new Date('2026-08-28T17:42:00+08:00');
  const stored = new Map(), sent = [], calls = [];
  const routeStations = [...stations, ...[['9001', '路竹'], ['9002', '臺南'], ['9003', '岡山'], ['9004', '高雄']]
    .map(([StationID, name]) => ({ StationID, StationName: { Zh_tw: name } }))];
  const fakeFetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(init.redirect, 'manual');
    calls.push(url.pathname);
    if (url.hostname === 'api.line.me') { sent.push(JSON.parse(init.body).messages[0]); return reply({}); }
    if (url.pathname.endsWith('/token')) return reply({ access_token: 'fake-token', expires_in: 3600 });
    if (url.pathname.endsWith('/Station')) return reply({ Stations: routeStations, Count: routeStations.length });
    if (url.pathname.includes('/TrainLiveBoard/')) return reply({ TrainLiveBoards: [] });
    const match = /\/OD\/(\d{4})\/to\/(\d{4})\/2026-08-28$/.exec(url.pathname);
    assert.ok(match, url.pathname);
    if (failure) return reply({}, 503);
    const rows = empty ? [] : [
      train('9004', '18:40', { from: match[1], to: match[2], arrival: '19:00' }),
      train('9000', '17:30', { from: match[1], to: match[2], arrival: '17:50' }),
      train('9001', '17:48', { from: match[1], to: match[2], arrival: '18:08' }),
      train('9002', '18:02', { from: match[1], to: match[2], arrival: '18:22' }),
      train('9003', '18:16', { from: match[1], to: match[2], arrival: '18:36' }),
    ];
    return reply({ TrainDate: '2026-08-28', TrainTimetables: rows, Count: rows.length });
  };
  const makeObject = () => new BotState({
    storage: {
      async get(key) { return structuredClone(stored.get(key)); },
      async put(key, value) { stored.set(key, structuredClone(value)); },
    },
    blockConcurrencyWhile(work) { return work(); },
  }, {
    LINE_CHANNEL_SECRET: 'test-secret', LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
    TDX_CLIENT_ID: 'test-client', TDX_CLIENT_SECRET: 'test-client-secret',
  }, { fetchImpl: fakeFetch, clock: () => now.getTime() });
  let object = makeObject(), sequence = 0;
  return {
    calls, sent,
    restore() { object = makeObject(); },
    async send(text, data) {
      sequence++;
      const event = { type: data ? 'postback' : 'message', webhookEventId: String(sequence), replyToken: String(sequence),
        source: { type: 'user', userId: 'U' + 'a'.repeat(32) },
        ...(data ? { postback: { data } } : { message: { type: 'text', text } }),
      };
      const response = await object.fetch(new Request('https://bot-state.internal/event', {
        method: 'POST', body: JSON.stringify({ event, receivedAt: now.toISOString() }),
      }));
      assert.equal(response.status, 200);
      return sent.at(-1);
    },
  };
}

test('固定去回程與中文其他路線均通過 TDX 車站查找、排序、LINE 回覆', async t => {
  for (const [input, from, to, fromId, toId] of [
    ['去程', '大湖', '新左營', '4290', '4340'],
    ['回程', '新左營', '大湖', '4340', '4290'],
    ['新左營到路竹', '新左營', '路竹', '4340', '9001'],
    ['新左營站到路竹站', '新左營', '路竹', '4340', '9001'],
    ['火車 新左營 路竹', '新左營', '路竹', '4340', '9001'],
    ['台南到新左營', '臺南', '新左營', '9002', '4340'],
    ['岡山到高雄', '岡山', '高雄', '9003', '9004'],
  ]) await t.test(input, async () => {
    const s = routeWorker();
    const message = await s.send(input);
    assert.equal(message.type, 'text');
    assert.ok(message.text.startsWith('🚆 ' + from + ' → ' + to));
    assert.match(message.text, /① 17:48　區間車 9001/);
    assert.match(message.text, /③ 18:16　區間車 9003/);
    assert.doesNotMatch(message.text, /9000|9004|④/);
    assert.ok(s.calls.some(path => path.endsWith('/OD/' + fromId + '/to/' + toId + '/2026-08-28')));
    const selected = await s.send('1');
    assert.ok(selected.text.includes('抵達' + to + '時間約 18:08'));
  });
});

test('其他路線：未知站、重複站字、同站、空班表及上游失敗皆正常回覆', async t => {
  for (const [input, options, expected, noNetwork] of [
    ['新左營到路竹站站', {}, '⚠️ 找不到車站「路竹站站」\n請確認車站名稱後重新輸入。', false],
    ['不存在到路竹', {}, '⚠️ 找不到車站「不存在」\n請確認車站名稱後重新輸入。', false],
    ['新左營到新左營', {}, '⚠️ 起點與終點不能相同。', true],
    ['台南站到臺南', {}, '⚠️ 起點與終點不能相同。', true],
    ['新左營到路竹', { empty: true }, '目前查不到「新左營 → 路竹」接下來的班次。', false],
    ['新左營到路竹', { failure: true }, '目前無法取得台鐵時刻資料', false],
  ]) await t.test(input + JSON.stringify(options), async () => {
    const s = routeWorker(options);
    const message = await s.send(input);
    assert.ok(message.text.includes(expected));
    if (noNetwork) assert.equal(s.calls.filter(path => !path.includes('/message/reply')).length, 0);
    if (!options.empty && !options.failure) assert.equal(s.calls.filter(path => path.includes('/OD/')).length, 0);
    assert.ok(message.quickReply.items.every(item => !item.action.data?.startsWith('arrival:')));
    assert.match((await s.send('1')).text, /重新查詢/);
  });
});

test('其他路線保留舊列表、重啟後沒搭上查原路線及搭上了；不啟動推播', async () => {
  const s = routeWorker();
  const first = await s.send('新左營到路竹');
  const selectData = first.quickReply.items[0].action.data;
  await s.send('回程');
  s.restore();
  assert.match((await s.send(null, selectData)).text, /抵達路竹時間約 18:08/);
  s.restore();
  const missed = await s.send('沒搭上');
  assert.match(missed.text, /下一班約 18:02 從新左營出發/);
  assert.match(missed.text, /18:22 抵達路竹/);
  assert.match(s.calls.filter(path => path.includes('/OD/')).at(-1), /\/4340\/to\/9001\//);
  s.restore();
  const boarded = await s.send(null, missed.quickReply.items[0].action.data);
  assert.match(boarded.text, /前往路竹中/);
  assert.match(boarded.text, /18:22 抵達路竹/);
  assert.equal(s.calls.filter(path => path.endsWith('/push')).length, 0);
});

test('其他路線說明不查 TDX、不清除已選車次；查不到班次會清除舊數字對應', async () => {
  const s = routeWorker();
  await s.send('新左營到路竹');
  const calls = s.calls.length;
  assert.match((await s.send('其他路線')).text, /🔎 其他路線查詢/);
  assert.equal(s.calls.length, calls + 1);
  assert.match((await s.send('1')).text, /抵達路竹/);
  await s.send('新左營到路竹站站');
  assert.match((await s.send('1')).text, /重新查詢/);
});

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
