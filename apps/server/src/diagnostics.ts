import os from 'node:os';
import type { Counters, Normalizer } from '@rode/ingest';

/*
 * Rolling rates for the diagnostics page: sentences per second by type,
 * checksum error rate, plus process CPU/RAM. Samples counters every
 * WINDOW_MS and reports the delta, so a stalled stream shows 0/s rather than
 * a lifetime average that decays slowly.
 */

const WINDOW_MS = 10_000;

export interface DiagnosticsView {
  window: { seconds: number; sampledAt: number };
  sentencesPerSecond: number;
  byTypePerSecond: Record<string, number>;
  checksumErrorRate: number;
  malformedPerSecond: number;
  unsupportedTypes: Record<string, number>;
  totals: Counters;
  aisTargets: number;
  process: {
    cpuPercent: number;
    rssBytes: number;
    heapUsedBytes: number;
    uptimeS: number;
    loadAvg1: number;
    nodeVersion: string;
  };
}

export class Diagnostics {
  private last: { counters: Counters; at: number; cpu: NodeJS.CpuUsage } | null = null;
  private rates: Omit<DiagnosticsView, 'totals' | 'aisTargets' | 'process'> = {
    window: { seconds: 0, sampledAt: 0 },
    sentencesPerSecond: 0,
    byTypePerSecond: {},
    checksumErrorRate: 0,
    malformedPerSecond: 0,
    unsupportedTypes: {},
  };
  private cpuPercent = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly normalizer: Normalizer,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.sample();
    this.timer = setInterval(() => this.sample(), WINDOW_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Take a counter snapshot and compute rates since the previous one. */
  sample(): void {
    const at = this.now();
    const c = snapshotCounters(this.normalizer.counters);
    const cpu = process.cpuUsage();
    if (this.last) {
      const dt = (at - this.last.at) / 1000;
      if (dt > 0) {
        const prev = this.last.counters;
        const byType: Record<string, number> = {};
        for (const [k, v] of Object.entries(c.byType)) {
          byType[k] = round((v - (prev.byType[k] ?? 0)) / dt);
        }
        const sentences = c.sentences - prev.sentences;
        const checksum = c.checksumFailures - prev.checksumFailures;
        this.rates = {
          window: { seconds: round(dt), sampledAt: at },
          sentencesPerSecond: round(sentences / dt),
          byTypePerSecond: byType,
          checksumErrorRate:
            sentences + checksum > 0 ? round(checksum / (sentences + checksum), 4) : 0,
          malformedPerSecond: round((c.malformed - prev.malformed) / dt),
          unsupportedTypes: c.unsupportedTypes,
        };
        const cpuMicros = cpu.user - this.last.cpu.user + (cpu.system - this.last.cpu.system);
        this.cpuPercent = round((cpuMicros / 1000 / (dt * 1000)) * 100);
      }
    }
    this.last = { counters: c, at, cpu };
  }

  view(): DiagnosticsView {
    const mem = process.memoryUsage();
    return {
      ...this.rates,
      totals: snapshotCounters(this.normalizer.counters),
      aisTargets: this.normalizer.ais.all().length,
      process: {
        cpuPercent: this.cpuPercent,
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        uptimeS: Math.round(process.uptime()),
        loadAvg1: round(os.loadavg()[0] ?? 0, 2),
        nodeVersion: process.version,
      },
    };
  }
}

function snapshotCounters(c: Counters): Counters {
  return { ...c, byType: { ...c.byType }, unsupportedTypes: { ...c.unsupportedTypes } };
}

function round(v: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
