import { describe, expect, it } from 'vitest';
import { celsiusToKelvin, degToRad, knotsToMps } from '@rode/core';
import { Normalizer, type NormalizerEvent } from './normalize.js';
import { AisTracker } from './nmea/ais.js';
import {
  encodeDBT,
  encodeDPT,
  encodeGGA,
  encodeGGANoFix,
  encodeHDG,
  encodeHDM,
  encodeHDT,
  encodeMWV,
  encodeRMC,
  encodeRMCNoFix,
  encodeVHW,
  encodeVTG,
  encodeXDR,
  encodeZDA,
} from './nmea/encode.js';
import { buildSentence } from './nmea/sentence.js';

const T0 = Date.UTC(2026, 8, 11, 3, 0, 0);
const fix = { epochMs: T0, lat: 32.29, lon: -64.83, sog: knotsToMps(0.4), cog: degToRad(200) };

describe('Normalizer', () => {
  it('builds a snapshot from a fix and instruments, in SI', () => {
    const n = new Normalizer();
    n.setSourceState({ connected: true, since: T0 - 1000 });
    n.feedLine(encodeRMC({ ...fix, magneticVariation: degToRad(-12) }), T0);
    n.feedLine(encodeGGA({ ...fix, hdop: 1.3, satellites: 11 }), T0);
    n.feedLine(encodeHDM(degToRad(100)), T0);
    n.feedLine(encodeDPT(4.5, 0.4), T0);
    n.feedLine(encodeMWV(degToRad(330), knotsToMps(14)), T0);
    const t = n.snapshot(T0 + 500);
    expect(t.position?.value.lat).toBeCloseTo(32.29, 5);
    expect(t.position?.stale).toBe(false);
    expect(t.sog?.value).toBeCloseTo(knotsToMps(0.4), 2);
    expect(t.cog?.value).toBeCloseTo(degToRad(200), 3);
    expect(t.hdop?.value).toBeCloseTo(1.3);
    expect(t.satellites?.value).toBe(11);
    // HDM magnetic + RMC's learned variation (12° W) → 88° true.
    expect(t.heading?.value).toBeCloseTo(degToRad(88), 3);
    // DPT with a positive offset: the sounder already referenced the waterline.
    expect(t.depth?.value).toBeCloseTo(4.9, 2);
    // MWV 330° → -30° relative.
    expect(t.awa?.value).toBeCloseTo(degToRad(-30), 3);
    expect(t.aws?.value).toBeCloseTo(knotsToMps(14), 2);
    expect(t.source.connected).toBe(true);
  });

  it('flags fields stale by their own max age', () => {
    const n = new Normalizer();
    n.feedLine(encodeRMC(fix), T0);
    n.feedLine(encodeDPT(4.5, 0), T0);
    const later = n.snapshot(T0 + 20_000);
    expect(later.position?.stale).toBe(true); // 10 s max age
    expect(later.depth?.stale).toBe(false); // 30 s max age
  });

  it('does not update position from an invalid RMC or a no-fix GGA', () => {
    const n = new Normalizer();
    n.feedLine(encodeRMC(fix), T0);
    n.feedLine(encodeRMCNoFix(T0 + 1000), T0 + 1000);
    n.feedLine(encodeGGANoFix(T0 + 1000), T0 + 1000);
    expect(n.getField('position')?.timestamp).toBe(T0);
    expect(n.getField('fixQuality')?.value).toBe(0);
  });

  it('applies the configured transducer depth for DBT and DPT without offset', () => {
    const n = new Normalizer({ transducerDepth: 0.6 });
    n.feedLine(encodeDBT(3.0), T0);
    expect(n.getField('depth')?.value).toBeCloseTo(3.6, 2);
    n.feedLine(encodeDPT(3.0, 0), T0);
    expect(n.getField('depth')?.value).toBeCloseTo(3.6, 2);
    n.feedLine(encodeDPT(3.0, -1.5), T0); // keel offset: ignored, use configured
    expect(n.getField('depth')?.value).toBeCloseTo(3.6, 2);
  });

  it('prefers HDT; falls back to HDG with its own variation; uses configured variation for HDM', () => {
    const n = new Normalizer({ magneticVariation: degToRad(5) });
    n.feedLine(encodeHDM(degToRad(10)), T0);
    expect(n.getField('heading')?.value).toBeCloseTo(degToRad(15), 3);
    n.feedLine(encodeHDG(degToRad(10), degToRad(-3)), T0);
    expect(n.getField('heading')?.value).toBeCloseTo(degToRad(7), 3);
    n.feedLine(encodeHDT(degToRad(200)), T0);
    expect(n.getField('heading')?.value).toBeCloseTo(degToRad(200), 3);
  });

  it('never emits a heading from a magnetic sentence with no variation available', () => {
    const n = new Normalizer();
    n.feedLine(encodeHDM(degToRad(10)), T0);
    expect(n.getField('heading')).toBeUndefined();
  });

  it('takes VTG course and speed', () => {
    const n = new Normalizer();
    n.feedLine(encodeVTG(degToRad(45), knotsToMps(2)), T0);
    expect(n.getField('cog')?.value).toBeCloseTo(degToRad(45), 3);
    expect(n.getField('sog')?.value).toBeCloseTo(knotsToMps(2), 2);
  });

  it('maps XDR transducers by name heuristics and keeps the rest as extras', () => {
    const n = new Normalizer();
    n.feedLine(
      encodeXDR([
        { type: 'C', value: -18.5, unit: 'C', name: 'Freezer', dp: 1 },
        { type: 'C', value: 5.5, unit: 'C', name: 'Fridge', dp: 1 },
        { type: 'C', value: 22.0, unit: 'C', name: 'CabinAir', dp: 1 },
        { type: 'U', value: 12.7, unit: 'V', name: 'HouseBank' },
        { type: 'P', value: 82, unit: 'P', name: 'HouseSOC', dp: 0 },
        { type: 'W', value: 240, unit: 'W', name: 'SolarMPPT', dp: 0 },
        { type: 'V', value: 0.6, unit: 'P', name: 'WaterTank' },
      ]),
      T0,
    );
    const t = n.snapshot(T0);
    expect(t.freezerTemp?.value).toBeCloseTo(celsiusToKelvin(-18.5));
    expect(t.fridgeTemp?.value).toBeCloseTo(celsiusToKelvin(5.5));
    expect(t.airTemp?.value).toBeCloseTo(celsiusToKelvin(22));
    expect(t.batteryVoltage?.value).toBeCloseTo(12.7);
    expect(t.batterySoc?.value).toBeCloseTo(0.82);
    expect(t.solarPower?.value).toBe(240);
    expect(n.getExtras().WaterTank?.field.value).toBeCloseTo(0.6);
  });

  it('syncs GPS time from RMC and ZDA, rejecting pre-2020 garbage', () => {
    const n = new Normalizer();
    const events: NormalizerEvent[] = [];
    n.on((e) => events.push(e));
    n.feedLine(encodeRMC({ ...fix, epochMs: Date.UTC(1980, 0, 6) }), 5000);
    expect(n.getGpsTime()).toBeNull();
    n.feedLine(encodeZDA(T0), 5000);
    expect(n.getGpsTime()).toEqual({ epochMs: T0, receivedAt: 5000 });
    expect(events.filter((e) => e.type === 'time')).toHaveLength(1);
  });

  it('counts sentence types, checksum failures, malformed and unsupported', () => {
    const n = new Normalizer();
    n.feedLine(encodeRMC(fix), T0);
    n.feedLine(encodeRMC(fix).replace(/\*..$/, '*00'), T0);
    n.feedLine(buildSentence('GPGSV', ['3', '1', '11']), T0);
    n.feedLine('$GP', T0);
    n.feedLine('not nmea at all', T0);
    expect(n.counters.lines).toBe(5);
    expect(n.counters.sentences).toBe(2);
    expect(n.counters.byType).toEqual({ RMC: 1, GSV: 1 });
    expect(n.counters.checksumFailures).toBe(1);
    expect(n.counters.unsupported).toBe(1);
    expect(n.counters.unsupportedTypes).toEqual({ GSV: 1 });
    expect(n.counters.malformed).toBe(1);
  });

  it('tracks AIS targets and emits updates', () => {
    const n = new Normalizer();
    const events: NormalizerEvent[] = [];
    n.on((e) => events.push(e));
    n.feedLine('!AIVDM,1,1,,A,13aEOK?P00PD2wVMdLDRhgvL289?,0*26', T0);
    expect(n.ais.all()).toHaveLength(1);
    expect(events.filter((e) => e.type === 'ais')).toHaveLength(1);
    expect(n.counters.aisDecoded).toBe(1);
  });
});

