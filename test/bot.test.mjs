import test from 'node:test';
import assert from 'node:assert/strict';
import { createBot, EventDeduplicator } from '../src/bot.mjs';
import { readConfig } from '../src/config.mjs';
import { ServiceError } from '../src/errors.mjs';
import { silentLogger } from '../fixtures/sample.mjs';
import { SelectionStore, parseSelection } from '../src/selections.mjs';

const config = readConfig({}, { requireLine: false, requireTdx: false });
const now = new Date('2026-08-28T17:42:00+08:00');
const event = (id, text = '回程') => ({ webhookEventId: id, replyToken: `reply-${id}`, type: 'message', message: { type: 'text', text }, source: { type: 'user', userId: 'test-user' } });
const replyText = reply => reply.message.altText ?? reply.message.text;

function makeBot(overrides = {}) {
  const replies = [];
  const routes = [];
  const bot = createBot({ config, logger: silentLogger,
    trainService: { async lookup(route, time) { routes.push({ route, time }); return { from: route.from, to: route.to, date: '2026-08-28', time: '17:42', trains: [] }; } },
    lineClient: { async reply(token, message) { replies.push({ token, message }); } },
    ...overrides,
  });
  return { bot, replies, routes };
}

test('同時重送的相同 webhook event 只查詢與回覆一次', async () => {
  const { bot, replies, routes } = makeBot();
  await Promise.all([bot.handleEvents([event('1')], now), bot.handleEvents([event('1')], now)]);
  await bot.handleEvents([event('1')], now);
  assert.equal(replies.length, 1);
  assert.equal(routes.length, 1);
});

test('多事件兩個方向，使用 receivedAt 而非 timestamp', async () => {
  const { bot, routes } = makeBot();
  await bot.handleEvents([{ ...event('1', '去程'), timestamp: 0 }, event('2')], now);
  assert.deepEqual(routes.map(x => x.route), [config.routes.去程, config.routes.回程]);
  assert.equal(routes[0].time, now);
});

test('LINE 回覆失敗不標記成功，下次重送可重試', async () => {
  let attempts = 0;
  const { bot } = makeBot({ lineClient: { async reply() { if (++attempts === 1) throw new ServiceError('LINE_HTTP_ERROR', 500); } } });
  await assert.rejects(bot.handleEvents([event('1')], now));
  await bot.handleEvents([event('1')], now);
  assert.equal(attempts, 2);
});

test('TDX 錯誤回覆可理解的提示，不洩漏 exception', async () => {
  const { bot, replies } = makeBot({ trainService: { async lookup() { throw new Error('private-secret'); } } });
  await bot.handleEvents([event('1')], now);
  assert.match(replyText(replies[0]), /目前無法取得/);
  assert.doesNotMatch(replyText(replies[0]), /private-secret/);
});

test('未知文字、follow、群組閒聊與非文字全部忽略；只回完整說明指令', async () => {
  const { bot, replies, routes } = makeBot();
  await bot.handleEvents([
    event('1', '哈囉'),
    { ...event('2'), type: 'follow' },
    { ...event('3', '哈囉'), source: { type: 'group' } },
    { ...event('4'), message: { type: 'image' } },
    { ...event('5'), mode: 'standby' },
    { ...event('6'), replyToken: undefined },
  ], now);
  assert.equal(replies.length, 0);
  await bot.handleEvents([event('help', '說明')], now);
  assert.equal(replies.length, 1);
  assert.equal(routes.length, 0);
});

test('去重記錄到期與容量上限', async () => {
  let clock = 0;
  let runs = 0;
  const dedupe = new EventDeduplicator({ clock: () => clock, ttlMs: 10, maxEntries: 1 });
  await dedupe.run('1', () => { runs++; });
  await assert.rejects(dedupe.run('2', () => {}), /BOT_BUSY/);
  clock = 11;
  await dedupe.run('1', () => { runs++; });
  assert.equal(runs, 2);
});

test('多事件部分失敗後重送，只重試失敗的那筆', async () => {
  const tokens = [];
  let failed = false;
  const { bot } = makeBot({ lineClient: { async reply(token) {
    tokens.push(token);
    if (token === 'reply-2' && !failed) { failed = true; throw new ServiceError('LINE_HTTP_ERROR', 503); }
  } } });
  const batch = [event('1'), event('2')];
  await assert.rejects(bot.handleEvents(batch, now));
  await bot.handleEvents(batch, now);
  assert.equal(tokens.filter(x => x === 'reply-1').length, 1);
  assert.equal(tokens.filter(x => x === 'reply-2').length, 2);
});

