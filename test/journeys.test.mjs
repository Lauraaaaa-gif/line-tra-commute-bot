import test from 'node:test';
import assert from 'node:assert/strict';
import { JourneyChoices, parseTripAction } from '../src/journeys.mjs';
import { SelectionStore } from '../src/selections.mjs';
import { RealtimeService, scheduledView } from '../src/realtime.mjs';
import { createBot } from '../src/bot.mjs';
import { readConfig } from '../src/config.mjs';
import { staticCopyBook } from '../src/copy-core.mjs';
import { silentLogger } from '../fixtures/sample.mjs';

const source = { type: 'user', userId: 'tracking-user' };
const now = Date.parse('2026-08-29T17:42:00+08:00');
const train = { number: '3238', type: '區間車', departure: '17:48', arrival: '18:08', arrivalDayOffset: 0, afterDestination: ['4300'] };
const result = { from: '新左營', to: '大湖', fromId: '4340', toId: '4290', date: '2026-08-29', time: '17:42', trains: [train] };
const replyText = reply => reply.message.altText ?? reply.message.text;
function setup() {
  let clock = now, delay = 0, known = true, reached = false;
  const pushes = [], replies = [], queries = [];
  const selections = new SelectionStore({ clock: () => clock });
  const realtime = { async view(r, t) { const base = scheduledView(r, t); return { ...base, known, reached, delay: known ? delay : null, etaAt: base.etaAt + (known ? delay * 60000 : 0), updatedAt: clock }; } };
  const lineClient = { async reply(token, message) { replies.push({ token, message }); }, async push(to, message, key) { pushes.push({ to, message, key }); } };
  const tracker = new JourneyChoices({ selections, realtime, lineClient, clock: () => clock, logger: silentLogger });
  const bot = createBot({ config: readConfig({}, { requireLine: false, requireTdx: false }), selections, journeys: tracker,
    lineClient, logger: silentLogger, trainService: { async lookup(route, instant, options) {
      queries.push({ route, instant, options });
      return { ...structuredClone(result), ...route, trains: options.exclude
        ? [{ ...train, number: '3242', departure: '18:26', arrival: '18:55' }] : [train] };
    } } });
  const event = (id, text, other = source) => ({ type: 'message', webhookEventId: id, replyToken: id, source: other, message: { type: 'text', text } });
  const send = async (id, text, other = source) => bot.handleEvents([event(id, text, other)], new Date(clock));
  const click = async (id, data, other = source) => bot.handleEvents([{ ...event(id, '', other), type: 'postback', postback: { data } }], new Date(clock));
  return { bot, tracker, pushes, replies, queries, lineClient, realtime, selections, event, send, click,
    advance(ms) { clock += ms; }, setDelay(v) { delay = v; }, setKnown(v) { known = v; }, setReached(v) { reached = v; } };
}
async function choose(s) { await s.send('query', '回程'); await s.send('select', '1'); }

const labels = s => s.replies.at(-1).message.quickReply?.items.map(x => x.action.label);
async function poll(s, minutes = 1) { s.advance(minutes * 60000); await s.bot.tracking.poll(async () => {}); }

test('知道後可直接取消；完整取消追蹤指令可用，閒聊不會誤觸', async () => {
  for (const mode of ['button', 'text']) {
    const s = setup(); await choose(s);
    await s.click('ack', 'ack:v1');
    assert.deepEqual(labels(s), ['取消追蹤']);
    const cancel = s.replies.at(-1).message.quickReply.items[0].action.data;
    for (const text of ['我想取消追蹤', '取消追蹤一下', '不要取消追蹤']) await s.send(text, text);
    assert.ok(s.bot.tracking.current(source));
    if (mode === 'button') await s.click('cancel', cancel);
    else await s.send('cancel', ' 取消追蹤 ');
    assert.equal(s.bot.tracking.current(source), null);
    await s.click('ack-again', 'ack:v1');
    assert.equal(labels(s), undefined);
    s.setDelay(12); await poll(s);
    assert.equal(s.pushes.length, 0);
  }
});

