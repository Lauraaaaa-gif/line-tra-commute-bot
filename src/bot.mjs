import { acknowledgementMessage, arrivalText, errorText, helpText, parseAcknowledgement, parseCommand, parseRouteQuery, textMessage, timetableText, tripVariables } from './messages.mjs';
import { SelectionStore, parseSelection, parseArrivalPostback } from './selections.mjs';
import { JourneyChoices, parseTripAction } from './journeys.mjs';
import { staticCopyBook } from './copy-core.mjs';
import { safeError, ServiceError } from './errors.mjs';

// 小型單一行程版本：同時處理中的事件共用 Promise，成功後保留 24h。
// 不儲存使用者訊息／身分；重啟會失去去重記錄。多實例請換成共享儲存。
export class EventDeduplicator {
  constructor({ clock = Date.now, ttlMs = 86400000, maxEntries = 10000 } = {}) {
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  run(id, work) {
    for (const [key, entry] of this.entries) {
      if (entry.done && entry.expiresAt <= this.clock()) this.entries.delete(key);
    }
    if (this.entries.has(id)) return this.entries.get(id).promise;
    // 不任意刪除仍有效的去重紀錄；滿載時回 503 讓 LINE 稍後重送。
    if (this.entries.size >= this.maxEntries) return Promise.reject(new ServiceError('BOT_BUSY'));
    const entry = { done: false, expiresAt: Infinity, promise: null };
    entry.promise = Promise.resolve().then(work).then(() => {
      entry.done = true;
      entry.expiresAt = this.clock() + this.ttlMs;
    }, error => {
      this.entries.delete(id);
      throw error;
    });
    this.entries.set(id, entry);
    return entry.promise;
  }

  snapshot() {
    const now = this.clock();
    return { version: 1, entries: [...this.entries].filter(([, entry]) => entry.done && entry.expiresAt > now)
      .slice(-this.maxEntries).map(([id, entry]) => [id, entry.expiresAt]) };
  }

  restore(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.entries)) return false;
    const now = this.clock();
    this.entries = new Map(value.entries.filter(x => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string'
      && Number.isFinite(x[1]) && x[1] > now).slice(-this.maxEntries)
      .map(([id, expiresAt]) => [id, { done: true, expiresAt, promise: Promise.resolve() }]));
    return true;
  }
}

