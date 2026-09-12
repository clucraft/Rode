import { kelvinToCelsius, metresToFeet, mpsToKnots, radToDeg } from '@rode/core';
import type { Units } from '@rode/protocol';

/*
 * Display formatting. This is the *only* place SI turns into knots, feet and
 * degrees. Every function returns { value, unit } so the UI can size the
 * number and the unit differently. Numbers use tabular figures via CSS.
 */

export const DEFAULT_UNITS: Units = {
  distance: 'm',
  depth: 'm',
  speed: 'kn',
  temperature: 'C',
  rode: 'm',
};

export interface Formatted {
  value: string;
  unit: string;
  /** Screen-reader friendly, e.g. "42 metres". */
  label: string;
}

const DASH: Formatted = { value: '—', unit: '', label: 'no data' };

function fixed(v: number, dp: number): string {
  return v.toFixed(dp);
}

export function fmtDistance(m: number | null | undefined, units: Units, dp?: number): Formatted {
  if (m === null || m === undefined || !Number.isFinite(m)) return DASH;
  if (units.distance === 'ft') {
    const ft = metresToFeet(m);
    const d = dp ?? (Math.abs(ft) >= 100 ? 0 : 1);
    return { value: fixed(ft, d), unit: 'ft', label: `${fixed(ft, d)} feet` };
  }
  const d = dp ?? (Math.abs(m) >= 100 ? 0 : 1);
  return { value: fixed(m, d), unit: 'm', label: `${fixed(m, d)} metres` };
}

/** Rode length uses its own unit setting: many boats count chain in feet. */
export function fmtRode(m: number | null | undefined, units: Units): Formatted {
  if (m === null || m === undefined || !Number.isFinite(m)) return DASH;
  if (units.rode === 'ft') {
    const ft = metresToFeet(m);
    return { value: fixed(ft, 0), unit: 'ft', label: `${fixed(ft, 0)} feet of rode` };
  }
  return { value: fixed(m, m >= 100 ? 0 : 1), unit: 'm', label: `${fixed(m, 1)} metres of rode` };
}

export function fmtDepth(m: number | null | undefined, units: Units): Formatted {
  if (m === null || m === undefined || !Number.isFinite(m)) return DASH;
  switch (units.depth) {
    case 'ft': {
      const ft = metresToFeet(m);
      return { value: fixed(ft, 1), unit: 'ft', label: `${fixed(ft, 1)} feet` };
    }
    case 'fathoms': {
      const fm = m / 1.8288;
      return { value: fixed(fm, 1), unit: 'fm', label: `${fixed(fm, 1)} fathoms` };
    }
    default:
      return { value: fixed(m, 1), unit: 'm', label: `${fixed(m, 1)} metres` };
  }
}

export function fmtSpeed(mps: number | null | undefined, units: Units, dp = 1): Formatted {
  if (mps === null || mps === undefined || !Number.isFinite(mps)) return DASH;
  switch (units.speed) {
    case 'm/s':
      return { value: fixed(mps, dp), unit: 'm/s', label: `${fixed(mps, dp)} metres per second` };
    case 'km/h':
      return {
        value: fixed(mps * 3.6, dp),
        unit: 'km/h',
        label: `${fixed(mps * 3.6, dp)} kilometres per hour`,
      };
    case 'mph':
      return {
        value: fixed(mps * 2.23694, dp),
        unit: 'mph',
        label: `${fixed(mps * 2.23694, dp)} miles per hour`,
      };
    default: {
      const kn = mpsToKnots(mps);
      return { value: fixed(kn, dp), unit: 'kn', label: `${fixed(kn, dp)} knots` };
    }
  }
}

export function fmtTemp(k: number | null | undefined, units: Units): Formatted {
  if (k === null || k === undefined || !Number.isFinite(k)) return DASH;
  const c = kelvinToCelsius(k);
  if (units.temperature === 'F') {
    const f = (c * 9) / 5 + 32;
    return { value: fixed(f, 1), unit: '°F', label: `${fixed(f, 1)} degrees Fahrenheit` };
  }
  return { value: fixed(c, 1), unit: '°C', label: `${fixed(c, 1)} degrees Celsius` };
}

/** Bearing / heading / course: three digits true. */
export function fmtBearing(rad: number | null | undefined): Formatted {
  if (rad === null || rad === undefined || !Number.isFinite(rad)) return DASH;
  const deg = ((radToDeg(rad) % 360) + 360) % 360;
  const v = String(Math.round(deg) % 360).padStart(3, '0');
  return { value: v, unit: '°T', label: `${v} degrees true` };
}