test('超過八個同時處理事件會回 BOT_BUSY，不過量呼叫上游', async () => {
  const { bot } = makeBot({ lineClient: { async reply() { await new Promise(resolve => setTimeout(resolve, 20)); } } });
  await assert.rejects(bot.handleEvents(Array.from({ length: 9 }, (_, i) => event(String(i))), now), /BOT_BUSY/);
});

function selectable(overrides = {}) {
  let lookups = 0;
  const setup = makeBot({ trainService: { async lookup(route) {
    lookups++;
    return { ...route, date: '2026-08-28', time: '17:42', trains: [
      { number: String(lookups), type: '區間車', departure: '17:48', arrival: '18:08', arrivalDayOffset: 0 },
      { number: 'second', type: '區間車', departure: '18:02', arrival: '18:22', arrivalDayOffset: 0 },
    ] };
  } }, ...overrides });
  return { ...setup, lookups: () => lookups };
}
const postback = (id, data) => ({ ...event(id), type: 'postback', message: undefined, postback: { data } });

test('數字與按鈕顯示目的站到達時間，不增加 TDX 查詢；舊按鈕保留原班次', async () => {
  const { bot, replies, lookups } = selectable();
  await bot.handleEvents([event('list')], now);
  const firstButton = replies[0].message.quickReply.items[0].action;
  assert.equal(firstButton.type, 'postback');
  assert.deepEqual(replies[0].message.quickReply.items.slice(-3).map(x => x.action.label), ['去程', '回程', '其他路線']);
  await bot.handleEvents([event('choose', '１')], now);
  assert.match(replyText(replies.at(-1)), /【抵達大湖時間約 18:08】/);
  assert.equal(lookups(), 1);
  await bot.handleEvents([event('other', '去程')], now);
  const beforeUnknown = replies.length;
  await bot.handleEvents([event('qualified', '回程選擇1')], now);
  assert.equal(replies.length, beforeUnknown);
  const old = postback('old-button', firstButton.data);
  await bot.handleEvents([old], now);
  assert.match(replyText(replies.at(-1)), /新左營 → 大湖\n已選擇區間車 1\n/);
  const count = replies.length;
  await bot.handleEvents([old], now);
  assert.equal(replies.length, count);
  await bot.handleEvents([event('latest', '2')], now);
  assert.match(replyText(replies.at(-1)), /大湖 → 新左營/);
  assert.match(replyText(replies.at(-1)), /18:22/);
  assert.equal(lookups(), 2);
});

test('未查詢、超出範圍、無效按鈕都安全提示', async () => {
  const { bot, replies } = selectable();
  await bot.handleEvents([event('missing', '1')], now);
  assert.match(replyText(replies.at(-1)), /重新查詢/);
  await bot.handleEvents([event('list')], now);
  for (const text of ['3', '10']) {
    await bot.handleEvents([event(text, text)], now);
    assert.match(replyText(replies.at(-1)), /請選擇 1～2/);
  }
  const count = replies.length;
  for (const text of ['0', '99', '01']) await bot.handleEvents([event(`ignored-${text}`, text)], now);
  assert.equal(replies.length, count);
  await bot.handleEvents([postback('bad', 'arrival:invalid')], now);
  assert.equal(replies.length, count);
  await bot.handleEvents([postback('unrelated', 'other')], now);
  assert.equal(replies.length, count);
  assert.equal(parseSelection('①').index, 1);
});

test('不同使用者與不同聊天室不共用列表或按鈕', async () => {
  const controller = 'U' + 'a'.repeat(32);
  const { bot, replies } = selectable({ config: { ...config, groupControllerUserId: controller } });
  const source = { type: 'group', groupId: 'group-a', userId: controller };
  await bot.handleEvents([{ ...event('list'), source }], now);
  const data = replies[0].message.quickReply.items[0].action.data;
  const count = replies.length;
  await bot.handleEvents([{ ...postback('family-control', data), source: { ...source, userId: 'U' + 'b'.repeat(32) } }], now);
  assert.equal(replies.length, count);
  await bot.handleEvents([{ ...postback('other-group', data), source: { ...source, groupId: 'group-b' } }], now);
  assert.match(replyText(replies.at(-1)), /重新查詢/);
  await bot.handleEvents([{ ...postback('direct', data), source: { type: 'user', userId: controller } }], now);
  assert.match(replyText(replies.at(-1)), /重新查詢/);
  const beforeMissingUser = replies.length;
  await bot.handleEvents([{ ...postback('missing-user', data), source: { type: 'group', groupId: 'group-a' } }], now);
  assert.equal(replies.length, beforeMissingUser);
});

