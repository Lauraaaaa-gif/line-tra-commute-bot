import { staticCopyBook } from './copy-core.mjs';
import { taipeiTime } from './trains.mjs';
import { scheduledView, trainTimes } from './realtime.mjs';

export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const command = text.normalize('NFKC').trim();
  if (command === '取消追蹤') return '停止追蹤';
  return ['去程', '回程', '其他路線', '說明', '已搭上', '搭上了', '沒搭上', '停止追蹤'].includes(command) ? command : null;
}

// 僅接受完整格式，站名保留到 TDX 正規化，以便顯示原始輸入的錯誤站名。
export function parseRouteQuery(text) {
  if (typeof text !== 'string' || text.length > 100) return null;
  const value = text.normalize('NFKC').trim();
  const match = /^火車[ \t]+(\p{Script=Han}{1,30})[ \t]+(\p{Script=Han}{1,30})$/u.exec(value)
    || /^(\p{Script=Han}{1,30}?)[ \t]*到[ \t]*(\p{Script=Han}{1,30})$/u.exec(value);
  return match ? { from: match[1], to: match[2] } : null;
}

export function parseAcknowledgement(data) {
  return data === 'ack:v1';
}

// LINE 的 mention 只可用在群組／多人聊天室；私訊則使用不含標記的同一文案。
export function acknowledgementMessage(source, copy = staticCopyBook, trip = null) {
  const text = copy.text('acknowledged');
  const controls = trip ? { quickReply: { items: [postback(copy.text('buttonCancelTracking'), `trip:stop:${trip.id}`)] } } : {};
  if (!['group', 'room'].includes(source?.type) || typeof source.userId !== 'string' || !source.userId) {
    return { type: 'text', text, ...controls };
  }
  return {
    type: 'textV2',
    text: `{acknowledger} ${text}`,
    substitution: {
      acknowledger: { type: 'mention', mentionee: { type: 'user', userId: source.userId } },
    },
    ...controls,
  };
}

export function helpText(routes, copy = staticCopyBook) {
  return copy.text('help', { outboundFrom: routes.去程.from, outboundTo: routes.去程.to, returnFrom: routes.回程.from, returnTo: routes.回程.to });
}

export function timetableText(result, instant = new Date(`${result.date}T${result.time}:00+08:00`), copy = staticCopyBook) {
  const current = taipeiTime(instant);
  const numbers = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
  const lines = [copy.text('header', result), '', copy.text('listTitle')];
  for (const [i, train] of result.trains.entries()) {
    const times = trainTimes(result, train);
    lines.push(copy.text('trainRow', { ...result, ...train, index: numbers[i],
      departureMinutes: Math.max(0, Math.ceil((times.departureAt - instant) / 60000)),
      arrivalMinutes: Math.max(0, Math.ceil((times.arrivalAt - instant) / 60000)),
    }));
  }
  if (!result.trains.length) lines.push(copy.text(result.customRoute ? 'noRouteTrains' : 'noTrains', result));
  lines.push('', copy.text('queryDate', result), copy.text('now', current));
  const note = copy.text('scheduleNote');
  if (note) lines.push(note);
  if (result.leadMinutes) lines.push(`已預留 ${result.leadMinutes} 分鐘到站時間`);
  if (result.filtered) lines.push('已套用指定車種篩選');
  return lines.join('\n');
}

export function errorText(error, copy = staticCopyBook) {
  if (error.code === 'SAME_STATION') return copy.text('sameStation');
  if (error.code === 'STATION_NOT_FOUND' && error.stationName) {
    return copy.text('unknownStation', { station: error.stationName });
  }
  return copy.text(['STATION_NOT_FOUND', 'SAME_STATION'].includes(error.code) ? 'stationError'
    : error.status === 429 ? 'rateLimit' : 'lookupError');
}

export function tripVariables(result, train, view, instant, copy = staticCopyBook) {
  const eta = taipeiTime(new Date(view.etaAt));
  const data = { ...result, ...train, ...taipeiTime(instant),
    date: result.date, arrivalDate: taipeiTime(new Date(view.arrivalAt)).date,
    eta: eta.time, etaDate: eta.date, remaining: Math.max(0, Math.ceil((view.etaAt - instant) / 60000)),
    etaDisplay: `${eta.date !== result.date ? eta.date + ' ' : ''}${eta.time}`,
    etaShort: `${eta.date !== result.date ? eta.date + ' ' : ''}${eta.time.replace(/^0/, '')}`,
    delay: view.delay, updated: view.updatedAt ? taipeiTime(new Date(view.updatedAt)).time : '—',
  };
  data.etaLine = view.etaAt > instant ? copy.text('eta', data) : copy.text('etaPassed');
  data.liveLine = view.known ? copy.text('live', data) : copy.text('liveUnknown');
  return data;
}

export function arrivalText(result, train, instant = new Date(`${result.date}T${result.time || '00:00'}:00+08:00`), view = scheduledView(result, train), copy = staticCopyBook) {
  return copy.text('arrival', tripVariables(result, train, view, instant, copy));
}

const postback = (label, data) => ({ type: 'action', action: { type: 'postback', label, data, displayText: label } });
export function textMessage(text, entry = null, { trip = null, stage = trip ? 'selected' : 'start', bare = false, copy = staticCopyBook } = {}) {
  if (bare) return { type: 'text', text: text.slice(0, 5000) };
  const routes = [['buttonOutbound', '去程'], ['buttonReturn', '回程'], ['buttonOtherRoutes', '其他路線']].map(([key, command]) => ({
    type: 'action', action: { type: 'message', label: copy.text(key), text: command },
  }));
  const ack = postback(copy.text('buttonAcknowledged'), 'ack:v1');
  const stop = trip ? postback(copy.text('buttonStopTracking'), `trip:stop:${trip.id}`)
    : { type: 'action', action: { type: 'message', label: copy.text('buttonStopTracking'), text: '停止追蹤' } };
  let buttons;
  if (stage === 'selected' && trip) buttons = [ack,
    postback(copy.text('buttonBoarded'), `trip:board:${trip.id}`),
    postback(copy.text('buttonMissed'), `trip:miss:${trip.id}`), stop];
  else if (stage === 'boarded' || stage === 'notification') buttons = [ack, stop];
  else if (stage === 'missed') buttons = [ack, ...routes, stop];
  else buttons = [...(entry ? entry.result.trains.map((_, i) => postback(String(i + 1), `arrival:${entry.id}:${i + 1}`)) : []), ...routes];
  const quickReply = { items: buttons };
  return { type: 'text', text: text.slice(0, 5000), quickReply };
}
