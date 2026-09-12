import net from 'node:net';
import {
  backoffMs,
  SourceEmitter,
  type ConnectionState,
  type SourceAdapter,
  type SourceListener,
} from '../adapter.js';
import { LineSplitter } from '../nmea/sentence.js';

export interface TcpSourceOptions {
  host: string;
  port: number;
  /**
   * Treat the connection as dead when no bytes arrive for this long. WiFi to
   * the hub drops without the TCP stack noticing; a half-open socket that
   * never errors is the classic silent failure, and a Cortex emits several
   * sentences a second, so 15 s of silence is a broken link.
   */
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
  backoffCapMs?: number;
  now?: () => number;
  /** Test hook. */
  connect?: (host: string, port: number) => net.Socket;
}

/**
 * NMEA 0183 over TCP: the primary path to a Cortex hub. Reconnects forever
 * with capped exponential backoff and reports every state change.
 */
export class TcpSource implements SourceAdapter {
  readonly kind = 'nmea0183-tcp' as const;
  private readonly emitter: SourceEmitter;
  private readonly now: () => number;
  private socket: net.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private running = false;
  private readonly splitter = new LineSplitter();
  private readonly counters = { bytes: 0, lines: 0, connects: 0, reconnects: 0, idleTimeouts: 0 };
  private lastError: string | null = null;
  private lastDataAt: number | null = null;

  constructor(private readonly opts: TcpSourceOptions) {
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
      remote: `${this.opts.host}:${this.opts.port}`,
    };
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
    this.timer = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      await new Promise<void>((resolve) => {
        s.once('close', () => resolve());
        s.destroy();
      });
    }
    this.emitter.setState({ kind: 'disconnected', since: this.now(), reason: 'stopped' });
  }

  private connect(): void {
    if (!this.running) return;
    const now = this.now();
    this.emitter.setState({
      kind: 'connecting',
      since: now,
      attempt: this.attempt,
      nextRetryMs: backoffMs(this.attempt, this.opts.backoffCapMs),
    });
    const socket = this.opts.connect
      ? this.opts.connect(this.opts.host, this.opts.port)
      : net.connect({ host: this.opts.host, port: this.opts.port });
    this.socket = socket;
    this.splitter.reset();
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    socket.setTimeout(this.opts.idleTimeoutMs ?? 15_000);
    socket.setEncoding('utf8');

    const connectTimer = setTimeout(() => {
      this.lastError = 'connect timeout';
      socket.destroy(new Error('connect timeout'));
    }, this.opts.connectTimeoutMs ?? 10_000);

    socket.on('connect', () => {
      clearTimeout(connectTimer);
      if (this.attempt > 0) this.counters.reconnects++;
      this.counters.connects++;
      this.attempt = 0;
      this.emitter.setState({
        kind: 'connected',
        since: this.now(),
        remote: `${this.opts.host}:${this.opts.port}`,
      });
    });
    socket.on('data', (chunk: string) => {
      const t = this.now();
      this.counters.bytes += chunk.length;
      this.lastDataAt = t;
      for (const line of this.splitter.push(chunk)) {
        this.counters.lines++;
        this.emitter.emit({ type: 'line', line, now: t });
      }
    });
    socket.on('timeout', () => {
      this.counters.idleTimeouts++;
      this.lastError = 'no data (idle timeout)';
      socket.destroy(new Error('idle timeout'));
    });
    socket.on('error', (err: Error) => {
      this.lastError = err.message;
    });
    socket.on('close', () => {
      clearTimeout(connectTimer);
      if (this.socket === socket) this.socket = null;
      if (!this.running) return;
      const t = this.now();
      this.emitter.setState({
        kind: 'disconnected',
        since: t,
        ...(this.lastError ? { reason: this.lastError } : {}),
      });
      const delay = backoffMs(this.attempt, this.opts.backoffCapMs);
      this.attempt++;
      this.timer = setTimeout(() => this.connect(), delay);
    });
  }
}
