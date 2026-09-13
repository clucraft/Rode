import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { degToRad, radToDeg } from './units.js';
import { apparentWindDirection, trueWind } from './wind.js';

describe('wind', () => {
  it('apparent direction is heading plus angle, wrapped', () => {
    expect(radToDeg(apparentWindDirection(degToRad(30), degToRad(350)))).toBeCloseTo(20, 6);
    expect(radToDeg(apparentWindDirection(degToRad(-40), degToRad(10)))).toBeCloseTo(330, 6);
  });

  it('a stopped boat feels the true wind', () => {
    const t = trueWind({ awa: degToRad(45), aws: 8, heading: degToRad(90), speed: 0, course: 0 });
    expect(t.tws).toBeCloseTo(8, 6);
    expect(radToDeg(t.twd)).toBeCloseTo(135, 6);
    expect(radToDeg(t.twa)).toBeCloseTo(45, 6);
  });

  it('motoring dead upwind: true wind is apparent minus boat speed', () => {
    // Heading north into a 10 m/s northerly at 3 m/s: masthead feels 13 m/s from ahead.
    const t = trueWind({ awa: 0, aws: 13, heading: 0, speed: 3, course: 0 });
    expect(t.tws).toBeCloseTo(10, 6);
    expect(radToDeg(t.twd)).toBeCloseTo(0, 6);
  });

  it('running dead downwind: true wind is apparent plus boat speed, from astern', () => {
    const t = trueWind({ awa: Math.PI, aws: 4, heading: 0, speed: 3, course: 0 });
    expect(t.tws).toBeCloseTo(7, 6);
    expect(radToDeg(t.twd)).toBeCloseTo(180, 6);
    expect(Math.abs(radToDeg(t.twa))).toBeCloseTo(180, 6);
  });

  it('beam reach example from the textbook', () => {
    // True wind 10 m/s from the east (90°), boat heading north at 5 m/s.
    // Apparent: air moves west (−x) at 10, boat moves north (+y) at 5 →
    // relative air velocity (−10, −5): from 63.4° at 11.18 m/s, i.e. AWA +63.4°.
    const t = trueWind({
      awa: Math.atan2(10, 5),
      aws: Math.hypot(10, 5),
      heading: 0,
      speed: 5,
      course: 0,
    });
    expect(t.tws).toBeCloseTo(10, 6);
    expect(radToDeg(t.twd)).toBeCloseTo(90, 6);
    expect(radToDeg(t.twa)).toBeCloseTo(90, 6);
  });

  it('round-trips: true wind folded into any boat motion comes back out', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.5, max: 30, noNaN: true }),
        fc.double({ min: 0, max: 2 * Math.PI - 1e-6, noNaN: true }),
        fc.double({ min: 0, max: 2 * Math.PI - 1e-6, noNaN: true }),
        fc.double({ min: 0, max: 8, noNaN: true }),
        fc.double({ min: 0, max: 2 * Math.PI - 1e-6, noNaN: true }),
        (tws, twd, heading, speed, course) => {
          // Build the apparent wind the masthead would see, then invert it.
          const tx = tws * Math.sin(twd + Math.PI);
          const ty = tws * Math.cos(twd + Math.PI);
          const rx = tx - speed * Math.sin(course);
          const ry = ty - speed * Math.cos(course);
          const aws = Math.hypot(rx, ry);
          if (aws < 0.5) return; // apparent calm: direction is undefined
          const awd = Math.atan2(rx, ry) + Math.PI;
          let awa = awd - heading;
          while (awa > Math.PI) awa -= 2 * Math.PI;
          while (awa <= -Math.PI) awa += 2 * Math.PI;
          const t = trueWind({ awa, aws, heading, speed, course });
          expect(t.tws).toBeCloseTo(tws, 6);
          const diff = Math.abs(((t.twd - twd + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
          expect(diff).toBeLessThan(1e-6);
        },
      ),
    );
  });
});
