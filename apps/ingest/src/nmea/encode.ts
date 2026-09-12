import { kelvinToCelsius, mpsToKnots, radToDeg } from '@rode/core';
import { buildSentence } from './sentence.js';

/*
 * Sentence builders for the simulator and for tests. Inputs are SI; the
 * NMEA units (knots, degrees, celsius) appear only inside this file.
 */

function pad(n: number, width: number, dp = 0): string {
  const s = n.toFixed(dp);
  const [int = '', frac] = s.split('.');
  const p = int.padStart(width, '0');
  return frac !== undefined ? `${p}.${frac}` : p;
}

/** Decimal degrees → ddmm.mmmm,N/S */
export function encodeLat(lat: number): [string, string] {
  const hemi = lat < 0 ? 'S' : 'N';
  const abs = Math.abs(lat);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return [`${pad(deg, 2)}${pad(min, 2, 4)}`, hemi];
}

/** Decimal degrees → dddmm.mmmm,E/W */
export function encodeLon(lon: number): [string, string] {
  const hemi = lon < 0 ? 'W' : 'E';
  const abs = Math.abs(lon);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return [`${pad(deg, 3)}${pad(min, 2, 4)}`, hemi];
}

/** ms epoch → hhmmss.ss */
export function encodeTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}.${pad(Math.floor(d.getUTCMilliseconds() / 10), 2)}`;
}

/** ms epoch → ddmmyy */
export function encodeDate(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad(d.getUTCDate(), 2)}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCFullYear() % 100, 2)}`;
}

/** radians → "ddd.d" in [0, 360). */
function deg(rad: number): string {
  let d = ((radToDeg(rad) % 360) + 360) % 360;
  if (d >= 359.95) d = 0;
  return d.toFixed(1);
}

export interface FixOptions {
  epochMs: number;
  lat: number;
  lon: number;
  /** m/s */
  sog: number;
  /** radians true */
  cog: number;
  valid?: boolean;
  fixQuality?: number;
  satellites?: number;
  hdop?: number;
  /** radians, east positive */
  magneticVariation?: number;
  talker?: string;
}

export function encodeRMC(o: FixOptions): string {
  const [lat, ns] = encodeLat(o.lat);
  const [lon, ew] = encodeLon(o.lon);
  const varDeg =
    o.magneticVariation === undefined ? '' : Math.abs(radToDeg(o.magneticVariation)).toFixed(1);
  const varHemi = o.magneticVariation === undefined ? '' : o.magneticVariation < 0 ? 'W' : 'E';
  return buildSentence(`${o.talker ?? 'GP'}RMC`, [
    encodeTime(o.epochMs),
    o.valid === false ? 'V' : 'A',
    lat,
    ns,
    lon,
    ew,
    mpsToKnots(o.sog).toFixed(2),
    deg(o.cog),
    encodeDate(o.epochMs),
    varDeg,
    varHemi,
    'A',
  ]);
}

/** RMC with no fix: status V and empty position, as receivers emit when they lose the sky. */
export function encodeRMCNoFix(epochMs: number, talker = 'GP'): string {
  return buildSentence(`${talker}RMC`, [
    encodeTime(epochMs),
    'V',
    '',
    '',
    '',
    '',
    '',
    '',
    encodeDate(epochMs),
    '',
    '',
    'N',
  ]);
}

export function encodeGGA(o: FixOptions): string {
  const [lat, ns] = encodeLat(o.lat);
  const [lon, ew] = encodeLon(o.lon);
  return buildSentence(`${o.talker ?? 'GP'}GGA`, [
    encodeTime(o.epochMs),
    lat,
    ns,
    lon,
    ew,
    o.fixQuality ?? 1,
    pad(o.satellites ?? 9, 2),
    (o.hdop ?? 1.0).toFixed(1),
    '0.0',
    'M',
    '0.0',
    'M',
    '',
    '',
  ]);
}

export function encodeGGANoFix(epochMs: number, talker = 'GP'): string {
  return buildSentence(`${talker}GGA`, [
    encodeTime(epochMs),
    '',
    '',
    '',
    '',
    0,
    '00',
    '',
    '',
    'M',
    '',
    'M',
    '',
    '',
  ]);
}

export function encodeVTG(cog: number, sog: number, talker = 'GP'): string {
  const kn = mpsToKnots(sog);
  return buildSentence(`${talker}VTG`, [
    deg(cog),
    'T',
    '',
    'M',
    kn.toFixed(2),
    'N',
    (kn * 1.852).toFixed(2),
    'K',
    'A',
  ]);
}

