import {
  celsiusToKelvin,
  normaliseAngle,
  normaliseRelativeAngle,
  type Field,
  type LatLon,
  type SourceState,
  type Telemetry,
} from '@rode/core';
import { AisTracker, type AisUpdate } from './nmea/ais.js';
import {
  parseSentence,
  toEpochMs,
  type ParsedSentence,
  type XdrMeasurement,
} from './nmea/parse.js';
import { splitSentence } from './nmea/sentence.js';

/*
 * The normaliser turns a stream of NMEA lines into the per-field SI model the
 * engine and the UI read. Every value carries { value, timestamp, source,
 * stale }; staleness is judged per field with its own max age because depth
 * going quiet is routine and position going quiet is an emergency.
 */

export type FieldName =
  | 'position'
  | 'sog'
  | 'cog'
  | 'heading'
  | 'depth'
  | 'awa'
  | 'aws'
  | 'twa'
  | 'tws'
  | 'twd'
  | 'hdop'
  | 'fixQuality'
  | 'satellites'
  | 'waterTemp'
  | 'airTemp'
  | 'pressure'
  | 'batteryVoltage'
  | 'batterySoc'
  | 'solarPower'
  | 'fridgeTemp'
  | 'freezerTemp';

export type FieldValue<N extends FieldName> = N extends 'position' ? LatLon : number;

/** Default maximum sample age per field before it is flagged stale, ms. */
export const DEFAULT_MAX_AGE: Record<FieldName, number> = {
  position: 10_000,
  sog: 10_000,
  cog: 10_000,
  heading: 10_000,
  depth: 30_000,
  awa: 10_000,
  aws: 10_000,
  twa: 10_000,
  tws: 10_000,
  twd: 10_000,
  hdop: 30_000,
  fixQuality: 30_000,
  satellites: 30_000,
  waterTemp: 10 * 60_000,
  airTemp: 10 * 60_000,
  pressure: 10 * 60_000,
  batteryVoltage: 10 * 60_000,
  batterySoc: 10 * 60_000,
  solarPower: 10 * 60_000,
  fridgeTemp: 10 * 60_000,
  freezerTemp: 10 * 60_000,
};

export interface XdrRule {
  /** Transducer type letter to match, or null for any. */
  type: string | null;
  /** Case-insensitive pattern on the transducer name. */
  name: RegExp;
  target: FieldName;
}

/**
 * Default XDR heuristics. XDR names are vendor-defined, so these are a best
 * guess; owners refine them in Settings (phase 4 stores overrides).
 */
export const DEFAULT_XDR_RULES: XdrRule[] = [
  { type: 'C', name: /freez/i, target: 'freezerTemp' },
  { type: 'C', name: /fridge|refrig|reefer/i, target: 'fridgeTemp' },
  { type: 'C', name: /air|cabin|inside|ambient|saloon/i, target: 'airTemp' },
  { type: 'C', name: /water|sea/i, target: 'waterTemp' },
  { type: 'U', name: /house|batt|bank|dc|service/i, target: 'batteryVoltage' },
  { type: null, name: /soc|charge/i, target: 'batterySoc' },
  { type: null, name: /solar|pv|mppt/i, target: 'solarPower' },
];

export interface NormalizerOptions {
  /** Distance from transducer face to the waterline, metres. Used for DBT and for DPT without a positive offset. */
  transducerDepth: number;
  /** Magnetic variation to apply when the stream provides none, radians (east positive). */
  magneticVariation: number | null;
  maxAge: Partial<Record<FieldName, number>>;
  xdrRules: XdrRule[];
  /** Forget AIS targets not heard from for this long. */
  aisMaxAgeMs: number;
}

export const DEFAULT_NORMALIZER_OPTIONS: NormalizerOptions = {
  transducerDepth: 0,
  magneticVariation: null,
  maxAge: {},
  xdrRules: DEFAULT_XDR_RULES,
  aisMaxAgeMs: 20 * 60_000,
};

