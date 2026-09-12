import {
  backoffMs,
  SourceEmitter,
  type ConnectionState,
  type SourceAdapter,
  type SourceListener,
} from '../adapter.js';
import type { FieldName } from '../normalize.js';

/*
 * Signal K delta stream adapter. Signal K already speaks SI (m, m/s, rad, K),
 * so this maps paths to fields and emits them directly; no NMEA parsing.
 *
 * Uses the WebSocket client built into Node 22+. Reconnects with the same
 * capped backoff as the TCP source.
 */

export interface SignalKSourceOptions {
  /** e.g. ws://signalk.local:3000/signalk/v1/stream */
  url: string;
  /** Bearer token for servers that require auth. */
  token?: string;
  /** Distance transducer → waterline when only belowTransducer is available. */
  transducerDepth?: number;
  idleTimeoutMs?: number;
  backoffCapMs?: number;
  now?: () => number;
  /** Test hook. */
  createSocket?: (url: string, headers: Record<string, string>) => WebSocketLike;
}

/** The subset of the WebSocket API we use, so tests can supply a fake. */
export interface WebSocketLike {
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (ev: { data?: unknown; reason?: string }) => void,
  ): void;
  close(): void;
  readyState: number;
}

interface Delta {
  context?: string;
  updates?: {
    timestamp?: string;
    $source?: string;
    source?: { label?: string; type?: string };
    values?: { path: string; value: unknown }[];
  }[];
}

/** Own-vessel path → field. */
const PATHS: Record<string, FieldName> = {
  'navigation.speedOverGround': 'sog',
  'navigation.courseOverGroundTrue': 'cog',
  'navigation.headingTrue': 'heading',
  'environment.depth.belowSurface': 'depth',
  'environment.wind.angleApparent': 'awa',
  'environment.wind.speedApparent': 'aws',
  'environment.wind.angleTrueWater': 'twa',
  'environment.wind.speedTrue': 'tws',
  'environment.wind.directionTrue': 'twd',
  'environment.water.temperature': 'waterTemp',
  'environment.outside.temperature': 'airTemp',
  'environment.outside.pressure': 'pressure',
  'environment.inside.refrigerator.temperature': 'fridgeTemp',
  'environment.inside.freezer.temperature': 'freezerTemp',
  'navigation.gnss.horizontalDilution': 'hdop',
};

/** Node 22+ ships a WHATWG WebSocket client; headers are not supported by it, so tokens go in the URL query for that path. */
function defaultCreateSocket(url: string, headers: Record<string, string>): WebSocketLike {
  const u = new URL(url);
  const auth = headers.Authorization;
  if (auth?.startsWith('Bearer ')) u.searchParams.set('token', auth.slice(7));
  return new WebSocket(u.toString());
}

export class SignalKSource implements SourceAdapter {
  readonly kind = 'signalk-ws' as const;
  private readonly emitter: SourceEmitter;
  private readonly now: () => number;
  private ws: WebSocketLike | null = null;
  private timer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private running = false;
  private readonly counters = { messages: 0, values: 0, ignored: 0, connects: 0, reconnects: 0 };
  private lastError: string | null = null;
  private magneticVariation: number | null = null;

  constructor(private readonly opts: SignalKSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.emitter = new SourceEmitter(this.now());
  }

  on(listener: SourceListener): () => void {
    return this.emitter.on(listener);
  }

  getConnectionState(): ConnectionState {
    return this.emitter.getState();
  }

  stats(): Record<string, number | string | null> {
    return { ...this.counters, lastError: this.lastError, url: this.opts.url };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.timer = null;
    this.idleTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    this.emitter.setState({ kind: 'disconnected', since: this.now(), reason: 'stopped' });
    await Promise.resolve();
  }

