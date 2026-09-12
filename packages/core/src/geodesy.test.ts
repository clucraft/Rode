import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  angleDifference,
  bearingRad,
  destination,
  distanceM,
  distanceToPolygonEdgeM,
  fromLocalXY,
  normaliseAngle,
  normaliseRelativeAngle,
  offsetByHeading,
  pathEntersPolygon,
  pointInPolygon,
  projectPosition,
  toLocalXY,
} from './geodesy.js';
import { degToRad } from './units.js';
import type { LatLon } from './types.js';

// A real anchorage: Great Sound, Bermuda. Nothing special, just mid-latitude.
const A: LatLon = { lat: 32.29, lon: -64.83 };

const arbLatLon = fc.record({
  lat: fc.double({ min: -80, max: 80, noNaN: true }),
  lon: fc.double({ min: -179.9, max: 179.9, noNaN: true }),
});
const arbBearing = fc.double({ min: 0, max: 2 * Math.PI - 1e-9, noNaN: true });
const arbShortDistance = fc.double({ min: 0, max: 5000, noNaN: true });

describe('angles', () => {
  it('normalises to [0, 2π)', () => {
    expect(normaliseAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2);
    expect(normaliseAngle(2 * Math.PI)).toBeCloseTo(0);
    expect(normaliseAngle(7)).toBeCloseTo(7 - 2 * Math.PI);
  });

  it('normalises relative angles to (-π, π]', () => {
    expect(normaliseRelativeAngle(degToRad(350))).toBeCloseTo(degToRad(-10));
    expect(normaliseRelativeAngle(degToRad(180))).toBeCloseTo(Math.PI);
    expect(normaliseRelativeAngle(degToRad(-190))).toBeCloseTo(degToRad(170));
  });

  it('measures the smallest difference across the wrap', () => {
    expect(angleDifference(degToRad(10), degToRad(350))).toBeCloseTo(degToRad(20));
    expect(angleDifference(0, Math.PI)).toBeCloseTo(Math.PI);
  });
});

describe('distance and bearing', () => {
  it('is zero for identical points and symmetric', () => {
    expect(distanceM(A, A)).toBe(0);
    const b = destination(A, degToRad(45), 100);
    expect(distanceM(A, b)).toBeCloseTo(distanceM(b, A), 6);
  });

  it('matches a known 1 nm north displacement', () => {
    // One arc-minute of latitude is a nautical mile by definition (spherical).
    const b: LatLon = { lat: A.lat + 1 / 60, lon: A.lon };
    expect(distanceM(A, b)).toBeCloseTo(1853.2, 0);
    expect(bearingRad(A, b)).toBeCloseTo(0, 5);
  });

  it('gives cardinal bearings', () => {
    expect(bearingRad(A, { lat: A.lat, lon: A.lon + 0.01 })).toBeCloseTo(Math.PI / 2, 2);
    expect(bearingRad(A, { lat: A.lat - 0.01, lon: A.lon })).toBeCloseTo(Math.PI, 5);
    expect(bearingRad(A, { lat: A.lat, lon: A.lon - 0.01 })).toBeCloseTo((3 * Math.PI) / 2, 2);
  });

  it('destination → distance/bearing round-trips (property)', () => {
    fc.assert(
      fc.property(arbLatLon, arbBearing, arbShortDistance, (p, brg, d) => {
        fc.pre(d > 1);
        const q = destination(p, brg, d);
        expect(distanceM(p, q)).toBeCloseTo(d, 3);
        expect(angleDifference(bearingRad(p, q), brg)).toBeLessThan(1e-4);
      }),
      { numRuns: 300 },
    );
  });

  it('projectPosition is destination at sog × t', () => {
    const p = projectPosition(A, degToRad(90), 1, 60);
    expect(distanceM(A, p)).toBeCloseTo(60, 3);
  });
});

