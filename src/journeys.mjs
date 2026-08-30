import { randomBytes } from 'node:crypto';
import { scheduledView } from './realtime.mjs';

export function parseTripAction(data) {
  if (typeof data !== 'string') return null;
  const m = /^trip:(board|miss|stop):([A-Za-z0-9_-]{16})$/.exec(data);
  return m ? { action: m[1], id: m[2] } : null;
}

export class JourneyChoices {
  // No timer, push recipient or background network requests.
  constructor({ selections, realtime, clock = Date.now } = {}) {
    Object.assign(this, { selections, realtime, clock });
    this.choices = new Map();
  }
  async view(result, train, instant) {
    return this.realtime ? this.realtime.view(result, train, instant) : scheduledView(result, train);
  }
  prepare(source, entry, train, view) {
    return { id: randomBytes(12).toString('base64url'), owner: this.selections.owner(source),
      command: entry.command, result: entry.result, train, view, expiresAt: view.etaAt };
  }
  remember(trip) {
    this.pruneChoices();
    this.choices.set(trip.owner, trip);
    while (this.choices.size > 1000) this.choices.delete(this.choices.keys().next().value);
  }
  pruneChoices(preserveOwners = new Set()) { for (const [owner, trip] of this.choices) if (trip.expiresAt <= this.clock() && !preserveOwners.has(owner)) this.choices.delete(owner); }
  choice(source, id) {
    this.pruneChoices();
    const owner = this.selections.owner(source);
    const trip = this.choices.get(owner);
    return trip && (!id || trip.id === id) ? trip : null;
  }
  clearChoice(source) { this.choices.delete(this.selections.owner(source)); }
  forget(source, id) {
    const trip = this.choice(source, id);
    if (trip) this.choices.delete(trip.owner);
    return trip;
  }
  snapshot(preserveOwners) {
    this.pruneChoices(preserveOwners);
    return { version: 1, choices: [...this.choices] };
  }
  restore(value, preserveOwners = new Set()) {
    if (!value || value.version !== 1 || !Array.isArray(value.choices)) return false;
    this.choices = new Map(value.choices.filter(x => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string'
      && x[1] && Number.isFinite(x[1].expiresAt) && (x[1].expiresAt > this.clock() || preserveOwners.has(x[0]))).slice(-1000));
    return true;
  }
  close() { this.choices.clear(); }
}
