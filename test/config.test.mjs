import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.mjs';

const optional = { requireLine: false, requireTdx: false };

test('缺少憑證會立即指出環境變數名稱，不回退到假資料', () => {
  assert.throws(() => readConfig({}), /LINE_CHANNEL_SECRET.*TDX_CLIENT_SECRET/);
});

test('預設兩方向與三班，可設定預留分鐘與車種', () => {
  const userId = 'U' + 'a'.repeat(32);
  const c = readConfig({ MIN_LEAD_MINUTES: '5', TRAIN_TYPE_CODES: '6,10', GROUP_CONTROLLER_USER_ID: userId }, optional);
  assert.deepEqual(c.routes.去程, { from: '大湖', to: '新左營' });
  assert.deepEqual(c.routes.回程, { from: '新左營', to: '大湖' });
  assert.equal(c.resultLimit, 3);
  assert.equal(c.minLeadMinutes, 5);
  assert.deepEqual(c.trainTypeCodes, ['6', '10']);
  assert.equal(c.groupControllerUserId, userId);
});

test('拒絕非法埠、班次數、過長 timeout 與非法車種', () => {
  for (const env of [{ PORT: '0' }, { RESULT_LIMIT: '100' }, { MIN_LEAD_MINUTES: '-1' }, { TDX_QUERY_TIMEOUT_MS: '60000' }, { TRAIN_TYPE_CODES: 'local' }, { GROUP_CONTROLLER_USER_ID: 'alice' }]) {
    assert.throws(() => readConfig(env, optional));
  }
});