describe('derived wind and water speed', () => {
  it('parses VHW into STW and uses its heading only as a fallback', () => {
    const n = new Normalizer();
    const now = 1_700_000_000_000;
    n.feedLine(encodeVHW(knotsToMps(5), degToRad(45)), now, 'test');
    expect(n.getField('stw')?.value).toBeCloseTo(knotsToMps(5), 6);
    expect(n.getField('heading')?.value).toBeCloseTo(degToRad(45), 6);
    // A compass sentence takes over and a later VHW does not clobber it.
    n.feedLine(encodeHDT(degToRad(90)), now + 1000, 'test');
    n.feedLine(encodeVHW(knotsToMps(5), degToRad(45)), now + 2000, 'test');
    expect(n.getField('heading')?.value).toBeCloseTo(degToRad(90), 6);
  });

  it('derives apparent wind direction and true wind when the instruments do not send them', () => {
    const n = new Normalizer();
    const now = 1_700_000_000_000;
    n.feedLine(encodeHDT(degToRad(90)), now, 'test');
    n.feedLine(encodeMWV(degToRad(45), 8, 'R'), now, 'test');
    const i = n.instruments(now);
    expect(i.awd?.value).toBeCloseTo(degToRad(135), 6);
    expect(i.awd?.source).toBe('derived');
    // No SOG/COG: the boat is treated as stopped, so true equals apparent.
    // Wind speed round-trips through knots on the wire, hence the loose tolerance.
    expect(i.tws?.value).toBeCloseTo(8, 1);
    expect(i.twd?.value).toBeCloseTo(degToRad(135), 3);
    expect(i.twa?.value).toBeCloseTo(degToRad(45), 3);
    // Motoring north at 3 m/s into the same apparent wind changes the true wind.
    n.feedLine(encodeVTG(0, 3), now, 'test');
    const j = n.instruments(now);
    expect(j.tws?.value).not.toBeCloseTo(8, 1);
    expect(j.twd?.stale).toBe(false);
    // Once every input is old, the derived values are stale too.
    expect(n.instruments(now + 60_000).twd?.stale).toBe(true);
  });

  it('keeps instrument-provided true wind over the derived one', () => {
    const n = new Normalizer();
    const now = 1_700_000_000_000;
    n.feedLine(encodeHDT(0), now, 'test');
    n.feedLine(encodeMWV(degToRad(30), 6, 'R'), now, 'test');
    n.feedLine(encodeMWV(degToRad(50), 9, 'T'), now, 'test');
    const i = n.instruments(now);
    expect(i.tws?.value).toBeCloseTo(9, 1);
    expect(i.tws?.source).not.toBe('derived');
  });
});

describe('AIS tracks', () => {
  it('keeps an hour of positions per target and clears them on expiry', () => {
    const t = new AisTracker();
    const now = 1_700_000_000_000;
    // Class A position report for 244670316 (from the parser tests).
    const sentence = '!AIVDM,1,1,,A,13aEOK?P00PD2wVMdLDRhgvL289?,0*26';
    t.feed(sentence, false, now);
    t.feed(sentence, false, now + 5_000); // within the spacing: not recorded
    t.feed(sentence, false, now + 20_000);
    expect(t.track('244670316', now + 20_000).map((p) => p.at)).toEqual([now, now + 20_000]);
    t.feed(sentence, false, now + 30 * 60_000);
    t.feed(sentence, false, now + 70 * 60_000);
    // An hour later the first two have aged out.
    expect(t.track('244670316', now + 70 * 60_000).map((p) => p.at)).toEqual([
      now + 30 * 60_000,
      now + 70 * 60_000,
    ]);
    expect(t.track('nobody', now)).toEqual([]);
    t.prune(now + 101 * 60_000, 30 * 60_000);
    expect(t.all()).toEqual([]);
    expect(t.track('244670316', now + 101 * 60_000)).toEqual([]);
  });
});
