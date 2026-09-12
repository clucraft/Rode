import { describe, expect, it } from 'vitest';
import { destination } from './geodesy.js';
import type { LatLon } from './types.js';
import { degToRad, knotsToMps } from './units.js';
import { evaluateZone, validateZonePolygon, type ExclusionZone } from './zones.js';

const A: LatLon = { lat: 32.29, lon: -64.83 };

// 200 m square centred on A.
const square: LatLon[] = [
  destination(A, degToRad(315), 141.4),
  destination(A, degToRad(45), 141.4),
  destination(A, degToRad(135), 141.4),
  destination(A, degToRad(225), 141.4),
];

const reef: ExclusionZone = {
  id: 'reef',
  name: 'Reef',
  kind: 'never-enter',
  enabled: true,
  polygon: square,
};
const fairway: ExclusionZone = {
  ...reef,
  id: 'fairway',
  name: 'Fairway',
  kind: 'must-stay-inside',
};

describe('evaluateZone', () => {
  it('flags a never-enter breach when inside', () => {
    const ev = evaluateZone(reef, A, null, null, 300_000);
    expect(ev.breached).toBe(true);
    expect(ev.projected).toBe(false);
    expect(ev.distanceToEdge).toBeCloseTo(100, 0);
  });

  it('does not flag a never-enter zone when outside and stationary', () => {
    const ev = evaluateZone(reef, destination(A, 0, 300), null, null, 300_000);
    expect(ev.breached).toBe(false);
    expect(ev.projected).toBe(false);
  });

  it('flags a must-stay breach when outside', () => {
    expect(evaluateZone(fairway, destination(A, 0, 300), null, null, 0).breached).toBe(true);
    expect(evaluateZone(fairway, A, null, null, 0).breached).toBe(false);
  });

  it('projects entry along the current course', () => {
    // 300 m north of the reef, heading south at 2 kn: 200 m to the edge ≈ 194 s.
    const boat = destination(A, 0, 300);
    const ev = evaluateZone(reef, boat, degToRad(180), knotsToMps(2), 300_000);
    expect(ev.breached).toBe(false);
    expect(ev.projected).toBe(true);
    expect(ev.secondsToBreach).toBeGreaterThan(150);
    expect(ev.secondsToBreach).toBeLessThan(250);
  });

  it('does not project when heading away or when the look-ahead is too short', () => {
    const boat = destination(A, 0, 300);
    expect(evaluateZone(reef, boat, 0, knotsToMps(2), 300_000).projected).toBe(false);
    expect(evaluateZone(reef, boat, degToRad(180), knotsToMps(2), 10_000).projected).toBe(false);
  });

  it('ignores COG when SOG is inside GPS noise', () => {
    const boat = destination(A, 0, 120);
    expect(evaluateZone(reef, boat, degToRad(180), 0.05, 300_000).projected).toBe(false);
  });

  it('projects leaving a must-stay zone', () => {
    const boat = destination(A, 0, 50);
    const ev = evaluateZone(fairway, boat, 0, knotsToMps(2), 300_000);
    expect(ev.projected).toBe(true);
  });
});

describe('validateZonePolygon', () => {
  it('accepts a proper ring', () => {
    expect(validateZonePolygon(square)).toBeNull();
  });

  it('rejects too few, invalid and degenerate points', () => {
    expect(validateZonePolygon([A, A])).toMatch(/three/);
    expect(validateZonePolygon([A, A, { lat: Number.NaN, lon: 0 }])).toMatch(/invalid/);
    expect(validateZonePolygon([A, A, { lat: 91, lon: 0 }])).toMatch(/range/);
    expect(validateZonePolygon([A, A, A])).toMatch(/same place/);
  });
});
