import { copyBook } from './copy.mjs';
import { taipeiTime } from './trains.mjs';
import { scheduledView, trainTimes } from './realtime.mjs';

export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const command = text.normalize('NFKC').trim();
  return ['去程', '回程', '說明', '已搭上', '沒搭上'].includes(command) ? command : null;
}

export function helpText(routes, copy = copyBook) {
  return copy.text('help', { outboundFrom: routes.去程.from, outboundTo: routes.去程.to, returnFrom: routes.回程.from, returnTo: routes.回程.to });
}

export function timetableText(result, instant = new Date(`${result.date}T${result.time}:00+08:00`), copy = copyBook) {
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
  if (!result.trains.length) lines.push(copy.text('noTrains'));
  lines.push('', copy.text('queryDate', result), copy.text('now', current));
  const note = copy.text('scheduleNote');
  if (note) lines.push(note);
  if (result.leadMinutes) lines.push(`已預留 ${result.leadMinutes} 分鐘到站時間`);
  if (result.filtered) lines.push('已套用指定車種篩選');
  return lines.join('\n');
}

export function errorText(error, copy = copyBook) {
  return copy.text(['STATION_NOT_FOUND', 'SAME_STATION'].includes(error.code) ? 'stationError'
    : error.status === 429 ? 'rateLimit' : 'lookupError');
}

export function tripVariables(result, train, view, instant, copy = copyBook) {
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

export function arrivalText(result, train, instant = new Date(`${result.date}T${result.time || '00:00'}:00+08:00`), view = scheduledView(result, train), copy = copyBook) {
  return copy.text('arrival', tripVariables(result, train, view, instant, copy));
}

const postback = (label, data) => ({ type: 'action', action: { type: 'postback', label, data, displayText: label } });
export function textMessage(text, entry = null, { trip = null, copy = copyBook } = {}) {
  let buttons = entry ? entry.result.trains.map((_, i) => postback(String(i + 1), `arrival:${entry.id}:${i + 1}`)) : [];
  if (trip) buttons = [
    postback(copy.text('buttonBoarded'), `trip:board:${trip.id}`),
    postback(copy.text('buttonMissed'), `trip:miss:${trip.id}`),
  ];
  buttons.push(...[['buttonOutbound', '去程'], ['buttonReturn', '回程']].map(([key, command]) => ({
    type: 'action', action: { type: 'message', label: copy.text(key), text: command },
  })));
  return { type: 'text', text: text.slice(0, 5000), quickReply: { items: buttons } };
}