test('開始追蹤提示只用於有效選車或下一班，不出現在查詢及已到站班次', async () => {
  const s = setup();
  await s.send('query', '回程');
  assert.doesNotMatch(replyText(s.replies.at(-1)), /已開始追蹤/);
  await s.send('select', '1');
  assert.match(replyText(s.replies.at(-1)), /已開始追蹤列車狀態/);
  await s.send('miss', '沒搭上');
  assert.match(replyText(s.replies.at(-1)), /已開始追蹤列車狀態/);
  const expired = setup();
  expired.setReached(true);
  await choose(expired);
  assert.equal(expired.bot.tracking.current(source), null);
  assert.doesNotMatch(replyText(expired.replies.at(-1)), /已開始追蹤/);
});

test('知道後的取消按鈕綁定原班次，不能停止後來改選的車', async () => {
  const s = setup(); await choose(s);
  await s.click('ack', 'ack:v1');
  const cancel = s.replies.at(-1).message.quickReply.items[0].action.data;
  await s.send('miss', '沒搭上');
  const next = s.bot.tracking.current(source);
  await s.click('old-cancel', cancel);
  assert.equal(s.bot.tracking.current(source), next);
  s.advance(80 * 60000);
  await s.click('expired-ack', 'ack:v1');
  assert.equal(labels(s), undefined);
});

test('六種階段按鈕、知道不停止追蹤，以及完整停止指令', async () => {
  const s = setup();
  await s.send('start', '其他路線');
  assert.deepEqual(labels(s), ['去程', '回程', '其他路線']);
  await choose(s);
  assert.deepEqual(labels(s), ['知道', '搭上了', '沒搭上', '停止追蹤']);
  await s.send('board', '搭上了');
  assert.deepEqual(labels(s), ['知道', '停止追蹤']);
  await s.click('ack', 'ack:v1');
  assert.deepEqual(labels(s), ['取消追蹤']);
  assert.ok(s.bot.tracking.current(source));
  await s.send('miss', '沒搭上');
  assert.deepEqual(labels(s), ['知道', '去程', '回程', '其他路線', '停止追蹤']);
  assert.equal(s.bot.tracking.current(source).trip.train.number, '3242');
  await s.send('stop', '停止追蹤');
  assert.equal(s.bot.tracking.current(source), null);
  s.setDelay(12); await poll(s, 20);
  assert.equal(s.pushes.length, 0);
});

test('誤點嚴格超過4及9分鐘各一次，下降後再次升高不重複', async () => {
  const s = setup(); await choose(s);
  for (const [delay, count] of [[4, 0], [5, 1], [9, 1], [10, 2], [3, 2], [15, 2]]) {
    s.setDelay(delay); await poll(s);
    assert.equal(s.pushes.length, count, `delay=${delay}`);
  }
  assert.match(s.pushes[0].message.text, /超過 4 分鐘/);
  assert.match(s.pushes[1].message.text, /超過 9 分鐘/);
  assert.match(s.pushes[1].message.text, /18:18 抵達大湖/);
  assert.notEqual(s.pushes[0].key, s.pushes[1].key);
});

test('首次資料已超過9分鐘，兩個門檻都只通知一次；同車重選保留紀錄', async () => {
  const s = setup(); await choose(s);
  s.setDelay(12); await poll(s);
  assert.equal(s.pushes.length, 2);
  await s.send('reselect', '1'); await poll(s);
  assert.equal(s.pushes.length, 2);
});