/** Relative angle such as apparent wind: "045 S" / "030 P". */
export function fmtRelativeAngle(rad: number | null | undefined): Formatted {
  if (rad === null || rad === undefined || !Number.isFinite(rad)) return DASH;
  const deg = radToDeg(rad);
  const side = deg < 0 ? 'P' : 'S';
  const v = String(Math.round(Math.abs(deg))).padStart(3, '0');
  return { value: v, unit: `°${side}`, label: `${v} degrees to ${deg < 0 ? 'port' : 'starboard'}` };
}

export function fmtScope(ratio: number | null | undefined): Formatted {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return DASH;
  if (ratio > 99) return { value: '99+', unit: ':1', label: 'scope over 99 to 1' };
  return { value: fixed(ratio, 1), unit: ':1', label: `scope ${fixed(ratio, 1)} to 1` };
}

export function fmtPercent(fraction: number | null | undefined): Formatted {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return DASH;
  const v = Math.round(fraction * 100);
  return { value: String(v), unit: '%', label: `${v} percent` };
}

export function fmtVoltage(v: number | null | undefined): Formatted {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return { value: fixed(v, 2), unit: 'V', label: `${fixed(v, 2)} volts` };
}

export function fmtWatts(w: number | null | undefined): Formatted {
  if (w === null || w === undefined || !Number.isFinite(w)) return DASH;
  return { value: fixed(w, 0), unit: 'W', label: `${fixed(w, 0)} watts` };
}

export function fmtPressure(pa: number | null | undefined): Formatted {
  if (pa === null || pa === undefined || !Number.isFinite(pa)) return DASH;
  return { value: fixed(pa / 100, 1), unit: 'hPa', label: `${fixed(pa / 100, 1)} hectopascals` };
}

export function fmtLatLon(pos: { lat: number; lon: number } | null | undefined): string {
  if (!pos) return '—';
  const f = (v: number, pos: string, neg: string) => {
    const abs = Math.abs(v);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    return `${deg}° ${min.toFixed(3)}′ ${v < 0 ? neg : pos}`;
  };
  return `${f(pos.lat, 'N', 'S')}  ${f(pos.lon, 'E', 'W')}`;
}

/** "3 s", "2 min", "1 h 05" — for ages and durations. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h} h ${String(rm).padStart(2, '0')}`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

export function fmtTime(epochMs: number | null | undefined, tz?: string): string {
  if (!epochMs) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      ...(tz ? { timeZone: tz } : {}),
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString().slice(11, 19);
  }
}

export function fmtDateTime(epochMs: number | null | undefined, tz?: string): string {
  if (!epochMs) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      hourCycle: 'h23',
      ...(tz ? { timeZone: tz } : {}),
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString();
  }
}

/** Convert a display-unit value back to SI for settings inputs. */
export function toSiDistance(v: number, units: Units): number {
  return units.distance === 'ft' ? v * 0.3048 : v;
}
export function fromSiDistance(m: number, units: Units): number {
  return units.distance === 'ft' ? metresToFeet(m) : m;
}
export function toSiSpeed(v: number, units: Units): number {
  switch (units.speed) {
    case 'm/s':
      return v;
    case 'km/h':
      return v / 3.6;
    case 'mph':
      return v / 2.23694;
    default:
      return (v * 1852) / 3600;
  }
}
export function fromSiSpeed(mps: number, units: Units): number {
  switch (units.speed) {
    case 'm/s':
      return mps;
    case 'km/h':
      return mps * 3.6;
    case 'mph':
      return mps * 2.23694;
    default:
      return mpsToKnots(mps);
  }
}
export function speedUnitLabel(units: Units): string {
  return units.speed;
}
export function distanceUnitLabel(units: Units): string {
  return units.distance;
}

const NM_M = 1852;

/**
 * Range to another vessel: the configured distance unit close in, nautical
 * miles once it stops being a number anyone thinks in (over 1000 ft, or
 * 1000 m for metric boats).
 */
export function fmtRange(m: number | null | undefined, units: Units): Formatted {
  if (m === null || m === undefined || !Number.isFinite(m)) return DASH;
  const limit = units.distance === 'ft' ? 1000 * 0.3048 : 1000;
  if (m <= limit) return fmtDistance(m, units, 0);
  const nm = m / NM_M;
  const d = nm >= 10 ? 1 : 2;
  return { value: fixed(nm, d), unit: 'nm', label: `${fixed(nm, d)} nautical miles` };
}
