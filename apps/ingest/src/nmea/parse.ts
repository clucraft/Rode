import { celsiusToKelvin, degToRad, feetToMetres, knotsToMps, METRES_PER_FATHOM } from '@rode/core';
import type { RawSentence } from './sentence.js';

/*
 * Sentence-level parsers. Output is SI (metres, m/s, radians, kelvin) so the
 * conversion from NMEA's knots / degrees / feet / celsius happens in exactly
 * one place. Missing fields become null rather than NaN.
 */

export interface UtcTime {
  hour: number;
  minute: number;
  second: number;
  /** Fractional seconds, 0..999. */
  millisecond: number;
}

export interface UtcDate {
  year: number;
  month: number;
  day: number;
}

export interface XdrMeasurement {
  /** Transducer type letter: C temperature, U voltage, V volume, P pressure/percent, etc. */
  type: string;
  value: number | null;
  unit: string;
  name: string;
}

export type ParsedSentence =
  | {
      type: 'GGA';
      time: UtcTime | null;
      lat: number | null;
      lon: number | null;
      fixQuality: number | null;
      satellites: number | null;
      hdop: number | null;
      altitude: number | null;
    }
  | {
      type: 'RMC';
      time: UtcTime | null;
      date: UtcDate | null;
      valid: boolean;
      lat: number | null;
      lon: number | null;
      /** m/s */
      sog: number | null;
      /** radians true */
      cog: number | null;
      /** radians, east positive */
      magneticVariation: number | null;
    }
  | { type: 'GLL'; time: UtcTime | null; valid: boolean; lat: number | null; lon: number | null }
  | { type: 'VTG'; cogTrue: number | null; cogMagnetic: number | null; sog: number | null }
  | {
      /** Water speed and heading from the log: $--VHW,hdgT,T,hdgM,M,kn,N,km/h,K */
      type: 'VHW';
      headingTrue: number | null;
      headingMagnetic: number | null;
      /** m/s */
      stw: number | null;
    }
  | { type: 'ZDA'; time: UtcTime | null; date: UtcDate | null }
  | {
      type: 'HDG';
      /** radians magnetic (sensor reading) */
      headingMagnetic: number | null;
      deviation: number | null;
      variation: number | null;
    }
  | { type: 'HDT'; headingTrue: number | null }
  | { type: 'HDM'; headingMagnetic: number | null }
  | { type: 'DBT'; depthBelowTransducer: number | null }
  | {
      type: 'DPT';
      depthBelowTransducer: number | null;
      /** Positive: transducer to waterline. Negative: transducer to keel. */
      offset: number | null;
    }
  | {
      type: 'MWV';
      reference: 'apparent' | 'true';
      /** radians, 0..2π clockwise from the bow */
      angle: number | null;
      /** m/s */
      speed: number | null;
      valid: boolean;
    }
  | {
      type: 'MWD';
      directionTrue: number | null;
      directionMagnetic: number | null;
      speed: number | null;
    }
  | {
      type: 'VWR';
      /** radians, -π..π, positive to starboard */
      angle: number | null;
      speed: number | null;
    }
  | { type: 'MTW'; waterTemperature: number | null }
  | {
      type: 'MDA';
      airTemperature: number | null;
      waterTemperature: number | null;
      /** pascals */
      pressure: number | null;
      relativeHumidity: number | null;
      windDirectionTrue: number | null;
      windSpeed: number | null;
    }
  | { type: 'XDR'; measurements: XdrMeasurement[] }
  | {
      type: 'VDM' | 'VDO';
      fragments: number;
      fragment: number;
      sequenceId: string;
      channel: string;
      payload: string;
      fillBits: number;
    };

export type ParseResult =
  | { ok: true; sentence: ParsedSentence }
  | { ok: false; reason: 'unsupported' | 'malformed'; type: string };

const SUPPORTED = new Set([
  'GGA',
  'RMC',
  'GLL',
  'VTG',
  'VHW',
  'ZDA',
  'HDG',
  'HDT',
  'HDM',
  'DBT',
  'DPT',
  'MWV',
  'MWD',
  'VWR',
  'MTW',
  'MDA',
  'XDR',
  'VDM',
  'VDO',
]);