test('沒搭上換追蹤下一班；舊停止按鈕不能取消新的行程', async () => {
  const s = setup(); await choose(s);
  const old = s.bot.tracking.current(source).trip.id;
  s.setDelay(5); await poll(s);
  assert.equal(s.pushes.length, 1);
  await s.send('miss', '沒搭上');
  const next = s.bot.tracking.current(source);
  assert.equal(next.trip.train.number, '3242');
  await s.click('old-stop', `trip:stop:${old}`);
  assert.equal(s.bot.tracking.current(source), next);
  await poll(s, 14);
  assert.match(s.pushes.at(-1).message.text, /3242/);
  await s.click('stop-next', `trip:stop:${next.trip.id}`);
  assert.equal(s.bot.tracking.nextAlarm(), null);
});

test('沒有即時資料不通知，保留最近有效ETA，抵達後清除追蹤與收件人', async () => {
  const s = setup(); await choose(s);
  s.setDelay(5); await poll(s);
  const eta = s.bot.tracking.current(source).endAt;
  s.setKnown(false); await poll(s, 25);
  assert.equal(s.bot.tracking.current(source).endAt, eta);
  assert.equal(s.pushes.length, 1);
  await poll(s, 5);
  assert.equal(s.bot.tracking.current(source), null);
  assert.equal(s.bot.tracking.nextAlarm(), null);
  assert.doesNotMatch(JSON.stringify(s.bot.tracking.snapshot()), /tracking-user/);
});

test('已抵達、無即時資料到表訂時間、封鎖都結束追蹤；網路錯誤不 crash', async () => {
  for (const reason of ['reached', 'scheduled', 'unfollow', 'network']) {
    const s = setup(); await choose(s);
    if (reason === 'reached') { s.setDelay(10); s.setReached(true); }
    if (reason === 'scheduled') s.setKnown(false);
    if (reason === 'unfollow') await s.bot.handleEvents([{ type: 'unfollow', source }], new Date(now));
    if (reason === 'network') s.realtime.view = async () => { throw new Error('fake network'); };
    await poll(s, reason === 'reached' ? 1 : 26);
    assert.equal(s.bot.tracking.current(source), null);
    assert.equal(s.pushes.length, 0);
  }
});

test('預計抵達當刻再確認延誤，延期至更新ETA才停止', async () => {
  const s = setup(); await choose(s);
  s.setDelay(10); await poll(s, 26);
  assert.equal(s.bot.tracking.current(source).endAt, now + 36 * 60000);
  await poll(s, 10);
  assert.equal(s.bot.tracking.current(source), null);
});

test('停止回覆失敗仍停止；没搭上重送可再查下一班，不追舊班次', async () => {
  for (const command of ['停止追蹤', '沒搭上']) {
    const s = setup(); await choose(s);
    const reply = s.lineClient.reply;
    s.lineClient.reply = async () => { throw new Error('test reply'); };
    await assert.rejects(s.send('retry-event', command));
    assert.equal(s.bot.tracking.current(source), null);
    s.lineClient.reply = reply;
    await s.send('retry-event', command);
    assert.equal(s.bot.tracking.current(source)?.trip.train.number ?? null, command === '沒搭上' ? '3242' : null);
  }
});

test('只接受完整「已搭上」指令；非完整指令與未知按鈕忽略', async t => {
  let timers = 0;
  t.mock.method(globalThis, 'setInterval', () => { timers++; throw new Error('unexpected timer'); });
  const s = setup();
  let views = 0;
  const view = s.realtime.view;
  s.realtime.view = async (...args) => { views++; return view(...args); };
  await choose(s);
  const id = s.tracker.choice(source).id;
  const before = { replies: s.replies.length, queries: s.queries.length, views };
  s.setDelay(30); s.advance(60000);
  for (const text of ['上車了', '停止通知', '我上車了', '已上車', '回程一下', '回程選擇1', '1 2']) await s.send(text, text);
  const data = `trip:cancel:${id}`;
  assert.equal(parseTripAction(data), null);
  await s.click('stop', data);
  assert.deepEqual({ replies: s.replies.length, queries: s.queries.length, views }, before);
  assert.equal(s.pushes.length, 0);
  assert.equal(timers, 0);
  assert.doesNotMatch(JSON.stringify([...s.tracker.choices.values()]), /tracking-user/);
  s.bot.close();
  assert.equal(s.tracker.choices.size, 0);
});

