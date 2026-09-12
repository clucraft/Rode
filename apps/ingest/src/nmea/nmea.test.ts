import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { celsiusToKelvin, degToRad, knotsToMps, radToDeg } from '@rode/core';
import { buildSentence, computeChecksum, LineSplitter, splitSentence } from './sentence.js';
import { parseLat, parseLon, parseSentence, parseTime, toEpochMs } from './parse.js';
import {
  encodeDPT,
  encodeGGA,
  encodeHDG,
  encodeLat,
  encodeLon,
  encodeMWV,
  encodeRMC,
  encodeRMCNoFix,
  encodeVWR,
  encodeXDR,
} from './encode.js';
import { AisTracker } from './ais.js';

function parse(line: string) {
  const s = splitSentence(line);
  if (!s.ok) throw new Error(`split failed: ${s.reason}`);
  const p = parseSentence(s.sentence);
  if (!p.ok) throw new Error(`parse failed: ${p.reason}`);
  return p.sentence;
}

describe('splitSentence', () => {
  it('splits a checksummed sentence', () => {
    const r = splitSentence('$GPRMC,081836,A,3751.65,S,14507.36,E,000.0,360.0,130998,011.3,E*62');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sentence.talker).toBe('GP');
    expect(r.sentence.type).toBe('RMC');
    expect(r.sentence.fields[1]).toBe('A');
    expect(r.sentence.checksumOk).toBe(true);
  });

  it('rejects a bad checksum and non-NMEA lines', () => {
    expect(
      splitSentence('$GPRMC,081836,A,3751.65,S,14507.36,E,000.0,360.0,130998,011.3,E*63'),
    ).toMatchObject({
      ok: false,
      reason: 'bad-checksum',
    });
    expect(splitSentence('hello world')).toMatchObject({ ok: false, reason: 'not-nmea' });
    expect(splitSentence('$GP')).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('accepts encapsulated (!) sentences and proprietary talkers', () => {
    const ais = splitSentence('!AIVDM,1,1,,A,13aEOK?P00PD2wVMdLDRhgvL289?,0*26');
    expect(ais.ok && ais.sentence.talker).toBe('AI');
    const prop = splitSentence(buildSentence('PVSP,1,2', []));
    expect(prop.ok && prop.sentence.talker).toBe('P');
  });

  it('strips a TAG block', () => {
    const inner = 'GPRMC,081836,A,3751.65,S,14507.36,E,000.0,360.0,130998,011.3,E';
    const line = `\\s:cortex,c:1700000000*00\\$${inner}*${computeChecksum(inner)}`;
    const r = splitSentence(line);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sentence.tag).toEqual({ s: 'cortex', c: '1700000000' });
    expect(r.sentence.type).toBe('RMC');
  });

  it('buildSentence round-trips through splitSentence (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[A-Za-z0-9.]{0,8}$/), { maxLength: 8 }),
        (fields) => {
          const line = buildSentence('IIXDR', fields);
          const r = splitSentence(line);
          expect(r.ok).toBe(true);
          if (r.ok) expect(r.sentence.fields).toEqual(fields);
        },
      ),
    );
  });
});

describe('LineSplitter', () => {
  it('reassembles lines across chunks and drops CR', () => {
    const ls = new LineSplitter();
    expect(ls.push('$A,1\r\n$B,')).toEqual(['$A,1']);
    expect(ls.push('2\n\n$C')).toEqual(['$B,2']);
    expect(ls.push(',3\r\n')).toEqual(['$C,3']);
  });

  it('bounds the buffer', () => {
    const ls = new LineSplitter(10);
    ls.push('x'.repeat(50));
    expect(ls.push('\n')).toEqual([]);
  });
});

describe('field parsers', () => {
  it('parses lat/lon in ddmm.mmmm', () => {
    expect(parseLat('3751.65', 'S')).toBeCloseTo(-37.860833, 5);
    expect(parseLon('14507.36', 'E')).toBeCloseTo(145.122667, 5);
    expect(parseLat('', 'N')).toBeNull();
    expect(parseLat('9951.65', 'N')).toBeNull();
  });

  it('parses time and combines with date', () => {
    expect(parseTime('081836.25')).toEqual({ hour: 8, minute: 18, second: 36, millisecond: 250 });
    expect(
      toEpochMs(
        { year: 2026, month: 9, day: 11 },
        { hour: 1, minute: 2, second: 3, millisecond: 0 },
      ),
    ).toBe(Date.UTC(2026, 8, 11, 1, 2, 3));
  });

  it('round-trips lat/lon encoding (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -89.99, max: 89.99, noNaN: true }),
        fc.double({ min: -179.99, max: 179.99, noNaN: true }),
        (lat, lon) => {
          const [la, ns] = encodeLat(lat);
          const [lo, ew] = encodeLon(lon);
          expect(parseLat(la, ns)).toBeCloseTo(lat, 5);
          expect(parseLon(lo, ew)).toBeCloseTo(lon, 5);
        },
      ),
    );
  });
});