export function isSupportedType(type: string): boolean {
  return SUPPORTED.has(type);
}

export function parseSentence(s: RawSentence): ParseResult {
  const f = s.fields;
  const get = (i: number): string => f[i] ?? '';
  try {
    switch (s.type) {
      case 'GGA':
        return ok({
          type: 'GGA',
          time: parseTime(get(0)),
          lat: parseLat(get(1), get(2)),
          lon: parseLon(get(3), get(4)),
          fixQuality: int(get(5)),
          satellites: int(get(6)),
          hdop: num(get(7)),
          altitude: num(get(8)),
        });
      case 'RMC': {
        const valid = get(1) === 'A';
        const varDeg = num(get(9));
        return ok({
          type: 'RMC',
          time: parseTime(get(0)),
          date: parseDate(get(8)),
          valid,
          lat: parseLat(get(2), get(3)),
          lon: parseLon(get(4), get(5)),
          sog: mapNum(num(get(6)), knotsToMps),
          cog: mapNum(num(get(7)), degToRad),
          magneticVariation: varDeg === null ? null : degToRad(get(10) === 'W' ? -varDeg : varDeg),
        });
      }
      case 'GLL':
        return ok({
          type: 'GLL',
          time: parseTime(get(4)),
          valid: get(5) === 'A',
          lat: parseLat(get(0), get(1)),
          lon: parseLon(get(2), get(3)),
        });
      case 'VTG':
        return ok({
          type: 'VTG',
          cogTrue: mapNum(num(get(0)), degToRad),
          cogMagnetic: mapNum(num(get(2)), degToRad),
          sog: mapNum(num(get(4)), knotsToMps),
        });
      case 'VHW':
        return ok({
          type: 'VHW',
          headingTrue: mapNum(num(get(0)), degToRad),
          headingMagnetic: mapNum(num(get(2)), degToRad),
          stw: mapNum(num(get(4)), knotsToMps),
        });
      case 'ZDA': {
        const day = int(get(1));
        const month = int(get(2));
        const year = int(get(3));
        return ok({
          type: 'ZDA',
          time: parseTime(get(0)),
          date: day !== null && month !== null && year !== null ? { year, month, day } : null,
        });
      }
      case 'HDG': {
        const dev = num(get(1));
        const vari = num(get(3));
        return ok({
          type: 'HDG',
          headingMagnetic: mapNum(num(get(0)), degToRad),
          deviation: dev === null ? null : degToRad(get(2) === 'W' ? -dev : dev),
          variation: vari === null ? null : degToRad(get(4) === 'W' ? -vari : vari),
        });
      }
      case 'HDT':
        return ok({ type: 'HDT', headingTrue: mapNum(num(get(0)), degToRad) });
      case 'HDM':
        return ok({ type: 'HDM', headingMagnetic: mapNum(num(get(0)), degToRad) });
      case 'DBT': {
        const metres = num(get(2));
        const feet = num(get(0));
        const fathoms = num(get(4));
        const depth =
          metres ??
          (feet !== null ? feetToMetres(feet) : null) ??
          (fathoms !== null ? fathoms * METRES_PER_FATHOM : null);
        return ok({ type: 'DBT', depthBelowTransducer: depth });
      }
      case 'DPT':
        return ok({ type: 'DPT', depthBelowTransducer: num(get(0)), offset: num(get(1)) });
      case 'MWV': {
        const angle = num(get(0));
        return ok({
          type: 'MWV',
          reference: get(1) === 'T' ? 'true' : 'apparent',
          angle: angle === null ? null : degToRad(angle),
          speed: windSpeed(num(get(2)), get(3)),
          valid: get(4) === 'A' || get(4) === '',
        });
      }
      case 'MWD':
        return ok({
          type: 'MWD',
          directionTrue: mapNum(num(get(0)), degToRad),
          directionMagnetic: mapNum(num(get(2)), degToRad),
          speed: num(get(6)) ?? mapNum(num(get(4)), knotsToMps),
        });
      case 'VWR': {
        const angle = num(get(0));
        const side = get(1);
        return ok({
          type: 'VWR',
          angle: angle === null ? null : degToRad(side === 'L' ? -angle : angle),
          speed: num(get(4)) ?? mapNum(num(get(2)), knotsToMps),
        });
      }
      case 'MTW':
        return ok({ type: 'MTW', waterTemperature: mapNum(num(get(0)), celsiusToKelvin) });
      case 'MDA': {
        const bar = num(get(2));
        const inHg = num(get(0));
        return ok({
          type: 'MDA',
          airTemperature: mapNum(num(get(4)), celsiusToKelvin),
          waterTemperature: mapNum(num(get(6)), celsiusToKelvin),
          pressure: bar !== null ? bar * 100_000 : inHg !== null ? inHg * 3386.389 : null,
          relativeHumidity: num(get(8)),
          windDirectionTrue: mapNum(num(get(12)), degToRad),
          windSpeed: num(get(18)) ?? mapNum(num(get(16)), knotsToMps),
        });
      }
      case 'XDR': {
        const measurements: XdrMeasurement[] = [];
        for (let i = 0; i + 1 < f.length; i += 4) {
          measurements.push({
            type: get(i),
            value: num(get(i + 1)),
            unit: get(i + 2),
            name: get(i + 3),
          });
        }
        return ok({ type: 'XDR', measurements });
      }
      case 'VDM':
      case 'VDO': {
        const fragments = int(get(0));
        const fragment = int(get(1));
        if (fragments === null || fragment === null || get(4) === '') {
          return { ok: false, reason: 'malformed', type: s.type };
        }
        return ok({
          type: s.type,
          fragments,
          fragment,
          sequenceId: get(2),
          channel: get(3),
          payload: get(4),
          fillBits: int(get(5)) ?? 0,
        });
      }
      default:
        return { ok: false, reason: 'unsupported', type: s.type };
    }
  } catch {
    return { ok: false, reason: 'malformed', type: s.type };
  }
}

