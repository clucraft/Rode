import { describe, expect, it } from 'vitest';
import { Normalizer, encodeZDA } from '@rode/ingest';
import { Clock } from './clock.js';

describe('Clock', () => {
  it('uses the system clock when it is plausible', () => {
    const c = new Clock(() => Date.UTC(2026, 8, 11));
    expect(c.source()).toBe('system');
    expect(c.now()).toBe(Date.UTC(2026, 8, 11));
  });

  it('reports unsynced with a 1970 clock and no GPS, then follows GPS time once it arrives', () => {
    let system = 12_345; // a Pi that just booted with no RTC
    const c = new Clock(() => system);
    const n = new Normalizer();
    c.attach(n);
    expect(c.source()).toBe('unsynced');
    expect(c.now()).toBe(12_345);

    const gpsNow = Date.UTC(2026, 8, 11, 3, 0, 0);
    n.feedLine(encodeZDA(gpsNow), system);
    expect(c.source()).toBe('gps');
    expect(Math.abs(c.now() - gpsNow)).toBeLessThan(50);
    expect(c.gpsOffsetMs()).toBeGreaterThan(gpsNow - 100_000);

    // NTP eventually fixes the system clock: back to the system source.
    system = gpsNow + 60_000;
    expect(c.source()).toBe('system');
    expect(c.now()).toBe(system);
    c.detach();
  });

  it('ignores implausible GPS dates so a receiver without a fix cannot poison the clock', () => {
    const c = new Clock(() => 5000);
    const n = new Normalizer();
    c.attach(n);
    n.feedLine(encodeZDA(Date.UTC(1980, 0, 6)), 5000);
    expect(c.source()).toBe('unsynced');
  });
});
