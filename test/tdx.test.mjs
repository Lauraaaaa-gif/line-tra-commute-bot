import test from 'node:test';
import assert from 'node:assert/strict';
import { TdxClient, normalizeStationName } from '../src/tdx.mjs';
import { sampleTrains, stations, reply } from '../fixtures/sample.mjs';

const client = options => new TdxClient({ clientId: 'test-id', clientSecret: 'test-secret', ...options });
const tokenResponse = () => reply({ access_token: 'mock-token', expires_in: 3600 });
const isToken = url => String(url).includes('/openid-connect/token');

test('client credentials 表單與 token 快取', async () => {
  let requests = 0;
  const tdx = client({ fetchImpl: async (url, init) => {
    assert.ok(isToken(url));
    assert.equal(init.method, 'POST');
    assert.equal(init.body.get('grant_type'), 'client_credentials');
    assert.equal(init.body.get('client_id'), 'test-id');
    assert.equal(init.body.get('client_secret'), 'test-secret');
    requests++;
    return tokenResponse();
  } });
  const values = await Promise.all([tdx.getToken(), tdx.getToken(), tdx.getToken()]);
  assert.deepEqual(values, ['mock-token', 'mock-token', 'mock-token']);
  await tdx.getToken();
  assert.equal(requests, 1);
});

test('token 到期自動更新', async () => {
  let clock = 0;
  let requests = 0;
  const tdx = client({ clock: () => clock, fetchImpl: async () => { requests++; return tokenResponse(); } });
  await tdx.getToken();
  clock = 3600000;
  await tdx.getToken();
  assert.equal(requests, 2);
});

test('TDX 401 僅換一次 token，Bearer header 正確', async () => {
  let tokenCalls = 0;
  let dataCalls = 0;
  const tdx = client({ fetchImpl: async (url, init) => {
    if (isToken(url)) { tokenCalls++; return tokenResponse(); }
    assert.equal(init.headers.Authorization, 'Bearer mock-token');
    dataCalls++;
    return dataCalls === 1 ? reply({}, 401) : reply({ Stations: stations, Count: stations.length });
  } });
  const result = await tdx.resolveStations('新左營', '大湖');
  assert.equal(result.from.id, '4340');
  assert.equal(tokenCalls, 2);
  assert.equal(dataCalls, 2);
});

test('401 第二次仍失敗便停止，429 也不重試', async () => {
  for (const status of [401, 429]) {
    let dataCalls = 0;
    const tdx = client({ fetchImpl: async url => {
      if (isToken(url)) return tokenResponse();
      dataCalls++;
      return reply({ secret: 'never-log-this' }, status);
    } });
    await assert.rejects(tdx.resolveStations('新左營', '大湖'), error => error.status === status && !error.message.includes('never-log-this'));
    assert.equal(dataCalls, status === 401 ? 2 : 1);
  }
});

test('車站 v3 wrapper、車站名正規化、快取與錯誤站名', async () => {
  let dataCalls = 0;
  const tdx = client({ fetchImpl: async url => {
    if (isToken(url)) return tokenResponse();
    dataCalls++;
    return reply({ Stations: stations, Count: stations.length });
  } });
  assert.equal(normalizeStationName(' 台北火車站 '), '臺北');
  assert.equal((await tdx.resolveStations('台北站', '大湖')).from.id, '1000');
  await tdx.resolveStations('大湖', '新左營');
  assert.equal(dataCalls, 1);
  await assert.rejects(tdx.resolveStations('不存在', '大湖'), /STATION_NOT_FOUND/);
  await assert.rejects(tdx.resolveStations('台北', '臺北'), /SAME_STATION/);
});

test('OD 正確 URL、完整分頁；排序不能在 API top=4 時截斷', async () => {
  const rows = sampleTrains();
  const skips = [];
  const tdx = client({ pageSize: 2, fetchImpl: async url => {
    if (isToken(url)) return tokenResponse();
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/api/basic/v3/Rail/TRA/DailyTrainTimetable/OD/4340/to/4290/2026-08-28');
    assert.equal(parsed.searchParams.get('$format'), 'JSON');
    const skip = Number(parsed.searchParams.get('$skip'));
    skips.push(skip);
    return reply({ TrainDate: '2026-08-28', TrainTimetables: rows.slice(skip, skip + 2), Count: rows.length });
  } });
  const result = await tdx.getTimetable('4340', '4290', '2026-08-28');
  assert.equal(result.trains.length, 6);
  assert.deepEqual(skips, [0, 2, 4]);
});

test('無 Count 且服務端限制 top 時，讀到空頁才停止', async () => {
  const tdx = client({ fetchImpl: async url => {
    if (isToken(url)) return tokenResponse();
    const skip = Number(new URL(url).searchParams.get('$skip'));
    return reply({ Stations: stations.slice(skip, skip + 1) });
  } });
  const result = await tdx.resolveStations('台北', '大湖');
  assert.equal(result.from.id, '1000');
});

test('時刻快取按日期與方向區分，到期重新讀取', async () => {
  let clock = 0;
  let dataCalls = 0;
  const tdx = client({ clock: () => clock, cacheMs: 1000, fetchImpl: async url => {
    if (isToken(url)) return tokenResponse();
    dataCalls++;
    const date = new URL(url).pathname.split('/').at(-1);
    return reply({ TrainDate: date, TrainTimetables: [], Count: 0 });
  } });
  await tdx.getTimetable('4340', '4290', '2026-08-28');
  await tdx.getTimetable('4340', '4290', '2026-08-28');
  assert.equal(dataCalls, 1);
  await tdx.getTimetable('4290', '4340', '2026-08-28');
  await tdx.getTimetable('4340', '4290', '2026-08-29');
  assert.equal(dataCalls, 3);
  clock = 1001;
  await tdx.getTimetable('4340', '4290', '2026-08-28');
  assert.equal(dataCalls, 4);
});

test('空班表 null 可處理；缺欄位、錯日期、重複分頁均報錯', async () => {
  const cases = [
    [{ TrainDate: '2026-08-28', TrainTimetables: null }, null],
    [{ TrainDate: '2026-08-28' }, /TDX_INVALID_DATA/],
    [{ TrainDate: '2026-08-27', TrainTimetables: [] }, /TDX_DATE_MISMATCH/],
    [{ TrainDate: '2026-08-28', TrainTimetables: sampleTrains() }, /TDX_PAGINATION_ERROR/],
  ];
  for (const [body, error] of cases) {
    const tdx = client({ fetchImpl: async url => isToken(url) ? tokenResponse() : reply(body) });
    const action = tdx.getTimetable('4340', '4290', '2026-08-28');
    if (error) await assert.rejects(action, error);
    else assert.equal((await action).trains.length, 0);
  }
});

test('錯誤的 token 格式不能快取為有效憑證', async () => {
  const tdx = client({ fetchImpl: async () => reply({ access_token: '', expires_in: 0 }) });
  await assert.rejects(tdx.getToken(), /TDX_INVALID_TOKEN/);
});
