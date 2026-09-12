import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DEFAULT_ALARM_CONFIG, type AlarmConfig } from './config.js';
import { destination, distanceM } from './geodesy.js';
import { bowRollerPosition, computeAnchorGeometry, suggestedRode } from './geometry.js';
import type { BoatGeometry, LatLon } from './types.js';
import { degToRad } from './units.js';

const A: LatLon = { lat: 32.29, lon: -64.83 };
const boat: BoatGeometry = {
  antennaToBowForward: 9,
  antennaToBowStarboard: 0,
  bowRollerHeight: 1.2,
};

function geometry(
  overrides: Partial<{
    run: number;
    depth: number;
    tide: number;
    hdop: number | null;
    config: Partial<AlarmConfig>;
    bowRollerHeight: number;
  }> = {},
) {
  const run = overrides.run ?? 40;
  const setPosition = destination(A, degToRad(30), run);
  return computeAnchorGeometry({
    anchor: A,
    setPosition,
    depthAtDrop: overrides.depth ?? 6,
    tideRange: overrides.tide ?? 0,
    hdop: overrides.hdop ?? null,
    boat: { ...boat, bowRollerHeight: overrides.bowRollerHeight ?? boat.bowRollerHeight },
    config: { ...DEFAULT_ALARM_CONFIG, ...overrides.config },
  });
}