export function createBot({ config, trainService, lineClient, logger = console, dedupe = new EventDeduplicator(), selections = new SelectionStore(), realtime, copy = staticCopyBook, journeys: injectedJourneys }) {
  let active = 0;
  const journeys = injectedJourneys || new JourneyChoices({ selections, realtime });
  const queues = new Map();
  const serial = (owner, work) => {
    if (!owner) return work();
    const queue = queues.get(owner) || { tail: Promise.resolve(), count: 0 };
    if (queue.count >= 8) throw new ServiceError('BOT_BUSY');
    queue.count++;
    const promise = queue.tail.catch(() => {}).then(work).finally(() => {
      if (--queue.count === 0) queues.delete(owner);
    });
    queue.tail = promise;
    queues.set(owner, queue);
    return promise;
  };

  async function processEvent(event, receivedAt) {
    if (event.mode === 'standby') return;
    const owner = selections.owner(event.source);
    if (event.type === 'unfollow') return serial(owner, () => journeys.forget(event.source));
    if (typeof event.replyToken !== 'string' || !event.replyToken) return;
    const isText = event.type === 'message' && event.message?.type === 'text';
    const selection = isText ? parseSelection(event.message.text)
      : event.type === 'postback' ? parseArrivalPostback(event.postback?.data) : null;
    const tripAction = event.type === 'postback' ? parseTripAction(event.postback?.data) : null;
    const acknowledged = event.type === 'postback' && parseAcknowledgement(event.postback?.data);
    const command = isText ? parseCommand(event.message.text) : null;
    const routeQuery = isText && !command && !selection ? parseRouteQuery(event.message.text) : null;
    const groupChat = event.source?.type === 'group' || event.source?.type === 'room';
    const groupController = !groupChat || Boolean(config.groupControllerUserId) && event.source?.userId === config.groupControllerUserId;
    // 所有聊天室都只接受完整指令，不因關鍵字、閒聊或加入好友觸發。
    if (!acknowledged && (!groupController || !command && !selection && !tripAction && !routeQuery)) {
      // 僅記錄判斷結果，絕不寫出訊息內容、User ID、聊天室 ID 或 replyToken。
      logger.log('event_ignored', {
        reason: !groupController ? 'GROUP_NOT_CONTROLLER' : 'UNRECOGNIZED_INPUT',
        sourceType: event.source?.type || 'unknown',
        recognized: Boolean(command || selection || tripAction || routeQuery),
      });
      return;
    }
    const id = event.webhookEventId || event.message?.id;
    if (typeof id !== 'string' || !id) throw new ServiceError('INVALID_EVENT');
    return dedupe.run(id, () => serial(owner, async () => {
      if (active >= 8) throw new ServiceError('BOT_BUSY');
      active++;
      try {
        let text;
        let entry = null;
        let trip = null;
        let acknowledge = false;
        let bare = false;
        let message = null;
        let emphasizeLastLine = false;
        let afterReply = () => {};
        const lookup = async (direction, missed = false, exclude = null, route = config.routes[direction]) => {
          const prefix = missed ? copy.text('missedTitle') + '\n' : '';
          try {
            const result = { ...await trainService.lookup(route, receivedAt, { exclude }) };
            if (!Object.hasOwn(config.routes, direction)) result.customRoute = true;
            // 沒搭上只顯示下一班，數字與乘車按鈕也只對應這一班。
            const displayed = missed ? { ...result, trains: result.trains.slice(0, 1) } : result;
            entry = selections.prepare(event.source, direction, displayed);
            if (missed && displayed.trains.length) {
              const next = displayed.trains[0];
              const view = await journeys.view(displayed, next, receivedAt);
              text = copy.text('missed', { ...tripVariables(displayed, next, view, receivedAt, copy), missedTitle: copy.text('missedTitle') });
              emphasizeLastLine = true;
              if (entry) trip = journeys.prepare(event.source, entry, next, view);
            } else if (missed) text = prefix + copy.text(result.customRoute ? 'noRouteTrains' : 'noTrains', result);
            else {
              text = timetableText(result, receivedAt, copy);
              const hint = copy.text('listHint', { count: result.trains.length });
              if (entry && hint) text += '\n\n' + hint;
            }
          } catch (error) {
            logger.error('train_lookup_failed', safeError(error));
            entry = null; trip = null;
            text = prefix + errorText(error, copy);
          }
          afterReply = () => {
            selections.commit(entry, event.source, direction, receivedAt);
            journeys.clearChoice(event.source);
            if (trip) journeys.remember(trip);
          };
        };
        if (acknowledged) {
          text = copy.text('acknowledged');
          message = acknowledgementMessage(event.source, copy);
        } else if (command === '去程' || command === '回程') {
          await lookup(command);
        } else if (command === '其他路線') {
          text = copy.text('otherRoutesHelp');
        } else if (routeQuery) {
          await lookup(`${routeQuery.from} → ${routeQuery.to}`, false, null, routeQuery);
        } else if (selection) {
          const selected = selections.select(event.source, selection, receivedAt);
          entry = selected.entry || null;
          text = selected.error === 'missing'
            ? copy.text('missingSelection')
            : selected.error === 'range'
              ? copy.text('invalidIndex', { count: entry.result.trains.length }) : null;
          if (!selected.error) {
            const view = await journeys.view(entry.result, selected.train, receivedAt);
            trip = journeys.prepare(event.source, entry, selected.train, view);
            text = arrivalText(entry.result, selected.train, receivedAt, view, copy);
            emphasizeLastLine = true;
            afterReply = () => journeys.remember(trip);
          }
        } else if (tripAction?.action === 'board' || command === '已搭上' || command === '搭上了') {
          const boardedTrip = journeys.choice(event.source, tripAction?.id);
          if (!boardedTrip) {
            text = copy.text('missingSelection');
          } else {
            text = copy.text(boardedTrip.result.customRoute ? 'boardedOtherRoute' : 'boarded', {
              ...tripVariables(boardedTrip.result, boardedTrip.train, boardedTrip.view, receivedAt, copy),
              direction: boardedTrip.command,
            });
            acknowledge = true;
            emphasizeLastLine = true;
            trip = null;
            afterReply = () => journeys.forget(event.source, boardedTrip.id);
          }
        } else if (tripAction?.action === 'miss' || command === '沒搭上') {
          trip = journeys.choice(event.source, tripAction?.id);
          if (!trip) {
            text = copy.text('missingSelection');
          } else {
            journeys.forget(event.source, trip.id);
            const missedTrip = trip;
            trip = null;
            await lookup(missedTrip.command, true, { number: missedTrip.train.number, departure: missedTrip.train.departure },
              { from: missedTrip.result.from, to: missedTrip.result.to });
            acknowledge = true;
          }
        } else {
          text = helpText(config.routes, copy);
        }
        // 回覆成功才標記完成；LINE 失敗會回傳非 2xx，供 Webhook redelivery 重試。
        await lineClient.reply(event.replyToken, message || textMessage(text, entry, { trip, acknowledge, bare, emphasizeLastLine, copy }));
        afterReply();
      } finally {
        active--;
      }
    }));
  }

  return {
    close() { journeys.close(); },
    async handleEvents(events, receivedAt) {
      // 同一封 webhook 可以包含多個使用者的事件，不能只處理第一筆。
      const settled = await Promise.allSettled(events.map(event => processEvent(event, receivedAt)));
      const failure = settled.find(x => x.status === 'rejected');
      if (failure) throw failure.reason;
    },
  };
}