export function encodeZDA(epochMs: number, talker = 'GP'): string {
  const d = new Date(epochMs);
  return buildSentence(`${talker}ZDA`, [
    encodeTime(epochMs),
    pad(d.getUTCDate(), 2),
    pad(d.getUTCMonth() + 1, 2),
    d.getUTCFullYear(),
    '00',
    '00',
  ]);
}

export function encodeHDT(headingTrue: number, talker = 'HE'): string {
  return buildSentence(`${talker}HDT`, [deg(headingTrue), 'T']);
}

export function encodeHDG(headingMagnetic: number, variation: number, talker = 'HC'): string {
  return buildSentence(`${talker}HDG`, [
    deg(headingMagnetic),
    '',
    '',
    Math.abs(radToDeg(variation)).toFixed(1),
    variation < 0 ? 'W' : 'E',
  ]);
}

export function encodeHDM(headingMagnetic: number, talker = 'HC'): string {
  return buildSentence(`${talker}HDM`, [deg(headingMagnetic), 'M']);
}

/** Depth below transducer with offset (positive = to waterline). */
export function encodeDPT(depthBelowTransducer: number, offset: number, talker = 'SD'): string {
  return buildSentence(`${talker}DPT`, [depthBelowTransducer.toFixed(2), offset.toFixed(2), '']);
}

export function encodeDBT(depthBelowTransducer: number, talker = 'SD'): string {
  const m = depthBelowTransducer;
  return buildSentence(`${talker}DBT`, [
    (m / 0.3048).toFixed(1),
    'f',
    m.toFixed(2),
    'M',
    (m / 1.8288).toFixed(1),
    'F',
  ]);
}

/** Apparent (R) or true (T) wind. Angle radians (any sign), speed m/s. */
export function encodeMWV(
  angle: number,
  speed: number,
  reference: 'R' | 'T' = 'R',
  talker = 'WI',
): string {
  return buildSentence(`${talker}MWV`, [
    deg(angle),
    reference,
    mpsToKnots(speed).toFixed(1),
    'N',
    'A',
  ]);
}

export function encodeVWR(angle: number, speed: number, talker = 'WI'): string {
  const a = ((radToDeg(angle) + 540) % 360) - 180; // -180..180
  return buildSentence(`${talker}VWR`, [
    Math.abs(a).toFixed(1),
    a < 0 ? 'L' : 'R',
    mpsToKnots(speed).toFixed(1),
    'N',
    speed.toFixed(1),
    'M',
    (speed * 3.6).toFixed(1),
    'K',
  ]);
}

export function encodeMTW(waterTempK: number, talker = 'II'): string {
  return buildSentence(`${talker}MTW`, [kelvinToCelsius(waterTempK).toFixed(1), 'C']);
}

export function encodeMDA(
  o: {
    airTempK?: number;
    waterTempK?: number;
    pressurePa?: number;
    windDirTrue?: number;
    windSpeed?: number;
  },
  talker = 'WI',
): string {
  const bar = o.pressurePa === undefined ? '' : (o.pressurePa / 100_000).toFixed(4);
  const inHg = o.pressurePa === undefined ? '' : (o.pressurePa / 3386.389).toFixed(3);
  return buildSentence(`${talker}MDA`, [
    inHg,
    'I',
    bar,
    'B',
    o.airTempK === undefined ? '' : kelvinToCelsius(o.airTempK).toFixed(1),
    'C',
    o.waterTempK === undefined ? '' : kelvinToCelsius(o.waterTempK).toFixed(1),
    'C',
    '',
    '',
    '',
    'C',
    o.windDirTrue === undefined ? '' : deg(o.windDirTrue),
    'T',
    '',
    'M',
    o.windSpeed === undefined ? '' : mpsToKnots(o.windSpeed).toFixed(1),
    'N',
    o.windSpeed === undefined ? '' : o.windSpeed.toFixed(1),
    'M',
  ]);
}

export interface XdrItem {
  type: string;
  value: number;
  unit: string;
  name: string;
  /** Decimal places for the value. */
  dp?: number;
}

export function encodeXDR(items: XdrItem[], talker = 'II'): string {
  return buildSentence(
    `${talker}XDR`,
    items.flatMap((i) => [i.type, i.value.toFixed(i.dp ?? 2), i.unit, i.name]),
  );
}
