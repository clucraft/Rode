import type { Normalizer } from '@rode/ingest';

/*
 * The process clock.
 *
 * A Pi has no RTC. With no internet at boot the system clock says 1970 (or
 * whatever it was at the last shutdown) until NTP arrives, which at anchor
 * may be never. GPS sentences carry UTC, so:
 *
 *   - if the system clock is plausible (after 2020), use it
 *   - otherwise, if GPS time has been seen, use GPS time plus the
 *     monotonic time elapsed since it was received
 *   - otherwise report "unsynced" explicitly; consumers can see it
 *
 * `source` is part of the time view, so "time not yet synced" is a state
 * the UI shows rather than a pile of 1970 timestamps nobody notices.
 */

export type ClockSource = 'system' | 'gps' | 'unsynced';

const PLAUSIBLE_AFTER = Date.UTC(2020, 0, 1);

export class Clock {
  private gps: { epochMs: number; monotonicAt: number } | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly system: () => number = Date.now) {}

  /** Subscribe to the normaliser's GPS time fixes. */
  attach(normalizer: Normalizer): void {
    this.unsubscribe = normalizer.on((e) => {
      if (e.type === 'time') this.gps = { epochMs: e.gps.epochMs, monotonicAt: performance.now() };
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  systemPlausible(): boolean {
    return this.system() >= PLAUSIBLE_AFTER;
  }

  source(): ClockSource {
    if (this.systemPlausible()) return 'system';
    return this.gps ? 'gps' : 'unsynced';
  }

  now(): number {
    if (this.systemPlausible()) return this.system();
    if (this.gps) return this.gps.epochMs + (performance.now() - this.gps.monotonicAt);
    return this.system();
  }

  /** GPS time minus system time at the last fix, ms; null without a fix. */
  gpsOffsetMs(): number | null {
    if (!this.gps) return null;
    return this.gps.epochMs - (this.system() - (performance.now() - this.gps.monotonicAt));
  }
}
