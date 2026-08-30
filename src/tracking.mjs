import { randomUUID } from 'node:crypto';
import { tripVariables, textMessage } from './messages.mjs';
import { staticCopyBook } from './copy-core.mjs';
import { safeError } from './errors.mjs';

const MINUTE = 60000;
const sameTrain = (a, b) => a.result.date === b.result.date && a.train.number === b.train.number
  && a.train.departure === b.train.departure && a.result.from === b.result.from && a.result.to === b.result.to;

// Timers belong to the Durable Object, never an in-memory interval. Only active
// trips retain the destination ID needed for LINE push; it is never logged.
export class DelayTracker {
  constructor({ selections, journeys, lineClient, clock = Date.now, copy = staticCopyBook, logger = console }) {
    Object.assign(this, { selections, journeys, lineClient, clock, copy, logger });
    this.records = new Map();
  }
  current(source, id) {
    const record = this.records.get(this.selections.owner(source));
    return record && (!id || record.trip.id === id) ? record : null;
  }
  start(source, trip) {
    const recipient = source?.type === 'group' ? source.groupId : source?.type === 'room' ? source.roomId
      : source?.type === 'user' ? source.userId : null;
    const previous = this.records.get(trip.owner);
    this.records.delete(trip.owner);
    if (!recipient || !Number.isFinite(trip.view.etaAt) || trip.view.etaAt <= this.clock() || trip.view.reached) return false;
    const reuse = previous && sameTrain(previous.trip, trip);
    // Re-selecting the same active train must not reset delivered thresholds.
    const record = { trip, recipient,
      notified: reuse ? previous.notified : [], pending: reuse ? previous.pending : null,
      endAt: reuse ? Math.max(previous.endAt, trip.view.etaAt) : trip.view.etaAt,
      nextPoll: Math.max(this.clock() + 1000, trip.view.departureAt - 30 * MINUTE) };
    trip.expiresAt = record.endAt;
    this.records.set(trip.owner, record);
    return true;
  }
  stop(source, id) {
    const record = this.current(source, id);
    if (!record) return false;
    this.records.delete(record.trip.owner);
    return true;
  }
  clear() { this.records.clear(); }
  nextAlarm() {
    return this.records.size ? Math.max(this.clock() + 1000,
      Math.min(...[...this.records.values()].map(r => Math.min(r.nextPoll, r.endAt)))) : null;
  }
  snapshot() { return { version: 1, records: [...this.records] }; }
  restore(value) {
    if (value?.version !== 1 || !Array.isArray(value.records)) return;
    this.records = new Map(value.records.filter(([owner, r]) => r?.trip?.owner === owner
      && Number.isFinite(r.endAt) && Number.isFinite(r.nextPoll) && typeof r.recipient === 'string').slice(-1000));
  }
  async poll(persist) {
    for (const [owner, record] of this.records) {
      if (this.clock() < Math.min(record.nextPoll, record.endAt)) continue;
      const { trip } = record;
      // Schedule a retry before I/O. A persisted pending notice always retains
      // the exact body and retry key across errors, restarts and alarm retries.
      record.nextPoll = this.clock() + MINUTE;
      await persist();
      let view;
      try { view = await this.journeys.view(trip.result, trip.train, new Date(this.clock())); }
      catch (error) { this.logger.error('tracking_lookup_failed', safeError(error)); }
      if (view?.known) {
        trip.view = view;
        record.endAt = view.etaAt;
      }
      if (view?.reached || this.clock() >= record.endAt || this.clock() >= trip.view.arrivalAt + 360 * MINUTE) {
        this.records.delete(owner);
        if (this.journeys.choices.get(owner)?.id === trip.id) this.journeys.choices.delete(owner);
        continue;
      }
      const choice = this.journeys.choices.get(owner);
      if (choice?.id === trip.id) { choice.view = trip.view; choice.expiresAt = record.endAt; }
      // Each threshold is independent and strictly greater-than. At most two
      // accepted pushes for one active journey, including a jump past both tiers.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.clock() >= record.endAt) { this.records.delete(owner); break; }
        const tier = view?.known ? [4, 9].find(n => view.delay > n && !record.notified.includes(n)) : undefined;
        if (!record.pending && tier !== undefined) {
          record.pending = { key: randomUUID(), tiers: [tier],
            message: textMessage(this.copy.text('delayNotice', {
              ...tripVariables(trip.result, trip.train, view, new Date(this.clock()), this.copy), threshold: tier,
            }), null, { trip, stage: 'notification', copy: this.copy }) };
        }
        if (!record.pending) break;
        await persist();
        try {
          await this.lineClient.push(record.recipient, record.pending.message, record.pending.key);
          record.notified = [...new Set([...record.notified, ...record.pending.tiers])];
          record.pending = null;
        } catch (error) {
          this.logger.error('tracking_push_failed', safeError(error));
          break;
        }
        await persist();
      }
      await persist();
    }
    await persist();
  }
}