test('群組只有設定的管理者能控制，所有成員都能按「知道」', async () => {
  const controller = 'U' + 'a'.repeat(32);
  const family = 'U' + 'b'.repeat(32);
  const { bot, replies, routes } = selectable({ config: { ...config, groupControllerUserId: controller } });
  const group = { type: 'group', groupId: 'group-a', userId: controller };
  await bot.handleEvents([{ ...event('controller-query'), source: group }], now);
  const selectData = replies.at(-1).message.quickReply.items[0].action.data;
  await bot.handleEvents([{ ...postback('controller-select', selectData), source: group }], now);
  const boardData = replies.at(-1).message.quickReply.items[0].action.data;
  const beforeFamily = { replies: replies.length, routes: routes.length };
  for (const [i, text] of ['回程', '1', '已搭上', '沒搭上', '其他路線', '新左營到路竹', '火車 台南 新左營'].entries()) {
    await bot.handleEvents([{ ...event(`family-${i}`, text), source: { ...group, userId: family } }], now);
  }
  await bot.handleEvents([{ ...postback('family-board', boardData), source: { ...group, userId: family } }], now);
  assert.deepEqual({ replies: replies.length, routes: routes.length }, beforeFamily);
  await bot.handleEvents([{ ...postback('controller-board', boardData), source: group }], now);
  assert.deepEqual(replies.at(-1).message.quickReply.items.map(x => x.action.label), ['知道', '去程', '回程', '其他路線']);
  await bot.handleEvents([{ ...postback('family-ack', 'ack:v1'), source: { ...group, userId: family } }], now);
  assert.equal(replies.at(-1).message.type, 'textV2');
  assert.equal(replies.at(-1).message.text, '{acknowledger} 已確認收到');
  assert.deepEqual(replies.at(-1).message.substitution, {
    acknowledger: { type: 'mention', mentionee: { type: 'user', userId: family } },
  });
  assert.equal(replies.at(-1).message.quickReply, undefined);
});

test('列表到期、換日與容量淘汰後要求重查', async () => {
  let clock = 0;
  const selections = new SelectionStore({ clock: () => clock, ttlMs: 100, maxEntries: 1 });
  const { bot, replies } = selectable({ selections });
  await bot.handleEvents([event('list')], now);
  const oldData = replies[0].message.quickReply.items[0].action.data;
  await bot.handleEvents([event('new-list')], now);
  await bot.handleEvents([postback('evicted', oldData)], now);
  assert.match(replyText(replies.at(-1)), /重新查詢/);
  clock = 100;
  await bot.handleEvents([event('expired', '1')], now);
  assert.match(replyText(replies.at(-1)), /重新查詢/);
  await bot.handleEvents([event('again')], now);
  await bot.handleEvents([event('next-day', '1')], new Date('2026-08-29T00:00:00+08:00'));
  assert.match(replyText(replies.at(-1)), /重新查詢/);
  assert.equal(selections.entries.size, 0);
  assert.equal(selections.latest.size, 0);
});

test('LINE 失敗不取代最後已送出的列表', async () => {
  const sent = [];
  const { bot } = selectable({ lineClient: { async reply(token, message) {
    if (token === 'reply-fail') throw new Error('LINE failed');
    sent.push(message);
  } } });
  await bot.handleEvents([event('first')], now);
  await assert.rejects(bot.handleEvents([event('fail', '去程')], now));
  await bot.handleEvents([event('choose', '1')], now);
  assert.match(sent.at(-1).altText ?? sent.at(-1).text, /新左營 → 大湖\n已選擇區間車 1/);
});

test('空列表與 TDX 錯誤清除最新數字對應，不選到上次班次', async () => {
  for (const fail of [false, true]) {
    let calls = 0;
    const { bot, replies } = selectable({ trainService: { async lookup(route) {
      if (++calls === 1) return { ...route, date: '2026-08-28', time: '17:42', trains: [{ number: '1', departure: '18:00', arrival: '18:20', type: '區間車' }] };
      if (fail) throw new Error('test');
      return { ...route, date: '2026-08-28', time: '17:42', trains: [] };
    } } });
    await bot.handleEvents([event('first')], now);
    await bot.handleEvents([event('empty')], now);
    await bot.handleEvents([event('choose', '1')], now);
    assert.match(replyText(replies.at(-1)), /重新查詢/);
  }
});
