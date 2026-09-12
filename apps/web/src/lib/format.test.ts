import { describe, expect, it } from 'vitest';
import { knotsToMps } from '@rode/core';
import {
  DEFAULT_UNITS,
  fmtBearing,
  fmtDepth,
  fmtDistance,
  fmtDuration,
  fmtLatLon,
  fmtRelativeAngle,
  fmtScope,
  fmtSpeed,
  fmtTemp,
  fromSiSpeed,
  toSiDistance,
  toSiSpeed,
} from './format.js';
import { inNightWindow } from './theme.js';

const ft = {
  ...DEFAULT_UNITS,
  distance: 'ft' as const,
  depth: 'ft' as const,
  speed: 'mph' as const,
  temperature: 'F' as const,
  rode: 'ft' as const,
};

describe('format', () => {
  it('formats distance in the chosen unit with sensible precision', () => {
    expect(fmtDistance(42.35, DEFAULT_UNITS)).toEqual({
      value: '42.4',
      unit: 'm',
      label: '42.4 metres',
    });
    expect(fmtDistance(142.35, DEFAULT_UNITS).value).toBe('142');
    expect(fmtDistance(30.48, ft)).toEqual({ value: '100', unit: 'ft', label: '100 feet' });
    expect(fmtDistance(3.048, ft).value).toBe('10.0');
    expect(fmtDistance(null, DEFAULT_UNITS).value).toBe('—');
  });

  it('formats depth, speed and temperature', () => {
    expect(fmtDepth(5.4864, ft).value).toBe('18.0');
    expect(fmtSpeed(knotsToMps(1.2), DEFAULT_UNITS)).toMatchObject({ value: '1.2', unit: 'kn' });
    expect(fmtSpeed(1, ft)).toMatchObject({ value: '2.2', unit: 'mph' });
    expect(fmtTemp(273.15, DEFAULT_UNITS).value).toBe('0.0');
    expect(fmtTemp(273.15, ft).value).toBe('32.0');
  });

  it('formats bearings as three digits and relative angles with side', () => {
    expect(fmtBearing(0).value).toBe('000');
    expect(fmtBearing(Math.PI).value).toBe('180');
    expect(fmtBearing(-Math.PI / 2).value).toBe('270');
    expect(fmtRelativeAngle(-0.5)).toMatchObject({ value: '029', unit: '°P' });
    expect(fmtRelativeAngle(0.5)).toMatchObject({ value: '029', unit: '°S' });
  });

  it('formats scope and durations', () => {
    expect(fmtScope(5.66).value).toBe('5.7');
    expect(fmtScope(Number.POSITIVE_INFINITY).value).toBe('99+');
    expect(fmtDuration(4000)).toBe('4 s');
    expect(fmtDuration(125_000)).toBe('2 min');
    expect(fmtDuration(3_900_000)).toBe('1 h 05');
    expect(fmtDuration(2 * 86_400_000)).toBe('2 d 0 h');
  });

  it('formats positions in degrees and decimal minutes', () => {
    expect(fmtLatLon({ lat: 32.29, lon: -64.83 })).toBe('32° 17.400′ N  64° 49.800′ W');
  });

  it('round-trips settings values through display units', () => {
    expect(toSiDistance(100, ft)).toBeCloseTo(30.48);
    expect(fromSiSpeed(toSiSpeed(5, DEFAULT_UNITS), DEFAULT_UNITS)).toBeCloseTo(5);
    expect(fromSiSpeed(toSiSpeed(5, ft), ft)).toBeCloseTo(5);
  });
});

describe('night window', () => {
  const at = (h: number, m = 0) => {
    const d = new Date(2026, 8, 11, h, m);
    return d;
  };
  it('handles a window crossing midnight', () => {
    expect(inNightWindow(at(22), '20:00', '06:00')).toBe(true);
    expect(inNightWindow(at(3), '20:00', '06:00')).toBe(true);
    expect(inNightWindow(at(12), '20:00', '06:00')).toBe(false);
    expect(inNightWindow(at(6), '20:00', '06:00')).toBe(false);
  });
  it('handles a same-day window', () => {
    expect(inNightWindow(at(2), '01:00', '05:00')).toBe(true);
    expect(inNightWindow(at(7), '01:00', '05:00')).toBe(false);
  });
});