export interface GpsTime {
  /** UTC from the receiver, ms epoch. */
  epochMs: number;
  /** Local `now` when it was received, so the offset can be applied later. */
  receivedAt: number;
}

export interface Counters {
  lines: number;
  sentences: number;
  byType: Record<string, number>;
  checksumFailures: number;
  malformed: number;
  unsupported: number;
  unsupportedTypes: Record<string, number>;
  aisDecoded: number;
}

export type NormalizerEvent =
  | { type: 'field'; name: FieldName; field: Field<number | LatLon> }
  | { type: 'ais'; update: AisUpdate }
  | { type: 'sentence'; raw: string; parsed: ParsedSentence | null }
  | { type: 'time'; gps: GpsTime }
  | { type: 'extra'; name: string; field: Field<number>; unit: string };

export type NormalizerListener = (event: NormalizerEvent) => void;

export class Normalizer {
  private readonly fields = new Map<FieldName, Field<number | LatLon>>();
  private readonly extras = new Map<string, { field: Field<number>; unit: string }>();
  private readonly listeners = new Set<NormalizerListener>();
  readonly ais = new AisTracker();
  readonly counters: Counters = {
    lines: 0,
    sentences: 0,
    byType: {},
    checksumFailures: 0,
    malformed: 0,
    unsupported: 0,
    unsupportedTypes: {},
    aisDecoded: 0,
  };
  private gpsTime: GpsTime | null = null;
  private lastDate: { year: number; month: number; day: number } | null = null;
  /** Variation learned from RMC/HDG, radians east positive. */
  private learnedVariation: number | null = null;
  private source: SourceState = { connected: false, since: 0 };
  readonly options: NormalizerOptions;

  constructor(options: Partial<NormalizerOptions> = {}) {
    this.options = { ...DEFAULT_NORMALIZER_OPTIONS, ...options };
  }

  on(listener: NormalizerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: NormalizerEvent): void {
    for (const l of this.listeners) l(event);
  }

  setSourceState(state: SourceState): void {
    this.source = state;
  }

  getSourceState(): SourceState {
    return this.source;
  }

  getGpsTime(): GpsTime | null {
    return this.gpsTime;
  }

  /** Feed one line. `now` is the local clock (ms) when it arrived. */
  feedLine(line: string, now: number, sourceLabel = 'nmea'): void {
    this.counters.lines++;
    const split = splitSentence(line);
    if (!split.ok) {
      if (split.reason === 'bad-checksum') this.counters.checksumFailures++;
      else if (split.reason === 'malformed') this.counters.malformed++;
      return;
    }
    const s = split.sentence;
    this.counters.sentences++;
    this.counters.byType[s.type] = (this.counters.byType[s.type] ?? 0) + 1;

    const parsed = parseSentence(s);
    if (!parsed.ok) {
      if (parsed.reason === 'unsupported') {
        this.counters.unsupported++;
        this.counters.unsupportedTypes[s.type] = (this.counters.unsupportedTypes[s.type] ?? 0) + 1;
      } else {
        this.counters.malformed++;
      }
      this.emit({ type: 'sentence', raw: s.raw, parsed: null });
      return;
    }
    this.apply(parsed.sentence, s.raw, now, `${sourceLabel}:${s.type}`);
    this.emit({ type: 'sentence', raw: s.raw, parsed: parsed.sentence });
  }

