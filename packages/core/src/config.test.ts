import { describe, expect, it } from 'vitest';
import { ALARM_CONFIG_DOCS, DEFAULT_ALARM_CONFIG, resolveAlarmConfig } from './config.js';
import { knotsToMps } from './units.js';

describe('alarm config', () => {
  it('documents every key with a reason', () => {
    for (const key of Object.keys(DEFAULT_ALARM_CONFIG) as (keyof typeof DEFAULT_ALARM_CONFIG)[]) {
      const doc = ALARM_CONFIG_DOCS[key];
      expect(doc.label.length).toBeGreaterThan(0);
      expect(doc.why.length).toBeGreaterThan(20);
      if (doc.min !== undefined) expect(DEFAULT_ALARM_CONFIG[key]).toBeGreaterThanOrEqual(doc.min);
      if (doc.max !== undefined) expect(DEFAULT_ALARM_CONFIG[key]).toBeLessThanOrEqual(doc.max);
    }
  });

  it('ships the field-tested defaults', () => {
    expect(DEFAULT_ALARM_CONFIG.warnDistance).toBe(10);
    expect(DEFAULT_ALARM_CONFIG.awaMinWindSpeed).toBeCloseTo(knotsToMps(5));
    expect(DEFAULT_ALARM_CONFIG.sogThreshold).toBeCloseTo(knotsToMps(1.2));
    expect(DEFAULT_ALARM_CONFIG.gpsStaleWarnMs).toBe(30_000);
    expect(DEFAULT_ALARM_CONFIG.gpsStaleCriticalMs).toBe(60_000);
    expect(DEFAULT_ALARM_CONFIG.snoozeMs).toBe(600_000);
  });

  it('merges overrides and ignores junk', () => {
    const c = resolveAlarmConfig({ warnDistance: 20, sogThreshold: Number.NaN });
    expect(c.warnDistance).toBe(20);
    expect(c.sogThreshold).toBe(DEFAULT_ALARM_CONFIG.sogThreshold);
    expect(resolveAlarmConfig()).toEqual(DEFAULT_ALARM_CONFIG);
  });
});