describe('computeAnchorGeometry', () => {
  it('computes the rode triangle from measured run and captured depth', () => {
    // 40 m run, 6 m depth + 1.2 m roller = 7.2 m vertical.
    const g = geometry();
    expect(g.horizontalRun).toBeCloseTo(40, 2);
    expect(g.verticalDrop).toBeCloseTo(7.2, 6);
    expect(g.rodeLength).toBeCloseTo(Math.hypot(40, 7.2), 2);
    expect(g.scopeRatio).toBeCloseTo(Math.hypot(40, 7.2) / 7.2, 2);
    expect(g.scopeRatioAtHighWater).toBeCloseTo(g.scopeRatio, 6);
  });

  it('applies the absolute swing margin and warn distance', () => {
    const g = geometry();
    expect(g.hdopMargin).toBe(0);
    expect(g.swingMargin).toBe(15);
    expect(g.swingRadius).toBeCloseTo(40 + 15, 2);
    expect(g.warnRadius).toBeCloseTo(40 + 15 - 10, 2);
  });

  it('widens the margin with HDOP, capped', () => {
    expect(geometry({ hdop: 2 }).hdopMargin).toBe(6);
    expect(geometry({ hdop: 50 }).hdopMargin).toBe(DEFAULT_ALARM_CONFIG.hdopMarginCap);
    expect(geometry({ hdop: 0 }).hdopMargin).toBe(0);
    expect(geometry({ hdop: Number.NaN }).hdopMargin).toBe(0);
  });

  it('reports the worst-case scope at high water and widens the circle for low water', () => {
    const g0 = geometry({ tide: 0 });
    const g2 = geometry({ tide: 2 });
    expect(g2.scopeRatioAtHighWater).toBeLessThan(g0.scopeRatio);
    expect(g2.scopeRatioAtHighWater).toBeCloseTo(g2.rodeLength / (7.2 + 2), 6);
    expect(g2.swingRadius).toBeGreaterThan(g0.swingRadius);
    // With 2 m less water the same rode reaches sqrt(L² - 5.2²) horizontally.
    expect(g2.swingRadius).toBeCloseTo(Math.sqrt(g2.rodeLength ** 2 - 5.2 ** 2) + 15, 2);
  });

  it('never divides by zero on a zero vertical leg', () => {
    const g = geometry({ depth: 0, bowRollerHeight: 0 });
    expect(g.scopeRatio).toBe(Number.POSITIVE_INFINITY);
    expect(g.rodeLength).toBeCloseTo(40, 2);
  });

  it('records the bearing from anchor to boat', () => {
    expect(geometry().bearingAnchorToBoat).toBeCloseTo(degToRad(30), 3);
    expect(geometry({ run: 0 }).bearingAnchorToBoat).toBe(0);
  });

  it('echoes its inputs', () => {
    const g = geometry({ depth: 8, tide: 1, hdop: 1.5 });
    expect(g.depthAtDrop).toBe(8);
    expect(g.bowRollerHeight).toBe(1.2);
    expect(g.tideRange).toBe(1);
    expect(g.hdopAtSet).toBe(1.5);
  });

  describe('properties', () => {
    const arbRun = fc.double({ min: 0, max: 200, noNaN: true });
    const arbDepth = fc.double({ min: 0, max: 60, noNaN: true });
    const arbTide = fc.double({ min: 0, max: 10, noNaN: true });
    const arbMargin = fc.double({ min: 0, max: 100, noNaN: true });

    it('rode is never less than the vertical drop or the horizontal run', () => {
      fc.assert(
        fc.property(arbRun, arbDepth, (run, depth) => {
          const g = geometry({ run, depth });
          expect(g.rodeLength).toBeGreaterThanOrEqual(g.verticalDrop - 1e-9);
          expect(g.rodeLength).toBeGreaterThanOrEqual(g.horizontalRun - 1e-9);
        }),
      );
    });

    it('scope is at least 1:1', () => {
      fc.assert(
        fc.property(arbRun, arbDepth, (run, depth) => {
          expect(geometry({ run, depth }).scopeRatio).toBeGreaterThanOrEqual(1);
        }),
      );
    });

    it('swing radius is monotonic in swing margin', () => {
      fc.assert(
        fc.property(arbRun, arbDepth, arbMargin, arbMargin, (run, depth, m1, m2) => {
          const [lo, hi] = m1 <= m2 ? [m1, m2] : [m2, m1];
          const a = geometry({ run, depth, config: { swingMargin: lo } });
          const b = geometry({ run, depth, config: { swingMargin: hi } });
          expect(b.swingRadius).toBeGreaterThanOrEqual(a.swingRadius - 1e-9);
        }),
      );
    });

    it('swing radius is monotonic in tide range and high-water scope is not more than scope', () => {
      fc.assert(
        fc.property(arbRun, arbDepth, arbTide, arbTide, (run, depth, t1, t2) => {
          const [lo, hi] = t1 <= t2 ? [t1, t2] : [t2, t1];
          const a = geometry({ run, depth, tide: lo });
          const b = geometry({ run, depth, tide: hi });
          expect(b.swingRadius).toBeGreaterThanOrEqual(a.swingRadius - 1e-9);
          expect(b.scopeRatioAtHighWater).toBeLessThanOrEqual(b.scopeRatio + 1e-9);
        }),
      );
    });

    it('swing radius always contains the set position', () => {
      fc.assert(
        fc.property(arbRun, arbDepth, arbTide, (run, depth, tide) => {
          const g = geometry({ run, depth, tide });
          expect(g.swingRadius).toBeGreaterThanOrEqual(g.horizontalRun - 1e-9);
          expect(g.warnRadius).toBeLessThanOrEqual(g.swingRadius);
        }),
      );
    });
  });
});

describe('suggestedRode', () => {
  it('multiplies depth plus roller height by the target scope', () => {
    expect(suggestedRode(6, 1.2, 5)).toBeCloseTo(36);
    expect(suggestedRode(-3, 1.2, 5)).toBe(0);
  });
});

describe('bowRollerPosition', () => {
  it('uses the antenna position and flags it when heading is missing', () => {
    const r = bowRollerPosition(A, null, boat);
    expect(r.position).toBe(A);
    expect(r.corrected).toBe(false);
  });

  it('offsets to the bow roller along the heading', () => {
    const r = bowRollerPosition(A, degToRad(0), boat);
    expect(r.corrected).toBe(true);
    expect(distanceM(A, r.position)).toBeCloseTo(9, 3);
    expect(r.position.lat).toBeGreaterThan(A.lat);
  });

  it('reports no correction when the offsets are zero', () => {
    const r = bowRollerPosition(A, 1, { ...boat, antennaToBowForward: 0 });
    expect(r.corrected).toBe(false);
  });
});