  /** Apply an already-parsed sentence (used by the Signal K adapter's NMEA passthrough and tests). */
  apply(p: ParsedSentence, raw: string, now: number, source: string): void {
    const set = <N extends FieldName>(name: N, value: FieldValue<N> | null): void => {
      if (value === null) return;
      if (typeof value === 'number' && !Number.isFinite(value)) return;
      const field: Field<number | LatLon> = { value, timestamp: now, source, stale: false };
      this.fields.set(name, field);
      this.emit({ type: 'field', name, field });
    };
    const pos = (lat: number | null, lon: number | null) =>
      lat !== null && lon !== null ? { lat, lon } : null;

    switch (p.type) {
      case 'GGA':
        if (p.fixQuality !== null) set('fixQuality', p.fixQuality);
        if (p.fixQuality !== 0) set('position', pos(p.lat, p.lon));
        set('satellites', p.satellites);
        set('hdop', p.hdop);
        break;
      case 'RMC':
        if (p.valid) {
          set('position', pos(p.lat, p.lon));
          set('sog', p.sog);
          if (p.cog !== null) set('cog', normaliseAngle(p.cog));
        }
        if (p.magneticVariation !== null) this.learnedVariation = p.magneticVariation;
        if (p.date) this.lastDate = p.date;
        if (p.date && p.time) this.syncTime(toEpochMs(p.date, p.time), now);
        break;
      case 'GLL':
        if (p.valid) set('position', pos(p.lat, p.lon));
        break;
      case 'VTG':
        set('sog', p.sog);
        if (p.cogTrue !== null) set('cog', normaliseAngle(p.cogTrue));
        else if (p.cogMagnetic !== null) {
          const v = this.variation();
          if (v !== null) set('cog', normaliseAngle(p.cogMagnetic + v));
        }
        break;
      case 'ZDA':
        if (p.date) this.lastDate = p.date;
        if (p.date && p.time) this.syncTime(toEpochMs(p.date, p.time), now);
        break;
      case 'HDT':
        if (p.headingTrue !== null) set('heading', normaliseAngle(p.headingTrue));
        break;
      case 'HDG': {
        if (p.variation !== null) this.learnedVariation = p.variation;
        if (p.headingMagnetic !== null) {
          const v = this.variation();
          if (v !== null)
            set('heading', normaliseAngle(p.headingMagnetic + (p.deviation ?? 0) + v));
        }
        break;
      }
      case 'HDM': {
        if (p.headingMagnetic !== null) {
          const v = this.variation();
          if (v !== null) set('heading', normaliseAngle(p.headingMagnetic + v));
        }
        break;
      }
      case 'DBT':
        if (p.depthBelowTransducer !== null) {
          set('depth', p.depthBelowTransducer + this.options.transducerDepth);
        }
        break;
      case 'DPT':
        if (p.depthBelowTransducer !== null) {
          // A positive offset is transducer→waterline: the sounder has done
          // the correction for us. Otherwise apply the configured one.
          const offset =
            p.offset !== null && p.offset > 0 ? p.offset : this.options.transducerDepth;
          set('depth', p.depthBelowTransducer + offset);
        }
        break;
      case 'MWV':
        if (!p.valid) break;
        if (p.reference === 'apparent') {
          if (p.angle !== null) set('awa', normaliseRelativeAngle(p.angle));
          set('aws', p.speed);
        } else {
          if (p.angle !== null) set('twa', normaliseRelativeAngle(p.angle));
          set('tws', p.speed);
        }
        break;
      case 'VWR':
        if (p.angle !== null) set('awa', normaliseRelativeAngle(p.angle));
        set('aws', p.speed);
        break;
      case 'MWD':
        if (p.directionTrue !== null) set('twd', normaliseAngle(p.directionTrue));
        set('tws', p.speed);
        break;
      case 'MTW':
        set('waterTemp', p.waterTemperature);
        break;
      case 'MDA':
        set('airTemp', p.airTemperature);
        set('waterTemp', p.waterTemperature);
        set('pressure', p.pressure);
        if (p.windDirectionTrue !== null) set('twd', normaliseAngle(p.windDirectionTrue));
        set('tws', p.windSpeed);
        break;
      case 'XDR':
        for (const m of p.measurements) this.applyXdr(m, now, source, set);
        break;
      case 'VDM':
      case 'VDO': {
        const update = this.ais.feed(raw, p.type === 'VDO', now);
        if (update) {
          this.counters.aisDecoded++;
          this.emit({ type: 'ais', update });
        }
        break;
      }
    }
  }

