import type { Normalizer } from '@rode/ingest';
import type { SampleInput, SamplesRepo } from '../db/repos.js';
import type { EngineHost } from '../engine/host.js';
import type { Logger } from '../logger.js';

/*
 * Sample writer: one normalised row per second, buffered in memory and
 * flushed in a single transaction every FLUSH_MS. 1 Hz is plenty for track
 * history; the alarm engine works off the in-memory stream, never this table.
 * Buffering keeps SD-card writes to a handful per minute.
 */

const FLUSH_MS = 10_000;
const HOUR = 3_600_000;

export interface SampleWriterOptions {
  normalizer: Normalizer;
  engine: EngineHost;
  samples: SamplesRepo;
  log: Logger;
  now?: () => number;
}

export class SampleWriter {
  private buffer: SampleInput[] = [];
  private tickTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastAt = 0;
  private readonly now: () => number;
  public written = 0;

  constructor(private readonly opts: SampleWriterOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.tickTimer = setInterval(() => this.capture(), 1000);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this.tickTimer.unref();
    this.flushTimer.unref();
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.tickTimer = null;
    this.flushTimer = null;
    this.flush();
  }

  /** Take one row from the current normaliser state. Public for tests. */
  capture(): void {
    const now = this.now();
    const at = Math.floor(now / 1000) * 1000;
    if (at === this.lastAt) return;
    this.lastAt = at;
    const n = this.opts.normalizer;
    const pos = n.getField('position');
    const stale = (f: { timestamp: number } | undefined, maxAge: number) =>
      !f || now - f.timestamp > maxAge;
    // Write nothing when there is no usable position: a row of nulls is not a track point.
    if (stale(pos, 10_000)) return;
    const num = (name: Parameters<typeof n.getField>[0], maxAge = 15_000): number | null => {
      const f = n.getField(name);
      return stale(f, maxAge) || typeof f?.value !== 'number' ? null : f.value;
    };
    const extra: Record<string, number> = {};
    // Water speed and barometer ride in the JSON column: no schema change, and
    // the Data screen's rolling charts read them back through /api/series.
    const stw = num('stw');
    if (stw !== null) extra.stw = Math.round(stw * 1000) / 1000;
    const pressure = num('pressure', 15 * 60_000);
    if (pressure !== null) extra.pressure = Math.round(pressure);
    for (const name of [
      'batterySoc',
      'batteryVoltage',
      'solarPower',
      'fridgeTemp',
      'freezerTemp',
      'airTemp',
      'waterTemp',
    ] as const) {
      const v = num(name, 15 * 60_000);
      if (v !== null) extra[name] = Math.round(v * 100) / 100;
    }
    this.buffer.push({
      at,
      lat: pos?.value.lat ?? null,
      lon: pos?.value.lon ?? null,
      sog: num('sog'),
      cog: num('cog'),
      heading: num('heading'),
      depth: num('depth', 60_000),
      awa: num('awa'),
      aws: num('aws'),
      hdop: num('hdop', 60_000),
      distance: this.opts.engine.getState().live.distanceFromAnchor,
      extra: Object.keys(extra).length > 0 ? extra : null,
    });
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    try {
      this.opts.samples.insertMany(rows);
      this.written += rows.length;
    } catch (err) {
      this.opts.log.error({ err, rows: rows.length }, 'sample flush failed');
    }
  }
}

/**
 * Nightly housekeeping: downsample beyond 48 h to 10 s, prune beyond the
 * retention window. Runs at the configured local hour (default 03:00) and on
 * boot if it has never run.
 */
export interface HousekeepingOptions {
  samples: SamplesRepo;
  log: Logger;
  retentionDays: () => number;
  localHour: (now: number) => number | null;
  runAtHour?: number;
  now?: () => number;
}

export class Housekeeping {
  private timer: NodeJS.Timeout | null = null;
  private lastRunDay: number | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: HousekeepingOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.timer = setInterval(() => this.maybeRun(), 5 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  maybeRun(): void {
    const now = this.now();
    const hour = this.opts.localHour(now);
    const day = Math.floor(now / (24 * HOUR));
    if (hour === (this.opts.runAtHour ?? 3) && this.lastRunDay !== day) {
      this.lastRunDay = day;
      this.run();
    }
  }

  run(): { thinned: number; pruned: number } {
    const now = this.now();
    const started = now;
    const r = this.opts.samples.downsample(
      now,
      48 * HOUR,
      10_000,
      this.opts.retentionDays() * 24 * HOUR,
    );
    this.opts.log.info({ ...r, tookMs: this.now() - started }, 'samples housekeeping');
    return r;
  }
}
