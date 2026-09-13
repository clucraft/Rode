import {
  degToRad,
  destination,
  normaliseAngle,
  normaliseRelativeAngle,
  offsetByHeading,
  type AlarmConfig,
  type BoatGeometry,
  type Command,
  type LatLon,
} from '@rode/core';

/*
 * Scenario model for the simulator.
 *
 * A scenario is a pure function from scenario-seconds to the boat's physical
 * state, plus the skipper's commands at given times. The generator turns each
 * state into NMEA sentences; the runner feeds them through the real parser,
 * normaliser and alarm engine. Nothing here knows about wall-clock time, so a
 * 12-hour night replays in however long the CPU takes.
 */

export interface AisTargetSpec {
  mmsi: number;
  name: string;
  position: LatLon;
  /** m/s */
  sog: number;
  /** radians true */
  cog: number;
  classB?: boolean;
}

export interface BoatState {
  /** Scenario clock. */
  epochMs: number;
  /** GNSS antenna position, or null when the receiver has no fix. */
  position: LatLon | null;
  hdop: number;
  satellites: number;
  /** m/s */
  sog: number;
  /** radians true */
  cog: number;
  /** radians true */
  heading: number;
  /** Depth below the waterline, metres; null when the sounder is off. */
  depth: number | null;
  /** Apparent wind angle, radians relative to the bow; null when no wind instrument. */
  awa: number | null;
  /** Apparent wind speed, m/s. */
  aws: number | null;
  /** kelvin */
  waterTemp: number | null;
  /** kelvin */
  airTemp: number | null;
  /** kelvin */
  fridgeTemp: number | null;
  /** kelvin */
  freezerTemp: number | null;
  /** 0..1 */
  batterySoc: number | null;
  batteryVoltage: number | null;
  /** watts */
  solarPower: number | null;
  /** False while the data source is down: nothing is emitted and the socket is closed. */
  connected: boolean;
  ais: AisTargetSpec[];
}

export interface ScenarioCommand {
  /** Scenario seconds. */
  at: number;
  command: Command;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  /** What a passing run looks like, in one or two sentences. */
  expectation: string;
  durationS: number;
  startEpochMs: number;
  boat: BoatGeometry;
  alarmConfig?: Partial<AlarmConfig>;
  commands: ScenarioCommand[];
  state: (t: number) => BoatState;
  /** Optional power-cut simulation for the runner: ticks stop at `cutAt` and resume at `restartAt`. */
  powerCut?: { cutAt: number; restartAt: number };
}

// ---------------------------------------------------------------- helpers

/** Deterministic PRNG (mulberry32) so a scenario replays identically. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian noise via Box–Muller from a uniform PRNG. */
export function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Per-second deterministic noise: the same `t` always yields the same
 * sample, so scenarios stay pure functions of time.
 */
export function noiseAt(seed: number, t: number): { n1: number; n2: number; u: number } {
  const rand = prng(seed * 7919 + Math.floor(t) * 104729);
  return { n1: gaussian(rand), n2: gaussian(rand), u: rand() };
}

/** Linear interpolation of `value` from `from` to `to` over [t0, t1], clamped. */
export function ramp(t: number, t0: number, t1: number, from: number, to: number): number {
  if (t <= t0) return from;
  if (t >= t1) return to;
  return from + ((to - from) * (t - t0)) / (t1 - t0);
}

export const DEFAULT_SIM_BOAT: BoatGeometry = {
  antennaToBowForward: 8,
  antennaToBowStarboard: 0,
  bowRollerHeight: 1.2,
};

/** Great Sound, Bermuda. A real anchorage with nothing special about it. */
export const SIM_ANCHOR: LatLon = { lat: 32.29, lon: -64.83 };

export const C = (celsius: number): number => celsius + 273.15;
export const kn = (knots: number): number => (knots * 1852) / 3600;

/**
 * An anchored boat described by where its *bow roller* is relative to the
 * anchor. The antenna position is derived by moving aft along the heading, so
 * the engine's antenna-offset correction is exercised on every sample.
 */