describe('parseSentence', () => {
  it('RMC → SI', () => {
    const p = parse('$GPRMC,081836,A,3751.65,S,14507.36,E,003.5,090.0,130998,011.3,W*7A');
    expect(p.type).toBe('RMC');
    if (p.type !== 'RMC') return;
    expect(p.valid).toBe(true);
    expect(p.lat).toBeCloseTo(-37.860833, 5);
    expect(p.sog).toBeCloseTo(knotsToMps(3.5));
    expect(p.cog).toBeCloseTo(degToRad(90));
    expect(p.magneticVariation).toBeCloseTo(degToRad(-11.3));
    expect(p.date).toEqual({ year: 1998, month: 9, day: 13 });
  });

  it('GGA with quality, sats and hdop', () => {
    const p = parse('$GPGGA,092750.000,5321.6802,N,00630.3372,W,1,8,1.03,61.7,M,55.2,M,,*76');
    if (p.type !== 'GGA') throw new Error();
    expect(p.fixQuality).toBe(1);
    expect(p.satellites).toBe(8);
    expect(p.hdop).toBeCloseTo(1.03);
    expect(p.lon).toBeCloseTo(-6.50562, 4);
  });

  it('DPT and DBT depths in metres', () => {
    const dpt = parse(encodeDPT(4.2, 0.5));
    if (dpt.type !== 'DPT') throw new Error();
    expect(dpt.depthBelowTransducer).toBeCloseTo(4.2);
    expect(dpt.offset).toBeCloseTo(0.5);
    const dbt = parse('$SDDBT,13.1,f,4.0,M,2.2,F*31');
    if (dbt.type !== 'DBT') throw new Error();
    expect(dbt.depthBelowTransducer).toBeCloseTo(4.0);
    // Feet-only DBT.
    const feet = parse(buildSentence('SDDBT', ['13.1', 'f', '', 'M', '', 'F']));
    if (feet.type !== 'DBT') throw new Error();
    expect(feet.depthBelowTransducer).toBeCloseTo(13.1 * 0.3048, 3);
  });

  it('MWV apparent wind in knots → m/s and radians', () => {
    const p = parse(encodeMWV(degToRad(45), knotsToMps(12)));
    if (p.type !== 'MWV') throw new Error();
    expect(p.reference).toBe('apparent');
    expect(p.angle).toBeCloseTo(degToRad(45), 3);
    expect(p.speed).toBeCloseTo(knotsToMps(12), 2);
    const kmh = parse(buildSentence('WIMWV', ['270.0', 'R', '36.0', 'K', 'A']));
    if (kmh.type !== 'MWV') throw new Error();
    expect(kmh.speed).toBeCloseTo(10);
  });

  it('VWR left/right sign convention', () => {
    const left = parse(encodeVWR(degToRad(-30), 5));
    if (left.type !== 'VWR') throw new Error();
    expect(left.angle).toBeCloseTo(degToRad(-30), 3);
    const right = parse(encodeVWR(degToRad(30), 5));
    if (right.type !== 'VWR') throw new Error();
    expect(right.angle).toBeCloseTo(degToRad(30), 3);
  });

  it('HDG with variation', () => {
    const p = parse(encodeHDG(degToRad(100), degToRad(-11)));
    if (p.type !== 'HDG') throw new Error();
    expect(p.headingMagnetic).toBeCloseTo(degToRad(100), 3);
    expect(p.variation).toBeCloseTo(degToRad(-11), 3);
  });

  it('MTW in kelvin', () => {
    const p = parse('$IIMTW,18.5,C*1F');
    if (p.type !== 'MTW') throw new Error();
    expect(p.waterTemperature).toBeCloseTo(celsiusToKelvin(18.5));
  });

  it('XDR groups', () => {
    const p = parse(
      encodeXDR([
        { type: 'C', value: -18.2, unit: 'C', name: 'Freezer', dp: 1 },
        { type: 'U', value: 12.8, unit: 'V', name: 'House' },
      ]),
    );
    if (p.type !== 'XDR') throw new Error();
    expect(p.measurements).toHaveLength(2);
    expect(p.measurements[1]).toEqual({ type: 'U', value: 12.8, unit: 'V', name: 'House' });
  });

  it('VDM fragments', () => {
    const p = parse('!AIVDM,2,1,3,B,55P5TL01VIaAL@7WKO@mBplU@<PDhh000000001S;AJ::4A80?4i@E53,0*3E');
    if (p.type !== 'VDM') throw new Error();
    expect(p.fragments).toBe(2);
    expect(p.fragment).toBe(1);
    expect(p.sequenceId).toBe('3');
    expect(p.channel).toBe('B');
  });

  it('reports unsupported types', () => {
    const s = splitSentence(buildSentence('GPGSV', ['3', '1', '11']));
    if (!s.ok) throw new Error();
    expect(parseSentence(s.sentence)).toEqual({ ok: false, reason: 'unsupported', type: 'GSV' });
  });

  it('RMC without a fix parses as invalid with null position', () => {
    const p = parse(encodeRMCNoFix(Date.UTC(2026, 8, 11, 3, 0, 0)));
    if (p.type !== 'RMC') throw new Error();
    expect(p.valid).toBe(false);
    expect(p.lat).toBeNull();
  });

  it('encode → parse round-trips a fix (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -80, max: 80, noNaN: true }),
        fc.double({ min: -179, max: 179, noNaN: true }),
        fc.double({ min: 0, max: 20, noNaN: true }),
        fc.double({ min: 0, max: 2 * Math.PI - 0.01, noNaN: true }),
        (lat, lon, sog, cog) => {
          const epochMs = Date.UTC(2026, 8, 11, 12, 34, 56);
          const p = parse(encodeRMC({ epochMs, lat, lon, sog, cog }));
          if (p.type !== 'RMC') throw new Error();
          expect(p.lat).toBeCloseTo(lat, 5);
          expect(p.lon).toBeCloseTo(lon, 5);
          expect(p.sog).toBeCloseTo(sog, 2);
          expect(Math.abs(radToDeg((p.cog ?? 0) - cog))).toBeLessThan(0.06);
          const g = parse(encodeGGA({ epochMs, lat, lon, sog, cog, hdop: 1.4 }));
          if (g.type !== 'GGA') throw new Error();
          expect(g.hdop).toBeCloseTo(1.4);
        },
      ),
    );
  });
});