test('已搭上按鈕與完整指令回覆動態方向、抵達時間，保留行程繼續追蹤', async () => {
  for (const byButton of [true, false]) {
    const s = setup(); await choose(s);
    const chosen = s.tracker.choice(source);
    const before = { queries: s.queries.length, pushes: s.pushes.length };
    if (byButton) await s.click('board', `trip:board:${chosen.id}`);
    else await s.send('board-text', '已搭上');
    assert.equal(replyText(s.replies.at(-1)), '🛤️ 已經上車啦，目前順利回程中\n已開始追蹤列車狀態，誤點超過 4 分鐘及 9 分鐘時會通知。\n【預計於 18:08 抵達大湖】');
    assert.equal(s.replies.at(-1).message.type, 'text');
    assert.deepEqual(s.replies.at(-1).message.quickReply.items.map(x => x.action.label), ['知道', '停止追蹤']);
    assert.deepEqual({ queries: s.queries.length, pushes: s.pushes.length }, before);
    assert.equal(s.tracker.choice(source).id, chosen.id);
  }
});

test('沒搭上按鈕隔離使用者，舊按鈕不覆蓋最新選擇', async () => {
  const s = setup(); await choose(s);
  const data = s.replies.at(-1).message.quickReply.items.find(x => x.action.label === '沒搭上').action.data;
  assert.equal(parseTripAction(data).action, 'miss');
  assert.equal(parseTripAction(`${data}:extra`), null);
  await s.click('other', data, { ...source, userId: 'other' });
  assert.match(replyText(s.replies.at(-1)), /重新查詢/);
  await s.send('new-choice', '1');
  const latest = s.tracker.choice(source);
  await s.click('old', data);
  assert.equal(s.tracker.choice(source), latest);
  assert.equal(s.queries.length, 1);
  await s.click('current', `trip:miss:${latest.id}`);
  assert.equal(s.queries.length, 2);
  assert.equal(s.tracker.choice(source).train.number, '3242');
});

test('選擇過期、重查與封鎖後沒搭上要求重新選車', async () => {
  for (const reason of ['expired', 'query', 'unfollow']) {
    const s = setup(); await choose(s);
    if (reason === 'expired') s.advance(1800001);
    if (reason === 'query') await s.send('new-query', '回程');
    if (reason === 'unfollow') await s.bot.handleEvents([{ type: 'unfollow', source }], new Date(now));
    const count = s.queries.length;
    await s.send('miss', '沒搭上');
    assert.match(replyText(s.replies.at(-1)), /重新查詢/);
    assert.equal(s.queries.length, count);
  }
});

test('選車回覆失敗不記住未送出的選擇', async () => {
  const s = setup(); await choose(s);
  const previous = s.tracker.choice(source);
  s.lineClient.reply = async () => { throw new Error('mock failure'); };
  await assert.rejects(s.send('failed-selection', '1'));
  assert.equal(s.tracker.choice(source), previous);
});

test('保留列表與選車格式；只在選車時估算抵達時間', async () => {
  const s = setup(); await s.send('query', '回程');
  assert.equal(replyText(s.replies[0]), '🚆 新左營 → 大湖\n\n最近班次\n① 17:48　區間車 3238\n\n查詢日期：2026-08-29\n現在時間：17:42（台灣時間）');
  s.setDelay(7); await s.send('select', '1');
  assert.equal(replyText(s.replies.at(-1)), '🚆 新左營 → 大湖\n已選擇區間車 3238\n\n預計於 17:48 於新左營上車\n【抵達大湖時間約 18:15】' + '\n\n' + staticCopyBook.text('trackingStarted'));
  assert.equal(s.replies.at(-1).message.type, 'text');
  assert.deepEqual(s.replies.at(-1).message.quickReply.items.map(x => x.action.label), ['知道', '搭上了', '沒搭上', '停止追蹤']);
});