export interface RideOptions {
  anchor: LatLon;
  /** Bearing from anchor to the bow, radians true. */
  bearing: number;
  /** Distance from anchor to the bow, metres. */
  run: number;
  /** Heading; default is bow pointing at the anchor. */
  heading?: number;
  boat: BoatGeometry;
}

export function ride(o: RideOptions): { bow: LatLon; antenna: LatLon; heading: number } {
  const bow = destination(o.anchor, o.bearing, o.run);
  const heading = normaliseAngle(o.heading ?? o.bearing + Math.PI);
  const antenna = offsetByHeading(
    bow,
    heading,
    -o.boat.antennaToBowForward,
    -o.boat.antennaToBowStarboard,
  );
  return { bow, antenna, heading };
}

/** A sensible base state; scenarios override what they care about. */
export function baseState(epochMs: number): BoatState {
  return {
    epochMs,
    position: null,
    hdop: 1.0,
    satellites: 10,
    sog: 0,
    cog: 0,
    heading: 0,
    depth: 6,
    awa: 0,
    aws: kn(12),
    waterTemp: C(24),
    airTemp: C(26),
    fridgeTemp: null,
    freezerTemp: null,
    batterySoc: null,
    batteryVoltage: null,
    solarPower: null,
    connected: true,
    ais: [],
  };
}

/**
 * The standard anchoring prologue shared by the anchor scenarios:
 *   t 0–20   boat over the anchor, drop pressed at t=5
 *   t 20–80  backing down: run grows to `finalRun`
 *   t 90     "Anchor set"
 * Returns the run and a flag for whether the prologue is over.
 */
export const PROLOGUE = { dropAt: 5, setAt: 90, backingFrom: 20, backingTo: 80 } as const;

export function prologueRun(t: number, finalRun: number): number {
  return ramp(t, PROLOGUE.backingFrom, PROLOGUE.backingTo, 1, finalRun);
}

export const prologueCommands: ScenarioCommand[] = [
  { at: PROLOGUE.dropAt, command: { type: 'drop' } },
  { at: PROLOGUE.setAt, command: { type: 'set' } },
];

/**
 * Typical swinging at anchor: slow bearing drift, yaw, small run breathing,
 * SOG jitter, wind mostly on the bow. Used as the "nothing is wrong" baseline.
 */
export interface SwingOptions {
  seed: number;
  t: number;
  anchor: LatLon;
  boat: BoatGeometry;
  finalRun: number;
  /** Bearing from anchor to boat at t=0 and at the end of the drift, radians. */
  bearingFrom: number;
  bearingTo: number;
  /** Seconds over which the bearing drifts from → to. */
  driftOverS: number;
  awsMps?: number;
  yawDeg?: number;
}

export function swingState(o: SwingOptions): Partial<BoatState> {
  const { t } = o;
  const n = noiseAt(o.seed, t);
  const drift = ramp(t, PROLOGUE.setAt, PROLOGUE.setAt + o.driftOverS, o.bearingFrom, o.bearingTo);
  const yaw = degToRad(o.yawDeg ?? 12) * Math.sin(t / 40);
  const bearing = t < PROLOGUE.setAt ? o.bearingFrom : drift + yaw;
  const run =
    t < PROLOGUE.setAt
      ? prologueRun(t, o.finalRun)
      : o.finalRun + 1.5 * Math.sin(t / 25) + n.n1 * 0.6;
  const r = ride({ anchor: o.anchor, bearing, run, boat: o.boat });
  const backing = t >= PROLOGUE.backingFrom && t < PROLOGUE.backingTo;
  return {
    position: r.antenna,
    heading: r.heading,
    sog: backing ? kn(1.0) : Math.abs(n.n2) * kn(0.25) + kn(0.05),
    cog: normaliseAngle(bearing + (backing ? 0 : n.u * 2 * Math.PI)),
    awa: normaliseRelativeAngle(degToRad(20) * Math.sin(t / 15) + degToRad(8) * n.n1),
    aws: (o.awsMps ?? kn(12)) * (1 + 0.15 * Math.sin(t / 60)) + Math.abs(n.n2) * kn(1),
    hdop: 1.0 + 0.2 * Math.abs(n.n1),
  };
}