describe('offsetByHeading', () => {
  it('returns the input when there is no offset', () => {
    expect(offsetByHeading(A, 1.2, 0, 0)).toBe(A);
  });

  it('moves the point forward along the heading', () => {
    const p = offsetByHeading(A, degToRad(90), 10, 0);
    expect(distanceM(A, p)).toBeCloseTo(10, 3);
    expect(bearingRad(A, p)).toBeCloseTo(degToRad(90), 4);
  });

  it('moves the point to starboard of the heading', () => {
    const p = offsetByHeading(A, 0, 0, 3);
    expect(distanceM(A, p)).toBeCloseTo(3, 3);
    expect(bearingRad(A, p)).toBeCloseTo(degToRad(90), 4);
  });

  it('combines forward and starboard (bow roller 8 m fwd, 0.5 m stbd, heading 200°)', () => {
    const heading = degToRad(200);
    const p = offsetByHeading(A, heading, 8, 0.5);
    expect(distanceM(A, p)).toBeCloseTo(Math.hypot(8, 0.5), 3);
    const expected = normaliseAngle(heading + Math.atan2(0.5, 8));
    expect(angleDifference(bearingRad(A, p), expected)).toBeLessThan(1e-4);
  });
});

describe('local plane', () => {
  it('round-trips through toLocalXY/fromLocalXY', () => {
    fc.assert(
      fc.property(arbLatLon, arbBearing, arbShortDistance, (origin, brg, d) => {
        const p = destination(origin, brg, d);
        const xy = toLocalXY(origin, p);
        const back = fromLocalXY(origin, xy);
        expect(distanceM(p, back)).toBeLessThan(0.05);
      }),
      { numRuns: 200 },
    );
  });

  it('gives east/north metres', () => {
    const east = destination(A, degToRad(90), 100);
    const xy = toLocalXY(A, east);
    expect(xy.x).toBeCloseTo(100, 1);
    expect(Math.abs(xy.y)).toBeLessThan(0.1);
  });
});

describe('polygons', () => {
  // A 200 m square centred on A.
  const square: LatLon[] = [
    destination(A, degToRad(315), 141.4),
    destination(A, degToRad(45), 141.4),
    destination(A, degToRad(135), 141.4),
    destination(A, degToRad(225), 141.4),
  ];

  it('contains its centre and not a distant point', () => {
    expect(pointInPolygon(A, square)).toBe(true);
    expect(pointInPolygon(destination(A, 0, 500), square)).toBe(false);
  });

  it('rejects degenerate polygons', () => {
    expect(pointInPolygon(A, [A, A])).toBe(false);
  });

  it('measures distance to the nearest edge', () => {
    expect(distanceToPolygonEdgeM(A, square)).toBeCloseTo(100, 0);
    const outside = destination(A, 0, 150);
    expect(distanceToPolygonEdgeM(outside, square)).toBeCloseTo(50, 0);
  });

  it('detects a path that enters the polygon', () => {
    const from = destination(A, 0, 300);
    const to = destination(A, 0, 50);
    expect(pathEntersPolygon(from, to, square)).toBe(true);
    const past = destination(A, degToRad(90), 300);
    expect(pathEntersPolygon(from, past, square)).toBe(false);
  });

  it('is consistent with the local plane for random points (property)', () => {
    fc.assert(
      fc.property(arbBearing, fc.double({ min: 0, max: 300, noNaN: true }), (brg, d) => {
        const p = destination(A, brg, d);
        const xy = toLocalXY(A, p);
        const insideByBox = Math.abs(xy.x) < 100 && Math.abs(xy.y) < 100;
        // Skip points within a metre of the boundary: projection vs sphere.
        fc.pre(Math.abs(Math.abs(xy.x) - 100) > 1 && Math.abs(Math.abs(xy.y) - 100) > 1);
        expect(pointInPolygon(p, square)).toBe(insideByBox);
      }),
      { numRuns: 300 },
    );
  });
});
