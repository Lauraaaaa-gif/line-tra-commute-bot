import { createHmac, randomBytes } from 'node:crypto';
import { taipeiTime } from './trains.mjs';

// 單一行程、短期記憶體快取。識別碼只保留每次啟動重新加鹽的摘要。
export class SelectionStore {
  constructor({ clock = Date.now, ttlMs = 30 * 60000, maxEntries = 1000 } = {}) {
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.salt = randomBytes(32);
    this.entries = new Map();
    this.latest = new Map();
  }

  owner(source) {
    if (!source?.userId || !['user', 'group', 'room'].includes(source.type)) return null;
    const conversation = source.type === 'user' ? source.userId : source[`${source.type}Id`];
    if (!conversation) return null;
    return createHmac('sha256', this.salt).update(JSON.stringify([source.type, conversation, source.userId])).digest('hex');
  }

  drop(id) {
    this.entries.delete(id);
    for (const [key, value] of this.latest) if (value === id) this.latest.delete(key);
  }

  prune(instant) {
    const date = taipeiTime(instant).date;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= this.clock() || entry.result.date !== date) this.drop(id);
    }
  }

  prepare(source, command, result) {
    const owner = this.owner(source);
    if (!owner || !result.trains.length) return null;
    return { id: randomBytes(12).toString('base64url'), owner, command, result: structuredClone(result) };
  }

  // 只有 LINE 成功送出列表後才更新數字選擇的對應。
  commit(entry, source, command, instant) {
    this.prune(instant);
    const owner = this.owner(source);
    if (!owner) return;
    this.latest.delete(`${owner}:*`);
    this.latest.delete(`${owner}:${command}`);
    if (!entry) return;
    while (this.entries.size >= this.maxEntries) this.drop(this.entries.keys().next().value);
    this.entries.set(entry.id, { ...entry, expiresAt: this.clock() + this.ttlMs });
    this.latest.set(`${owner}:*`, entry.id);
    this.latest.set(`${owner}:${command}`, entry.id);
  }

  select(source, selection, instant) {
    this.prune(instant);
    const owner = this.owner(source);
    const id = selection.id ?? this.latest.get(`${owner}:${selection.command || '*'}`);
    const entry = this.entries.get(id);
    if (!owner || !entry || entry.owner !== owner) return { error: 'missing' };
    if (!Number.isInteger(selection.index) || selection.index < 1 || selection.index > entry.result.trains.length) {
      return { error: 'range', entry };
    }
    return { entry, train: entry.result.trains[selection.index - 1] };
  }

  snapshot() {
    this.prune(new Date(this.clock()));
    return {
      version: 1,
      salt: this.salt.toString('base64'),
      entries: [...this.entries],
      latest: [...this.latest],
    };
  }

  restore(value) {
    if (!value || value.version !== 1 || typeof value.salt !== 'string' || !Array.isArray(value.entries) || !Array.isArray(value.latest)) return false;
    const salt = Buffer.from(value.salt, 'base64');
    if (salt.length !== 32) return false;
    const entries = new Map(value.entries.filter(x => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string'
      && x[1] && Number.isFinite(x[1].expiresAt) && x[1].expiresAt > this.clock()).slice(-this.maxEntries));
    const latest = new Map(value.latest.filter(x => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string'
      && typeof x[1] === 'string' && entries.has(x[1])));
    this.salt = salt;
    this.entries = entries;
    this.latest = latest;
    return true;
  }
}

export function parseSelection(text) {
  if (typeof text !== 'string') return null;
  const match = /^([1-9]|10)$/.exec(text.normalize('NFKC').trim());
  return match ? { index: Number(match[1]) } : null;
}

export function parseArrivalPostback(data) {
  if (typeof data !== 'string' || !data.startsWith('arrival:')) return null;
  const match = /^arrival:([A-Za-z0-9_-]{16}):(\d{1,2})$/.exec(data);
  return match ? { id: match[1], index: Number(match[2]) } : null;
}
