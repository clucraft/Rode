import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AisTargetView, ClientMessage, FullState, ServerMessage } from '@rode/protocol';
import { requireRole } from './auth/guard.js';
import type { AppContext } from './context.js';
import { fullState } from './state.js';

/*
 * WebSocket state feed. On connect the client gets a full snapshot; after
 * that only deltas: the watch view when it changed, instrument fields that
 * changed, AIS upserts/removals, and events as they are logged. The cellular
 * link from a dinghy is slow and metered, so nothing is re-sent unchanged and
 * the client picks its own interval (low-bandwidth mode drops to 0.2 Hz).
 */

const MIN_INTERVAL_MS = 500;
const MAX_INTERVAL_MS = 10_000;
const DEFAULT_INTERVAL_MS = 1000;
const LOW_BANDWIDTH_INTERVAL_MS = 5000;

interface Client {
  socket: WebSocket;
  intervalMs: number;
  lowBandwidth: boolean;
  last: FullState | null;
  timer: NodeJS.Timeout | null;
  /** JSON of each AIS target as last sent, by MMSI. */
  aisSent: Map<string, string>;
}

export function websocketRoutes(app: FastifyInstance, ctx: AppContext): void {
  const clients = new Set<Client>();

  const send = (c: Client, msg: ServerMessage) => {
    if (c.socket.readyState !== c.socket.OPEN) return;
    c.socket.send(JSON.stringify(msg));
  };

  const snapshot = (c: Client) => {
    const state = fullState(ctx.state);
    c.last = state;
    c.aisSent = new Map(state.ais.map((t) => [t.mmsi, JSON.stringify(t)]));
    send(c, { type: 'snapshot', state });
  };

  /** Diff against what this client last saw and send only the changes. */
  const flush = (c: Client) => {
    if (!c.last) return snapshot(c);
    const next = fullState(ctx.state);
    const delta: Extract<ServerMessage, { type: 'delta' }> = { type: 'delta' };
    let any = false;

    if (JSON.stringify(next.watch) !== JSON.stringify(c.last.watch)) {
      delta.watch = next.watch;
      any = true;
    }
    if (!c.lowBandwidth || delta.watch) {
      const changed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(next.instruments)) {
        const prev = (c.last.instruments as Record<string, unknown>)[k];
        if (JSON.stringify(v) !== JSON.stringify(prev)) changed[k] = v;
      }
      if (Object.keys(changed).length > 0) {
        delta.instruments = changed;
        any = true;
      }
    }
    if (JSON.stringify(next.source) !== JSON.stringify(c.last.source)) {
      delta.source = next.source;
      any = true;
    }
    if (!c.lowBandwidth) {
      const upsert: AisTargetView[] = [];
      const seen = new Set<string>();
      for (const t of next.ais) {
        seen.add(t.mmsi);
        const json = JSON.stringify(t);
        if (c.aisSent.get(t.mmsi) !== json) {
          upsert.push(t);
          c.aisSent.set(t.mmsi, json);
        }
      }
      const remove = [...c.aisSent.keys()].filter((m) => !seen.has(m));
      for (const m of remove) c.aisSent.delete(m);
      if (upsert.length > 0 || remove.length > 0) {
        delta.ais = {};
        if (upsert.length > 0) delta.ais.upsert = upsert;
        if (remove.length > 0) delta.ais.remove = remove;
        any = true;
      }
    }
    if (
      next.time.gpsSynced !== c.last.time.gpsSynced ||
      next.time.lastGpsSyncAt !== c.last.time.lastGpsSyncAt
    ) {
      delta.time = next.time;
      any = true;
    }
    if (
      next.health.unexpectedRestart !== c.last.health.unexpectedRestart ||
      next.health.notificationsLastConfirmedAt !== c.last.health.notificationsLastConfirmedAt ||
      Math.floor(next.health.uptimeMs / 60_000) !== Math.floor(c.last.health.uptimeMs / 60_000)
    ) {
      delta.health = next.health;
      any = true;
    }
    if (JSON.stringify(next.prefs) !== JSON.stringify(c.last.prefs)) {
      delta.prefs = next.prefs;
      any = true;
    }
    c.last = next;
    if (any) send(c, delta);
  };

  const schedule = (c: Client) => {
    if (c.timer) clearInterval(c.timer);
    c.timer = setInterval(() => flush(c), c.intervalMs);
  };

  // Events are pushed the moment they are logged; they are small and matter.
  ctx.bus.on('engine:event', ({ record }) => {
    for (const c of clients) send(c, { type: 'delta', events: [record] });
  });
  ctx.bus.on('log:event', ({ record }) => {
    for (const c of clients) send(c, { type: 'delta', events: [record] });
  });
  // A state transition should not wait for the next interval.
  ctx.bus.on('engine:event', ({ event }) => {
    if (
      event.type === 'state-changed' ||
      event.type === 'condition-raised' ||
      event.type === 'condition-escalated'
    ) {
      for (const c of clients) flush(c);
    }
  });

  // A slider moved on one phone should show on the other without waiting.
  ctx.bus.on('settings:changed', ({ keys }) => {
    if (keys.includes('prefs')) for (const c of clients) flush(c);
  });

  app.get('/ws', { websocket: true, preHandler: requireRole('crew') }, (socket) => {
    const c: Client = {
      socket,
      intervalMs: DEFAULT_INTERVAL_MS,
      lowBandwidth: false,
      last: null,
      timer: null,
      aisSent: new Map(),
    };
    clients.add(c);
    send(c, {
      type: 'hello',
      serverTime: ctx.now(),
      version: ctx.version,
      intervalMs: c.intervalMs,
    });
    snapshot(c);
    schedule(c);

    socket.on('message', (raw: Buffer | string) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === 'ping') {
        send(c, { type: 'pong', t: msg.t, serverTime: ctx.now() });
      } else {
        c.lowBandwidth = msg.lowBandwidth ?? false;
        const wanted =
          msg.intervalMs ?? (c.lowBandwidth ? LOW_BANDWIDTH_INTERVAL_MS : DEFAULT_INTERVAL_MS);
        c.intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, wanted));
        schedule(c);
        send(c, {
          type: 'hello',
          serverTime: ctx.now(),
          version: ctx.version,
          intervalMs: c.intervalMs,
        });
      }
    });
    const close = () => {
      if (c.timer) clearInterval(c.timer);
      c.timer = null;
      clients.delete(c);
    };
    socket.on('close', close);
    socket.on('error', close);
  });

  app.addHook('onClose', () => {
    for (const c of clients) {
      if (c.timer) clearInterval(c.timer);
      c.socket.close();
    }
    clients.clear();
  });
}
