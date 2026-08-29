export const defaultCopy = {
  header: '🚆 {from} → {to}',
  listTitle: '最近班次',
  trainRow: '{index} {departure}　{type} {number}',
  noTrains: '今天此時間之後，查無符合條件的班次。',
  now: '現在時間：{time}（台灣時間）',
  queryDate: '查詢日期：{date}',
  listHint: '',
  scheduleNote: '',
  arrival: ['🚆 {from} → {to}', '已選擇{type} {number}', '', '預計於 {departure} 於{from}上車', '【抵達{to}時間約 {etaShort}】'],
  eta: '估計 {etaDate} {eta} 抵達{to}，約 {remaining} 分鐘後。',
  etaPassed: '表訂／估計到達時間已過，無法據此確認實際抵達。',
  live: '目前誤點 {delay} 分鐘；資料更新：{updated}。估計時間以表訂加目前誤點計算，非保證到站時間。',
  liveUnknown: '目前沒有可用的即時資料，暫列表訂時間；不代表準點。',
  missedTitle: '💨 差一點點，這班沒搭上',
  missed: ['{missedTitle}', '下一班約 {departure} 從{from}出發', '【預計於 {etaDisplay} 抵達{to}】'],
  boarded: ['🛤️ 已經上車啦，目前順利{direction}中', '【預計於 {etaDisplay} 抵達{to}】'],
  acknowledged: '知道了 👍',
  missingSelection: '班次列表不存在或已過期。請先傳「去程」或「回程」重新查詢，再選擇班次。',
  invalidIndex: '請選擇 1～{count}，或重新傳「去程／回程」查詢。',
  lookupError: '⚠️ 目前無法取得台鐵時刻資料，請稍後再傳「去程」或「回程」。\n若要立即搭車，請以台鐵官方或車站公告為準。',
  rateLimit: '⚠️ 台鐵資料查詢暫時達到流量限制，請稍後再傳「去程」或「回程」。',
  stationError: '⚠️ 路線的車站設定無法使用，請管理者檢查 .env 的起訖站名稱。',
  help: ['🚆 台鐵通勤小幫手', '去程：{outboundFrom} → {outboundTo}', '回程：{returnFrom} → {returnTo}', '', '完整輸入「去程」或「回程」查詢，再輸入「1」「2」「3」選班次。', '選班後：「已搭上」確認乘車；「沒搭上」查詢下一班。', '已取消誤點追蹤與主動通知。其他聊天文字不會觸發。'],
  buttonOutbound: '去程', buttonReturn: '回程', buttonBoarded: '搭上了', buttonMissed: '沒搭上', buttonAcknowledged: '知道',
};

const variables = new Set(['from', 'to', 'index', 'departure', 'type', 'number', 'departureMinutes', 'arrival', 'arrivalMinutes', 'time', 'date', 'count', 'arrivalDate', 'etaLine', 'liveLine', 'etaDate', 'eta', 'remaining', 'delay', 'updated', 'interval', 'threshold', 'reason', 'outboundFrom', 'outboundTo', 'returnFrom', 'returnTo', 'etaDisplay', 'etaShort', 'direction', 'missedTitle']);

export function validateCopy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('COPY_INVALID');
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(defaultCopy, key)) throw new Error('COPY_UNKNOWN_KEY');
    const text = Array.isArray(item) && item.every(x => typeof x === 'string') ? item.join('\n') : item;
    if (typeof text !== 'string' || !text.trim() && !['listHint', 'scheduleNote'].includes(key) || text.length > (key.startsWith('button') ? 20 : key === 'trainRow' ? 160 : 1000)) throw new Error('COPY_INVALID_TEXT');
    const allowed = new Set([...String(Array.isArray(defaultCopy[key]) ? defaultCopy[key].join('\n') : defaultCopy[key]).matchAll(/\{(\w+)\}/g)].map(x => x[1]));
    for (const match of text.matchAll(/\{(\w+)\}/g)) if (!variables.has(match[1]) || !allowed.has(match[1])) throw new Error('COPY_UNKNOWN_VARIABLE');
  }
  return { ...defaultCopy, ...value };
}

export class StaticCopyBook {
  constructor(value = defaultCopy) { this.value = validateCopy(value); }
  text(key, data = {}) {
    const item = this.value[key];
    const text = Array.isArray(item) ? item.join('\n') : item;
    return text.replace(/\{(\w+)\}/g, (_, name) => stringValue(data[name]));
  }
}

function stringValue(value) { return value === undefined || value === null ? '—' : String(value); }
export const staticCopyBook = new StaticCopyBook();
