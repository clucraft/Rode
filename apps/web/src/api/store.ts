import { useSyncExternalStore } from 'react';
import type { ClientMessage, EventRecord, FullState, ServerMessage } from '@rode/protocol';

/*
 * The live state store. One WebSocket, a snapshot then deltas, exponential
 * reconnect, and the last-known state cached in localStorage so the app
 * shows *something* (clearly marked stale) when the boat is unreachable.
 *
 * Nothing here computes alarm state. It only mirrors the server.
 */

export type LinkStatus = 'connecting' | 'live' | 'offline';

export interface StoreSnapshot {
  state: FullState | null;
  link: LinkStatus;
  /** Server time offset (serverTime - Date.now()) from the last pong, ms. */
  clockOffsetMs: number;
  /** Wall-clock time of the last message from the server. */
  lastMessageAt: number | null;
  /** Round-trip time from the last ping, ms. */
  rttMs: number | null;
  /** Current subscription settings. */
  intervalMs: number;
  lowBandwidth: boolean;
  /** Events received since page load, newest last, capped. */
  events: EventRecord[];
}

const CACHE_KEY = 'rode:last-state';
const MAX_EVENTS = 200;
const PING_MS = 15_000;
/** No message for this long on an open socket → consider it dead. */
const DEAD_MS = 45_000;

type Listener = () => void;

class StateStore {
  private snapshot: StoreSnapshot = {
    state: loadCache(),
    link: 'connecting',
    clockOffsetMs: 0,
    lastMessageAt: null,
    rttMs: null,
    intervalMs: 1000,
    lowBandwidth: loadPref('rode:low-bandwidth') === '1',
    events: [],
  };
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private watchdog: number | null = null;
  private pingSentAt = 0;
  private started = false;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): StoreSnapshot => this.snapshot;

  private set(patch: Partial<StoreSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
    window.addEventListener('online', () => this.reconnectNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.reconnectNow();
    });
  }

  stop(): void {
    this.started = false;
    this.cleanup();
    this.ws?.close();
    this.ws = null;
  }

  setLowBandwidth(on: boolean): void {
    savePref('rode:low-bandwidth', on ? '1' : '0');
    this.set({ lowBandwidth: on });
    this.send({ type: 'subscribe', lowBandwidth: on });
  }

  private reconnectNow(): void {
    if (!this.started) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.attempt = 0;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.connect();
  }

  private connect(): void {
    if (!this.started) return;
    this.cleanup();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    this.set({ link: 'connecting' });
    ws.onopen = () => {
      this.attempt = 0;
      this.send({ type: 'subscribe', lowBandwidth: this.snapshot.lowBandwidth });
      this.pingTimer = window.setInterval(() => this.ping(), PING_MS);
      this.armWatchdog();
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.armWatchdog();
      this.handle(msg);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.cleanup();
      this.set({ link: 'offline' });
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  private cleanup(): void {
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    if (this.watchdog) window.clearTimeout(this.watchdog);
    this.pingTimer = null;
    this.watchdog = null;
  }

  private armWatchdog(): void {
    if (this.watchdog) window.clearTimeout(this.watchdog);
    this.watchdog = window.setTimeout(() => {
      // Half-open sockets on a cellular link never error. Kill and reconnect.
      this.ws?.close();
    }, DEAD_MS);
  }

  private scheduleReconnect(): void {
    if (!this.started) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt) * (0.8 + Math.random() * 0.4);
    this.attempt++;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private ping(): void {
    this.pingSentAt = Date.now();
    this.send({ type: 'ping', t: this.pingSentAt });
  }

  private handle(msg: ServerMessage): void {
    const now = Date.now();
    switch (msg.type) {
      case 'hello':
        this.set({
          intervalMs: msg.intervalMs,
          clockOffsetMs: msg.serverTime - now,
          lastMessageAt: now,
        });
        break;
      case 'snapshot':
        saveCache(msg.state);
        this.set({
          state: msg.state,
          link: 'live',
          lastMessageAt: now,
          events: mergeEvents(this.snapshot.events, msg.state.recentEvents),
        });
        break;
      case 'delta': {
        const prev = this.snapshot.state;
        if (!prev) break;
        const next: FullState = { ...prev };
        if (msg.watch) next.watch = msg.watch;
        if (msg.instruments) next.instruments = { ...prev.instruments, ...msg.instruments };
        if (msg.source) next.source = msg.source;
        if (msg.time) next.time = msg.time;
        if (msg.health) next.health = msg.health;
        if (msg.ais) {
          const byMmsi = new Map(prev.ais.map((t) => [t.mmsi, t]));
          for (const t of msg.ais.upsert ?? []) byMmsi.set(t.mmsi, t);
          for (const m of msg.ais.remove ?? []) byMmsi.delete(m);
          next.ais = [...byMmsi.values()].sort(
            (a, b) => (a.range ?? Infinity) - (b.range ?? Infinity),
          );
        }
        let events = this.snapshot.events;
        if (msg.events) {
          events = mergeEvents(events, msg.events);
          next.recentEvents = events.slice(-50);
        }
        if (msg.watch || msg.instruments) saveCacheThrottled(next);
        this.set({ state: next, link: 'live', lastMessageAt: now, events });
        break;
      }
      case 'pong':
        this.set({
          rttMs: now - msg.t,
          clockOffsetMs: msg.serverTime - now + (now - msg.t) / 2,
          lastMessageAt: now,
        });
        break;
    }
  }
}

function mergeEvents(existing: EventRecord[], incoming: EventRecord[]): EventRecord[] {
  const seen = new Set(existing.map((e) => e.seq));
  const out = [...existing];
  for (const e of incoming) {
    if (!seen.has(e.seq)) {
      out.push(e);
      seen.add(e.seq);
    }
  }
  out.sort((a, b) => a.seq - b.seq);
  return out.slice(-MAX_EVENTS);
}

function loadCache(): FullState | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as FullState) : null;
  } catch {
    return null;
  }
}

let lastCacheSave = 0;
function saveCacheThrottled(state: FullState): void {
  const now = Date.now();
  if (now - lastCacheSave < 10_000) return;
  lastCacheSave = now;
  saveCache(state);
}

function saveCache(state: FullState): void {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ ...state, recentEvents: state.recentEvents.slice(-20) }),
    );
  } catch {
    // quota or private mode: fine
  }
}

function loadPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export const store = new StateStore();

export function useStore(): StoreSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