  private applyXdr(
    m: XdrMeasurement,
    now: number,
    source: string,
    set: <N extends FieldName>(name: N, value: FieldValue<N> | null) => void,
  ): void {
    if (m.value === null) return;
    const rule = this.options.xdrRules.find(
      (r) => (r.type === null || r.type === m.type) && r.name.test(m.name),
    );
    if (!rule) {
      const field: Field<number> = { value: m.value, timestamp: now, source, stale: false };
      this.extras.set(m.name || `${m.type}:${m.unit}`, { field, unit: m.unit });
      this.emit({ type: 'extra', name: m.name, field, unit: m.unit });
      return;
    }
    let value = m.value;
    switch (rule.target) {
      case 'fridgeTemp':
      case 'freezerTemp':
      case 'airTemp':
      case 'waterTemp':
        value =
          m.unit === 'K'
            ? m.value
            : m.unit === 'F'
              ? ((m.value - 32) * 5) / 9 + 273.15
              : celsiusToKelvin(m.value);
        break;
      case 'batterySoc':
        value = m.value > 1 ? m.value / 100 : m.value;
        break;
      case 'batteryVoltage':
      case 'solarPower':
        break;
      default:
        break;
    }
    set(rule.target, value);
  }

  private variation(): number | null {
    return this.learnedVariation ?? this.options.magneticVariation;
  }

  private syncTime(epochMs: number, now: number): void {
    // Receivers emit 1970/1980-era dates before first fix; reject anything
    // before 2020 so the host never adopts a garbage clock.
    if (epochMs < Date.UTC(2020, 0, 1)) return;
    this.gpsTime = { epochMs, receivedAt: now };
    this.emit({ type: 'time', gps: this.gpsTime });
  }

  getField<N extends FieldName>(name: N): Field<FieldValue<N>> | undefined {
    return this.fields.get(name) as Field<FieldValue<N>> | undefined;
  }

  getExtras(): Record<string, { field: Field<number>; unit: string }> {
    return Object.fromEntries(this.extras);
  }

  /** The engine-facing snapshot with per-field staleness evaluated at `now`. */
  snapshot(now: number): Telemetry {
    const t: Telemetry = { source: this.source };
    const pick = <N extends FieldName>(name: N): Field<FieldValue<N>> | undefined => {
      const f = this.fields.get(name) as Field<FieldValue<N>> | undefined;
      if (!f) return undefined;
      const maxAge = this.options.maxAge[name] ?? DEFAULT_MAX_AGE[name];
      return { ...f, stale: now - f.timestamp > maxAge };
    };
    const position = pick('position');
    if (position) t.position = position;
    const numeric = [
      'sog',
      'cog',
      'heading',
      'depth',
      'awa',
      'aws',
      'hdop',
      'fixQuality',
      'satellites',
      'batterySoc',
      'batteryVoltage',
      'solarPower',
      'fridgeTemp',
      'freezerTemp',
      'airTemp',
    ] as const;
    for (const key of numeric) {
      const f = pick(key);
      if (f) t[key] = f;
    }
    return t;
  }

  /** Non-engine fields for the Now screen, with staleness. */
  instruments(now: number): Partial<Record<FieldName, Field<number | LatLon>>> {
    const out: Partial<Record<FieldName, Field<number | LatLon>>> = {};
    for (const [name, f] of this.fields) {
      const maxAge = this.options.maxAge[name] ?? DEFAULT_MAX_AGE[name];
      out[name] = { ...f, stale: now - f.timestamp > maxAge };
    }
    return out;
  }

  /** Forget stale AIS targets. Call periodically. */
  housekeeping(now: number): void {
    this.ais.prune(now, this.options.aisMaxAgeMs);
  }

  reset(): void {
    this.fields.clear();
    this.extras.clear();
    this.ais.reset();
    this.gpsTime = null;
  }
}
