import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  SourceEmitter,
  type ConnectionState,
  type SourceAdapter,
  type SourceListener,
} from '../adapter.js';

/*
 * Record and replay.
 *
 * Recording format is one line per sentence: `<epochMs>\t<sentence>`. Lines
 * without a tab (a bare NMEA log from some other tool) replay at a fixed
 * rate. Once Rode is aboard, real recordings from the Cortex become the best
 * test fixtures available, which is why this exists before anything is on
 * the boat.
 */

export interface RecorderOptions {
  path: string;
  now?: () => number;
}

/** Appends timestamped lines to a file. Attach it to any line-emitting source. */
export class Recorder {
  private stream: WriteStream | null = null;
  private readonly now: () => number;
  public lines = 0;
  public bytes = 0;

  constructor(private readonly opts: RecorderOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.stream ??= createWriteStream(this.opts.path, { flags: 'a' });
  }

  write(line: string, at = this.now()): void {
    if (!this.stream) return;
    const out = `${at}\t${line}\n`;
    this.stream.write(out);
    this.lines++;
    this.bytes += out.length;
  }

  /** Attach to a source; returns the unsubscribe. */
  attach(source: SourceAdapter): () => void {
    this.start();
    return source.on((e) => {
      if (e.type === 'line') this.write(e.line, e.now);
    });
  }

  async stop(): Promise<void> {
    const s = this.stream;
    this.stream = null;
    if (s) await new Promise<void>((resolve) => s.end(() => resolve()));
  }
}

export interface ReplaySourceOptions {
  path: string;
  /** Playback speed multiplier. */
  speed?: number;
  loop?: boolean;
  /** For bare NMEA logs without timestamps: sentences per second. */
  fallbackRate?: number;
  now?: () => number;
}

/**
 * Replays a recording with its original timing (scaled). Reads the file in a
 * streaming fashion so multi-day recordings do not need to fit in memory.
 */
export class ReplaySource implements SourceAdapter {
  readonly kind = 'replay' as const;
  private readonly emitter: SourceEmitter;
  private readonly now: () => number;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly counters = { lines: 0, loops: 0 };

  constructor(private readonly opts: ReplaySourceOptions) {
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
    return { ...this.counters, path: this.opts.path, speed: this.opts.speed ?? 1 };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.play();
  }

  private async play(): Promise<void> {
    const speed = Math.max(0.01, this.opts.speed ?? 1);
    const fallbackGap = 1000 / (this.opts.fallbackRate ?? 5);
    do {
      const rl = createInterface({
        input: createReadStream(this.opts.path, 'utf8'),
        crlfDelay: Infinity,
      });
      let lastRecorded: number | null = null;
      this.emitter.setState({ kind: 'connected', since: this.now(), remote: this.opts.path });
      for await (const raw of rl) {
        if (!this.running) {
          rl.close();
          return;
        }
        const line = raw.trim();
        if (!line) continue;
        const tab = line.indexOf('\t');
        let recordedAt: number | null = null;
        let sentence = line;
        if (tab > 0) {
          const ts = Number(line.slice(0, tab));
          if (Number.isFinite(ts)) {
            recordedAt = ts;
            sentence = line.slice(tab + 1);
          }
        }
        const gap =
          recordedAt !== null && lastRecorded !== null
            ? Math.max(0, Math.min(60_000, recordedAt - lastRecorded))
            : fallbackGap;
        if (recordedAt !== null) lastRecorded = recordedAt;
        if (gap > 0) await this.sleep(gap / speed);
        // stop() may have flipped the flag while we slept; TS cannot see that.
        if (!this.isRunning()) return;
        this.counters.lines++;
        this.emitter.emit({ type: 'line', line: sentence, now: this.now() });
      }
      this.counters.loops++;
    } while (this.running && this.opts.loop);
    if (this.running) {
      this.emitter.setState({ kind: 'disconnected', since: this.now(), reason: 'recording ended' });
      this.running = false;
    }
  }

  private isRunning(): boolean {
    return this.running;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.emitter.setState({ kind: 'disconnected', since: this.now(), reason: 'stopped' });
    await Promise.resolve();
  }
}
