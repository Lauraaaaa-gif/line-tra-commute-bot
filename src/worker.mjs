import wording from '../copy.zh-TW.json' with { type: 'json' };
import { readConfig } from './config.mjs';
import { TdxClient } from './tdx.mjs';
import { TrainService } from './trains.mjs';
import { LineClient, verifySignature } from './line.mjs';
import { createBot, EventDeduplicator } from './bot.mjs';
import { SelectionStore } from './selections.mjs';
import { JourneyChoices } from './journeys.mjs';
import { RealtimeService } from './realtime.mjs';
import { StaticCopyBook } from './copy-core.mjs';
import { safeError } from './errors.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const copy = new StaticCopyBook(wording);

function json(body, status = 200) {
  return Response.json(body, { status, headers: {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}

function validEvents(body) {
  return body && Array.isArray(body.events) && body.events.length <= 100
    && body.events.every(event => event && typeof event === 'object' && !Array.isArray(event));
}

function conversation(source) {
  if (source?.type === 'user' && typeof source.userId === 'string') return `user:${source.userId}`;
  if (source?.type === 'group' && typeof source.groupId === 'string') return `group:${source.groupId}`;
  if (source?.type === 'room' && typeof source.roomId === 'string') return `room:${source.roomId}`;
  return null;
}

async function opaqueName(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function dispatch(event, receivedAt, env) {
  const key = conversation(event.source);
  if (!key) return;
  const id = env.BOT_STATE.idFromName(await opaqueName(key));
  const response = await env.BOT_STATE.get(id).fetch('https://bot-state.internal/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, receivedAt: receivedAt.toISOString() }),
  });
  if (!response.ok) throw new Error('BOT_STATE_FAILED');
}

export function createWorker() {
  return {
    async fetch(request, env) {
      const receivedAt = new Date();
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'line-tra-bot-worker' });
      if (url.pathname !== '/webhook') return json({ error: 'NOT_FOUND' }, 404);
      if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return json({ error: 'JSON_REQUIRED' }, 415);
      const encoding = request.headers.get('content-encoding');
      if (encoding && encoding !== 'identity') return json({ error: 'ENCODING_NOT_SUPPORTED' }, 415);
      const declared = Number(request.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json({ error: 'BODY_TOO_LARGE' }, 413);
      try {
        const raw = Buffer.from(await request.arrayBuffer());
        if (raw.length > MAX_BODY_BYTES) return json({ error: 'BODY_TOO_LARGE' }, 413);
        if (!verifySignature(raw, request.headers.get('x-line-signature'), env.LINE_CHANNEL_SECRET)) {
          return json({ error: 'INVALID_SIGNATURE' }, 401);
        }
        let body;
        try { body = JSON.parse(raw.toString('utf8')); } catch { return json({ error: 'INVALID_JSON' }, 400); }
        if (!validEvents(body)) return json({ error: 'INVALID_EVENTS' }, 400);
        await Promise.all(body.events.map(event => dispatch(event, receivedAt, env)));
        return json({ ok: true });
      } catch (error) {
        console.error('worker_webhook_failed', safeError(error));
        return json({ error: 'WEBHOOK_FAILED' }, 502);
      }
    },
  };
}

export default createWorker();

export class BotState {
  constructor(state, env, { fetchImpl = fetch, clock = Date.now } = {}) {
    this.state = state;
    this.env = env;
    this.tail = Promise.resolve();
    this.ready = state.blockConcurrencyWhile(async () => {
      const config = readConfig(env);
      const selections = new SelectionStore({ clock });
      const dedupe = new EventDeduplicator({ clock });
      const tdx = new TdxClient({ clientId: config.tdxClientId, clientSecret: config.tdxClientSecret,
        cacheMs: config.timetableCacheMs, fetchImpl, clock });
      const realtime = new RealtimeService(tdx, { clock });
      const journeys = new JourneyChoices({ selections, realtime, clock });
      const snapshot = await state.storage.get('snapshot');
      if (snapshot?.version === 1) {
        selections.restore(snapshot.selections);
        journeys.restore(snapshot.journeys);
        dedupe.restore(snapshot.dedupe);
      }
      this.runtime = {
        selections, journeys, dedupe,
        bot: createBot({
          config,
          selections,
          journeys,
          dedupe,
          realtime,
          copy,
          trainService: new TrainService(tdx, config),
          lineClient: new LineClient({ accessToken: config.lineAccessToken, timeoutMs: config.lineTimeoutMs, fetchImpl }),
        }),
      };
    });
  }

  fetch(request) {
    const work = this.tail.catch(() => {}).then(async () => {
      await this.ready;
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/event') return json({ error: 'NOT_FOUND' }, 404);
      let value;
      try { value = await request.json(); } catch { return json({ error: 'INVALID_JSON' }, 400); }
      const instant = new Date(value?.receivedAt);
      if (!value?.event || !Number.isFinite(instant.getTime())) return json({ error: 'INVALID_EVENT' }, 400);
      try {
        await this.runtime.bot.handleEvents([value.event], instant);
        await this.state.storage.put('snapshot', {
          version: 1,
          selections: this.runtime.selections.snapshot(),
          journeys: this.runtime.journeys.snapshot(),
          dedupe: this.runtime.dedupe.snapshot(),
        });
        return json({ ok: true });
      } catch (error) {
        console.error('bot_state_failed', safeError(error));
        return json({ error: 'BOT_STATE_FAILED' }, 502);
      }
    });
    this.tail = work.then(() => {}, () => {});
    return work;
  }
}
