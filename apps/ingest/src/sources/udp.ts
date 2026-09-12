import dgram from 'node:dgram';
import {
  SourceEmitter,
  type ConnectionState,
  type SourceAdapter,
  type SourceListener,
} from '../adapter.js';
import { LineSplitter } from '../nmea/sentence.js';

export interface UdpSourceOptions {
  /** Port to listen on. */
  port: number;
  /** Address to bind; default all interfaces. */
  host?: string;
  /** Multicast group to join, if the hub multicasts. */
  multicast?: string;
  /** No datagrams for this long → disconnected. UDP has no connection, so liveness is data. */
  idleTimeoutMs?: number;
  now?: () => number;
}

/**
 * NMEA 0183 over UDP. Connectionless, so "connected" means "datagrams are
 * arriving" and "disconnected" means they stopped.
 */
export class UdpSource implements SourceAdapter {
  readonly kind = 'nmea0183-udp' as const;
  private readonly emitter: SourceEmitter;
  private readonly now: () => number;
  private socket: dgram.Socket | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly splitter = new LineSplitter();
  private readonly counters = { datagrams: 0, bytes: 0, lines: 0, idleTimeouts: 0 };
  private lastError: string | null = null;
  private lastDataAt: number | null = null;

  constructor(private readonly opts: UdpSourceOptions) {
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
    return {
      ...this.counters,
      lastError: this.lastError,
      lastDataAt: this.lastDataAt,
      port: this.opts.port,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    this.emitter.setState({ kind: 'connecting', since: this.now(), attempt: 0, nextRetryMs: 0 });
    socket.on('error', (err) => {
      this.lastError = err.message;
      this.emitter.setState({ kind: 'disconnected', since: this.now(), reason: err.message });
    });
    socket.on('message', (msg) => {
      const t = this.now();
      this.counters.datagrams++;
      this.counters.bytes += msg.length;
      this.lastDataAt = t;
      if (this.emitter.getState().kind !== 'connected') {
        this.emitter.setState({ kind: 'connected', since: t });
      }
      this.armIdle();
      // Datagrams usually hold whole sentences, but split defensively.
      for (const line of this.splitter.push(msg.toString('utf8').replace(/\r?\n?$/, '\n'))) {
        this.counters.lines++;
        this.emitter.emit({ type: 'line', line, now: t });
      }
    });
    socket.bind({ port: this.opts.port, address: this.opts.host ?? '0.0.0.0' }, () => {
      if (this.opts.multicast) {
        try {
          socket.addMembership(this.opts.multicast);
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err);
        }
      }
      this.armIdle();
    });
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.counters.idleTimeouts++;
      this.lastError = 'no datagrams (idle timeout)';
      this.emitter.setState({ kind: 'disconnected', since: this.now(), reason: this.lastError });
    }, this.opts.idleTimeoutMs ?? 15_000);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const s = this.socket;
    this.socket = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
    this.emitter.setState({ kind: 'disconnected', since: this.now(), reason: 'stopped' });
  }
}