test('沒搭上重查下一班，傳遞明確排除車次', async () => {
  const s = setup(); await choose(s); await s.send('miss', '沒搭上');
  assert.deepEqual(s.queries.at(-1).options.exclude, { number: '3238', departure: '17:48' });
  assert.equal(s.queries.length, 2);
  assert.equal(replyText(s.replies.at(-1)), '💨 差一點點，這班沒搭上\n下一班約 18:26 從新左營出發\n【預計於 18:55 抵達大湖】' + '\n\n' + staticCopyBook.text('trackingStarted'));
  assert.equal(s.replies.at(-1).message.type, 'text');
  assert.equal(s.tracker.choice(source).train.number, '3242');
  assert.equal(s.tracker.choice(source).train.departure, '18:26');
  assert.deepEqual(s.replies.at(-1).message.quickReply.items.map(x => x.action.label), ['知道', '去程', '回程', '其他路線', '停止追蹤']);
});

test('沒搭上後查無下一班或查詢失敗，不捏造出發／抵達時間', async () => {
  for (const fail of [false, true]) {
    const s = setup(); await choose(s);
    s.queries.length = 0;
    // 用同一 tracker 保留已選行程，換成空／失敗的查詢服務。
    const bot = createBot({ config: readConfig({}, { requireLine: false, requireTdx: false }), selections: s.selections, journeys: s.tracker,
      lineClient: s.lineClient, logger: silentLogger, trainService: { async lookup() { if (fail) throw new Error('test'); return { ...result, trains: [] }; } } });
    await bot.handleEvents([s.event('miss', '沒搭上')], new Date(now));
    const text = replyText(s.replies.at(-1));
    assert.match(text, /差一點點/); assert.match(text, fail ? /無法取得/ : /查無符合條件/);
    assert.doesNotMatch(text, /下一班約|NaN|undefined|【預計/);
    assert.equal(s.tracker.choice(source), null);
  }
});

test('RealtimeService 快取同車次、拒絕過期／缺欄位資料，跨午夜 ETA 正確', async () => {
  let calls = 0;
  let rows = [{ TrainNo: '3238', DelayTime: 6, StationID: '4340', UpdateTime: new Date(now).toISOString() }];
  const realtime = new RealtimeService({ async get(path) { calls++; assert.match(path, /TrainNo\/3238$/); return { TrainLiveBoards: rows }; } }, { clock: () => now });
  const views = await Promise.all([realtime.view(result, train, new Date(now)), realtime.view(result, train, new Date(now))]);
  assert.equal(calls, 1); assert.equal(views[0].known, true); assert.equal(views[0].delay, 6);
  assert.equal((await realtime.view(result, train, new Date(now + 360000))).known, false);
  for (const row of [ {}, { TrainNo: '3238', UpdateTime: new Date(now).toISOString() }, { TrainNo: '3238', DelayTime: 6, UpdateTime: '2026-08-28T17:42:00+08:00' } ]) {
    rows = [row]; realtime.cache.clear(); assert.equal((await realtime.view(result, train, new Date(now))).known, false);
  }
  rows = [{ TrainNo: '3238', DelayTime: 6, StationID: '4290', TrainStationStatus: 2, UpdateTime: new Date(now).toISOString() }];
  realtime.cache.clear(); assert.equal((await realtime.view(result, train, new Date(now))).reached, true);
  const overnight = scheduledView({ ...result, date: '2026-08-31' }, { ...train, departure: '23:59', arrival: '00:10', arrivalDayOffset: 1 });
  assert.equal(new Date(overnight.arrivalAt).toISOString(), '2026-08-31T16:10:00.000Z');
});