function ok(sentence: ParsedSentence): ParseResult {
  return { ok: true, sentence };
}

function num(v: string): number | null {
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: string): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

function mapNum(v: number | null, fn: (n: number) => number): number | null {
  return v === null ? null : fn(v);
}

function windSpeed(value: number | null, unit: string): number | null {
  if (value === null) return null;
  switch (unit) {
    case 'N':
      return knotsToMps(value);
    case 'K':
      return value / 3.6;
    case 'M':
      return value;
    default:
      return knotsToMps(value);
  }
}

/** ddmm.mmmm + N/S → decimal degrees. */
export function parseLat(v: string, hemi: string): number | null {
  if (v.length < 4) return null;
  const deg = Number(v.slice(0, 2));
  const min = Number(v.slice(2));
  if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
  const d = deg + min / 60;
  if (d > 90) return null;
  return hemi === 'S' ? -d : d;
}

/** dddmm.mmmm + E/W → decimal degrees. */
export function parseLon(v: string, hemi: string): number | null {
  if (v.length < 5) return null;
  const deg = Number(v.slice(0, 3));
  const min = Number(v.slice(3));
  if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
  const d = deg + min / 60;
  if (d > 180) return null;
  return hemi === 'W' ? -d : d;
}

/** hhmmss.ss → UtcTime. */
export function parseTime(v: string): UtcTime | null {
  if (v.length < 6) return null;
  const hour = Number(v.slice(0, 2));
  const minute = Number(v.slice(2, 4));
  const sec = Number(v.slice(4));
  if (![hour, minute, sec].every(Number.isFinite)) return null;
  return {
    hour,
    minute,
    second: Math.floor(sec),
    millisecond: Math.round((sec - Math.floor(sec)) * 1000),
  };
}

/** ddmmyy → UtcDate (years 00–79 → 2000s, 80–99 → 1900s). */
export function parseDate(v: string): UtcDate | null {
  if (v.length !== 6) return null;
  const day = Number(v.slice(0, 2));
  const month = Number(v.slice(2, 4));
  const yy = Number(v.slice(4, 6));
  if (![day, month, yy].every(Number.isFinite)) return null;
  return { year: yy < 80 ? 2000 + yy : 1900 + yy, month, day };
}

/** Combine RMC/ZDA date and time into epoch milliseconds. */
export function toEpochMs(date: UtcDate, time: UtcTime): number {
  return Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    time.hour,
    time.minute,
    time.second,
    time.millisecond,
  );
}
