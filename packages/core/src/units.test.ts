import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  celsiusToKelvin,
  degToRad,
  feetToMetres,
  kelvinToCelsius,
  knotsToMps,
  metresToFeet,
  mpsToKnots,
  radToDeg,
} from './units.js';

describe('units', () => {
  it('converts knots to m/s using the exact nautical mile', () => {
    expect(knotsToMps(1)).toBeCloseTo(0.514444, 6);
    expect(mpsToKnots(0.514444)).toBeCloseTo(1, 5);
  });

  it('converts degrees and radians', () => {
    expect(degToRad(180)).toBeCloseTo(Math.PI);
    expect(radToDeg(Math.PI / 2)).toBeCloseTo(90);
  });

  it('converts feet and metres', () => {
    expect(feetToMetres(1)).toBe(0.3048);
    expect(metresToFeet(0.3048)).toBeCloseTo(1);
  });

  it('converts celsius and kelvin', () => {
    expect(celsiusToKelvin(0)).toBe(273.15);
    expect(kelvinToCelsius(273.15)).toBe(0);
  });

  it('round-trips every conversion pair (property)', () => {
    const finite = fc.double({ min: -1e6, max: 1e6, noNaN: true });
    fc.assert(fc.property(finite, (x) => Math.abs(mpsToKnots(knotsToMps(x)) - x) < 1e-6));
    fc.assert(fc.property(finite, (x) => Math.abs(radToDeg(degToRad(x)) - x) < 1e-6));
    fc.assert(fc.property(finite, (x) => Math.abs(metresToFeet(feetToMetres(x)) - x) < 1e-6));
    fc.assert(fc.property(finite, (x) => Math.abs(kelvinToCelsius(celsiusToKelvin(x)) - x) < 1e-6));
  });
});
