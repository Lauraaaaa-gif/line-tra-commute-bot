import test from 'node:test';
import assert from 'node:assert/strict';
import { taipeiTime, parseTime, upcomingTrains, TrainService } from '../src/trains.mjs';
import { arrivalText, timetableText, parseCommand, textMessage } from '../src/messages.mjs';
import { readConfig } from '../src/config.mjs';
import { train, sampleTrains } from '../fixtures/sample.mjs';

const now = new Date('2026-08-28T17:42:00+08:00');
const upcoming = (rows, options) => upcomingTrains(rows, '4340', '4290', now, options);

test('台灣時間與 UTC 主機一致，午夜日期正確', () => {
  assert.deepEqual(taipeiTime(new Date('2026-08-28T16:00:00Z')), { date: '2026-08-29', time: '00:00', seconds: 0 });
  assert.equal(taipeiTime(new Date('2026-08-28T15:59:59Z')).date, '2026-08-28');
});

test('時間解析支援秒與延長營運時間，拒絕無效值', () => {
  assert.equal(parseTime('17:42'), 63720);
  assert.equal(parseTime('24:10:00'), 87000);
  for (const value of ['7:00', '17:60', '99:00', '48:00', null, '', 'today']) assert.equal(parseTime(value), null);
});

test('17:42 回程，先依時間排序再取三班，也可指定四班', () => {
  assert.deepEqual(upcoming(sampleTrains()).map(x => x.number), ['3238', '3242', '3018']);
  assert.deepEqual(upcoming(sampleTrains(), { limit: 4 }).map(x => x.number), ['3238', '3242', '3018', '3246']);
});

test('嚴格排除已發車、正好現在與同分鐘已過秒數', () => {
  assert.equal(upcoming([train('1', '17:42')]).length, 0);
  const result = upcomingTrains([train('1', '17:42:10'), train('2', '17:42:31')], '4340', '4290', new Date('2026-08-28T17:42:30+08:00'));
  assert.deepEqual(result.map(x => x.number), ['2']);
});

test('以離站時間判斷，不把到站時間誤當離站時間', () => {
  const row = train('1', '17:45');
  row.StopTimes[0].ArrivalTime = '17:40';
  assert.equal(upcoming([row]).length, 1);
  row.StopTimes[0].DepartureTime = null;
  assert.equal(upcoming([row]).length, 0);
});

test('停駛、部分停駛、端點停駛、郵輪與專列全部排除', () => {
  const rows = [
    train('1', '18:00', { suspended: 1 }), train('2', '18:00', { suspended: 2 }),
    train('3', '18:00', { fromSuspended: 1 }), train('4', '18:00', { toSuspended: 1 }),
    train('5', '18:00', { serviceType: 3 }), train('6', '18:00', { serviceType: 4 }),
  ];
  assert.equal(upcoming(rows).length, 0);
});

test('反向列車不回傳；必須先停起站再停迄站', () => {
  const row = train('1', '18:00');
  row.StopTimes[0].StopSequence = 3;
  assert.equal(upcoming([row]).length, 0);
});

test('車種篩選、預留時間與去重', () => {
  assert.equal(upcoming(sampleTrains(), { typeCodes: ['10'] })[0].number, '3018');
  assert.equal(upcoming(sampleTrains(), { leadMinutes: 10 })[0].number, '3242');
  assert.equal(upcoming([train('1', '18:00'), train('1', '18:00')]).length, 1);
});

test('末班車後不混入明天 24:xx 班次，跨日到站仍可搭', () => {
  const late = new Date('2026-08-28T23:58:00+08:00');
  const result = upcomingTrains([train('1', '24:10'), train('2', '23:59', { arrival: '00:08' })], '4340', '4290', late);
  assert.deepEqual(result.map(x => x.number), ['2']);
});

test('欄位格式改變明確報錯，不能假裝查無班次', () => {
  assert.throws(() => upcoming([{}]), /TDX_INVALID_DATA/);
  assert.throws(() => upcoming([train('1', '18:00', { to: '1000' })]), /TDX_INVALID_DATA/);
});

test('精簡列表包含班次、當日日期、台灣時間，不加入額外文案', () => {
  const text = timetableText({ from: '新左營', to: '大湖', date: '2026-08-28', time: '17:42', trains: upcoming(sampleTrains()) });
  assert.match(text, /① 17:48　區間車 3238/);
  assert.match(text, /③ 18:16　區間快 3018/);
  assert.match(text, /2026-08-28/);
  assert.doesNotMatch(text, /分鐘後|請點|未計入/);
  const empty = timetableText({ from: '新左營', to: '大湖', date: '2026-08-28', time: '23:59', trains: [] });
  assert.match(empty, /查無符合條件/);
});

test('僅完整指令，去除首尾空白，不接受別名或模糊比對', () => {
  assert.equal(parseCommand('　回程 \n'), '回程');
  assert.equal(parseCommand('返程'), null);
  assert.equal(parseCommand('HELP'), null);
  assert.equal(parseCommand('我已經上車了'), null);
  assert.equal(parseCommand('已搭上'), '已搭上');
  assert.equal(parseCommand('明天回程'), null);
  assert.equal(parseCommand(null), null);
  assert.deepEqual(textMessage('test').quickReply.items.map(x => x.action.label), ['去程', '回程']);
});

test('目的站到站時間與跨日日期，不以目的站離站時間代替', () => {
  for (const arrival of ['00:08', '24:08']) {
    const row = train('2', '23:59', { arrival });
    row.StopTimes[1].DepartureTime = '00:10';
    const [selected] = upcoming([row]);
    const text = arrivalText({ from: '新左營', to: '大湖', date: '2026-08-31' }, selected);
    assert.match(text, /【抵達大湖時間約 2026-09-01 0:08】/);
    assert.doesNotMatch(text, /00:10/);
    assert.match(text, /已選擇區間車 2/);
  }
});

test('最多十班按鈕加去回程，共十二個；不包含說明按鈕', () => {
  const message = textMessage('test', { id: 'abcdefghijklmnop', result: { trains: Array(10).fill({}) } });
  assert.equal(message.quickReply.items.length, 12);
  assert.equal(message.quickReply.items[9].action.data, 'arrival:abcdefghijklmnop:10');
  assert.equal(message.quickReply.items[0].action.label, '1');
  assert.ok(message.quickReply.items.every(x => x.action.label !== '說明'));
});

test('TrainService 用同一次收到的時間，不重新讀主機時鐘', async () => {
  const calls = [];
  const tdx = {
    async resolveStations() { return { from: { id: '4340', name: '新左營' }, to: { id: '4290', name: '大湖' } }; },
    async getTimetable(from, to, date) { calls.push([from, to, date]); return { trains: sampleTrains() }; },
  };
  const config = readConfig({}, { requireLine: false, requireTdx: false });
  const result = await new TrainService(tdx, config).lookup(config.routes.回程, now);
  assert.deepEqual(calls[0], ['4340', '4290', '2026-08-28']);
  assert.equal(result.time, '17:42');
  assert.equal(result.trains.length, 3);
  const next = await new TrainService(tdx, config).lookup(config.routes.回程, now, { exclude: { number: '3238', departure: '17:48' } });
  assert.deepEqual(next.trains.map(x => x.number), ['3242', '3018', '3246']);
  const afterThird = await new TrainService(tdx, config).lookup(config.routes.回程, now, { exclude: { number: '3018', departure: '18:16' } });
  assert.deepEqual(afterThird.trains.map(x => x.number), ['3246', '3250']);
});
