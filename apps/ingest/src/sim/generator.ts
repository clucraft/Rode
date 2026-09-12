import { AisEncode } from 'ggencoder';
import { mpsToKnots, radToDeg } from '@rode/core';
import {
  encodeDPT,
  encodeGGA,
  encodeGGANoFix,
  encodeHDT,
  encodeMTW,
  encodeMWV,
  encodeRMC,
  encodeRMCNoFix,
  encodeVTG,
  encodeXDR,
  encodeZDA,
  encodeMDA,
  type XdrItem,
} from '../nmea/encode.js';
import type { BoatState } from './scenario.js';

/** Simulated sounder: transducer 0.3 m below the waterline, reported via DPT offset. */
const TRANSDUCER_DEPTH = 0.3;

/**
 * Sentences a Cortex-like hub would emit for one second of boat state, in the
 * order a real stream interleaves them. Slow data (time, temps, XDR, AIS) is
 * emitted at realistic lower rates keyed off the scenario second.
 */
export function sentencesFor(s: BoatState, second: number): string[] {
  if (!s.connected) return [];
  const out: string[] = [];

  if (s.position) {
    const fix = {
      epochMs: s.epochMs,
      lat: s.position.lat,
      lon: s.position.lon,
      sog: s.sog,
      cog: s.cog,
      hdop: s.hdop,
      satellites: s.satellites,
    };
    out.push(encodeRMC(fix), encodeGGA(fix), encodeVTG(s.cog, s.sog));
  } else {
    out.push(encodeRMCNoFix(s.epochMs), encodeGGANoFix(s.epochMs));
  }

  if (second % 10 === 0) out.push(encodeZDA(s.epochMs));
  out.push(encodeHDT(s.heading));
  if (s.depth !== null)
    out.push(encodeDPT(Math.max(0, s.depth - TRANSDUCER_DEPTH), TRANSDUCER_DEPTH));
  if (s.awa !== null && s.aws !== null) out.push(encodeMWV(s.awa, s.aws, 'R'));

  if (second % 5 === 0) {
    if (s.waterTemp !== null) out.push(encodeMTW(s.waterTemp));
    if (s.airTemp !== null) out.push(encodeMDA({ airTempK: s.airTemp, pressurePa: 101_300 }));
    const xdr: XdrItem[] = [];
    if (s.fridgeTemp !== null)
      xdr.push({ type: 'C', value: s.fridgeTemp - 273.15, unit: 'C', name: 'Fridge', dp: 1 });
    if (s.freezerTemp !== null)
      xdr.push({ type: 'C', value: s.freezerTemp - 273.15, unit: 'C', name: 'Freezer', dp: 1 });
    if (s.batteryVoltage !== null)
      xdr.push({ type: 'U', value: s.batteryVoltage, unit: 'V', name: 'HouseBank' });
    if (s.batterySoc !== null)
      xdr.push({ type: 'P', value: s.batterySoc * 100, unit: 'P', name: 'HouseSOC', dp: 0 });
    if (s.solarPower !== null)
      xdr.push({ type: 'W', value: s.solarPower, unit: 'W', name: 'SolarMPPT', dp: 0 });
    if (xdr.length > 0) out.push(encodeXDR(xdr));
  }

  if (second % 10 === 3) {
    for (const t of s.ais) {
      const e = new AisEncode({
        aistype: t.classB ? 18 : 1,
        mmsi: t.mmsi,
        lat: t.position.lat,
        lon: t.position.lon,
        sog: Math.round(mpsToKnots(t.sog) * 10) / 10,
        cog: Math.round(radToDeg(t.cog) * 10) / 10,
        hdg: Math.round(radToDeg(t.cog)),
        navstatus: t.sog < 0.3 ? 1 : 0,
      });
      if (e.valid) out.push(...e.nmea.split(/\r?\n/).filter((l) => l.length > 0));
      if (second % 60 === 3) {
        const st = new AisEncode({
          aistype: t.classB ? 24 : 5,
          mmsi: t.mmsi,
          shipname: t.name,
          callsign: 'SIM',
          cargo: 36,
          dimA: 6,
          dimB: 6,
          dimC: 2,
          dimD: 2,
          part: 0,
        });
        if (st.valid) out.push(...st.nmea.split(/\r?\n/).filter((l) => l.length > 0));
      }
    }
  }

  return out;
}