describe('AisTracker', () => {
  it('decodes a class A position report into SI', () => {
    const t = new AisTracker();
    const u = t.feed('!AIVDM,1,1,,A,13aEOK?P00PD2wVMdLDRhgvL289?,0*26', false, 1000);
    expect(u?.position).toBe(true);
    expect(u?.target.mmsi).toBe('244670316');
    expect(u?.target.lat).toBeCloseTo(51.89475, 4);
    expect(u?.target.cog).toBeCloseTo(degToRad(70.6), 3);
    expect(u?.target.heading).toBeNull(); // 511
    expect(u?.target.class).toBe('A');
  });

  it('merges static data and reassembles multipart messages', () => {
    const t = new AisTracker();
    t.feed(
      '!AIVDM,2,1,3,B,55P5TL01VIaAL@7WKO@mBplU@<PDhh000000001S;AJ::4A80?4i@E53,0*3E',
      false,
      1000,
    );
    const u = t.feed('!AIVDM,2,2,3,B,1@0000000000000,2*55', false, 1001);
    expect(u?.position).toBe(false);
    expect(u?.target.name).toBeTruthy();
    expect(u?.target.mmsi).toBe('369190000');
    expect(t.all()).toHaveLength(1);
  });

  it('prunes old targets and ignores junk', () => {
    const t = new AisTracker();
    t.feed('!AIVDM,1,1,,A,13aEOK?P00PD2wVMdLDRhgvL289?,0*26', false, 1000);
    expect(t.feed('!AIVDM,1,1,,A,garbage,0*00', false, 1000)).toBeNull();
    expect(t.prune(1000 + 30 * 60_000, 20 * 60_000)).toEqual(['244670316']);
    expect(t.all()).toHaveLength(0);
  });
});