  private connect(): void {
    if (!this.running) return;
    const url = new URL(this.opts.url);
    if (!url.searchParams.has('subscribe')) url.searchParams.set('subscribe', 'all');
    this.emitter.setState({
      kind: 'connecting',
      since: this.now(),
      attempt: this.attempt,
      nextRetryMs: backoffMs(this.attempt, this.opts.backoffCapMs),
    });
    const headers: Record<string, string> = this.opts.token
      ? { Authorization: `Bearer ${this.opts.token}` }
      : {};
    let ws: WebSocketLike;
    try {
      const create = this.opts.createSocket ?? defaultCreateSocket;
      ws = create(url.toString(), headers);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (this.attempt > 0) this.counters.reconnects++;
      this.counters.connects++;
      this.attempt = 0;
      this.emitter.setState({ kind: 'connected', since: this.now(), remote: url.host });
      this.armIdle();
    });
    ws.addEventListener('message', (ev) => {
      this.armIdle();
      this.counters.messages++;
      const text = typeof ev.data === 'string' ? ev.data : '';
      if (!text) return;
      let delta: Delta;
      try {
        delta = JSON.parse(text) as Delta;
      } catch {
        return;
      }
      this.handleDelta(delta);
    });
    ws.addEventListener('error', () => {
      this.lastError = 'websocket error';
    });
    ws.addEventListener('close', (ev) => {
      if (this.ws === ws) this.ws = null;
      if (!this.running) return;
      const reason = ev.reason ?? this.lastError ?? undefined;
      this.emitter.setState({
        kind: 'disconnected',
        since: this.now(),
        ...(reason ? { reason } : {}),
      });
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = backoffMs(this.attempt, this.opts.backoffCapMs);
    this.attempt++;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.lastError = 'no messages (idle timeout)';
      this.ws?.close();
    }, this.opts.idleTimeoutMs ?? 30_000);
  }

  /** Exposed for tests. */
  handleDelta(delta: Delta): void {
    const now = this.now();
    const context = delta.context ?? 'vessels.self';
    if (context !== 'vessels.self' && !context.endsWith('.self')) return; // AIS via Signal K: later phase
    for (const u of delta.updates ?? []) {
      const ts = u.timestamp ? Date.parse(u.timestamp) : Number.NaN;
      const timestamp = Number.isFinite(ts) && Math.abs(ts - now) < 60_000 ? ts : now;
      const source = `signalk:${u.$source ?? u.source?.label ?? 'unknown'}`;
      for (const v of u.values ?? []) {
        this.counters.values++;
        const field = this.mapValue(v.path, v.value);
        if (!field) {
          this.counters.ignored++;
          continue;
        }
        this.emitter.emit({
          type: 'field',
          name: field.name,
          value: field.value,
          timestamp,
          source,
        });
      }
    }
  }

  private mapValue(
    path: string,
    value: unknown,
  ): { name: FieldName; value: number | { lat: number; lon: number } } | null {
    if (path === 'navigation.position') {
      const p = value as { latitude?: unknown; longitude?: unknown } | null;
      if (p && typeof p.latitude === 'number' && typeof p.longitude === 'number') {
        return { name: 'position', value: { lat: p.latitude, lon: p.longitude } };
      }
      return null;
    }
    if (path === 'navigation.magneticVariation' && typeof value === 'number') {
      this.magneticVariation = value;
      return null;
    }
    if (path === 'navigation.headingMagnetic' && typeof value === 'number') {
      return this.magneticVariation === null
        ? null
        : { name: 'heading', value: value + this.magneticVariation };
    }
    if (path === 'environment.depth.belowTransducer' && typeof value === 'number') {
      return { name: 'depth', value: value + (this.opts.transducerDepth ?? 0) };
    }
    if (path === 'navigation.gnss.satellites' && typeof value === 'number') {
      return { name: 'satellites', value };
    }
    if (path === 'navigation.gnss.methodQuality' && typeof value === 'string') {
      const q: Record<string, number> = {
        'no GPS': 0,
        'GNSS Fix': 1,
        'DGNSS fix': 2,
        'Precise GNSS': 3,
        'RTK fixed integer': 4,
        'RTK float': 5,
        'Estimated (DR) mode': 6,
        'Manual input': 7,
        'Simulator mode': 8,
      };
      return { name: 'fixQuality', value: q[value] ?? 1 };
    }
    // electrical.batteries.<id>.capacity.stateOfCharge / .voltage; electrical.solar.<id>.panelPower
    const m = /^electrical\.(batteries|solar)\.([^.]+)\.(.+)$/.exec(path);
    if (m && typeof value === 'number') {
      const [, kind, , rest] = m;
      if (kind === 'batteries' && rest === 'capacity.stateOfCharge')
        return { name: 'batterySoc', value };
      if (kind === 'batteries' && rest === 'voltage') return { name: 'batteryVoltage', value };
      if (kind === 'solar' && rest === 'panelPower') return { name: 'solarPower', value };
      return null;
    }
    const name = PATHS[path];
    if (name && typeof value === 'number' && Number.isFinite(value)) return { name, value };
    return null;
  }
}
