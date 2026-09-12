import type { Severity, Telemetry } from './types.js';
import { fresh } from './detectors.js';
import { celsiusToKelvin } from './units.js';

/*
 * Marina-mode monitors: refrigeration, battery, solar.
 *
 * These are band classifiers rather than threshold alarms, because the
 * failure that matters is a *trajectory*. The field lesson this encodes:
 *
 *   A freezer that fails while nobody is aboard climbs through the alarm band
 *   and eventually reaches ambient, where it reads as "off" and the alarm
 *   clears itself.
 *
 * Latching the alarm is the wrong fix (loading provisions spikes the box and
 * leaves a sticky alarm). Instead, every band transition is an event,
 * including the transition into "off". Current state may return to normal on
 * its own; the message history does not disappear.
 */

export type ColdBand = 'normal' | 'warm' | 'failing' | 'off' | 'unknown';

export interface ColdBoxThresholds {
  /** Above this the box is "warm" (warning). Kelvin. */
  warmAbove: number;
  /** Above this the box is "failing" (critical). Kelvin. */
  failingAbove: number;
  /** Within this many kelvin of ambient the box reads as deliberately off. */
  offWithinOfAmbient: number;
  /** When no ambient reading exists, above this absolute temperature is "off". Kelvin. */
  offAboveFallback: number;
}

export interface MarinaConfig {
  fridge: ColdBoxThresholds;
  freezer: ColdBoxThresholds;
  /** A band must be stable this long before a transition is reported, ms. */
  bandHoldMs: number;
  /** Hysteresis around each threshold, kelvin. */
  bandHysteresis: number;

  /** House bank SoC below this is a warning (0..1). */
  socWarnBelow: number;
  /** House bank SoC below this is critical (0..1). */
  socCriticalBelow: number;
  /** SoC must stay below a threshold this long: rides through an overnight dip, ms. */
  socHoldMs: number;

  /** Local hours (inclusive start, exclusive end) in which solar should be producing. */
  solarWindow: { startHour: number; endHour: number };
  /** Below this many watts inside the window counts as no yield. */
  solarMinWatts: number;
  /** No yield must persist this long before warning, ms. */
  solarHoldMs: number;
}

export const DEFAULT_MARINA_CONFIG: MarinaConfig = {
  fridge: {
    warmAbove: celsiusToKelvin(8),
    failingAbove: celsiusToKelvin(12),
    offWithinOfAmbient: 3,
    offAboveFallback: celsiusToKelvin(18),
  },
  freezer: {
    warmAbove: celsiusToKelvin(-12),
    failingAbove: celsiusToKelvin(-5),
    offWithinOfAmbient: 3,
    offAboveFallback: celsiusToKelvin(15),
  },
  bandHoldMs: 60_000,
  bandHysteresis: 0.5,

  socWarnBelow: 0.5,
  socCriticalBelow: 0.3,
  socHoldMs: 20 * 60_000,

  solarWindow: { startHour: 10, endHour: 15 },
  solarMinWatts: 20,
  solarHoldMs: 2 * 60 * 60_000,
};

export type ColdBox = 'fridge' | 'freezer';

export interface ColdBoxState {
  band: ColdBand;
  /** Raw band observed this tick and when it was first observed continuously. */
  pendingBand: ColdBand;
  pendingSince: number | null;
  lastTemp: number | null;
}

export interface MarinaState {
  fridge: ColdBoxState;
  freezer: ColdBoxState;
  socBelowWarnSince: number | null;
  socBelowCriticalSince: number | null;
  solarNoYieldSince: number | null;
}

export function createMarinaState(): MarinaState {
  const box = (): ColdBoxState => ({
    band: 'unknown',
    pendingBand: 'unknown',
    pendingSince: null,
    lastTemp: null,
  });
  return {
    fridge: box(),
    freezer: box(),
    socBelowWarnSince: null,
    socBelowCriticalSince: null,
    solarNoYieldSince: null,
  };
}

export interface BandTransition {
  box: ColdBox;
  from: ColdBand;
  to: ColdBand;
  temp: number | null;
  ambient: number | null;
}

/**
 * Classify a temperature. Hysteresis is applied relative to the *current*
 * band so a box sitting on a threshold does not flap.
 */
export function classifyColdBox(
  temp: number | null,
  ambient: number | null,
  t: ColdBoxThresholds,
  current: ColdBand,
  hysteresis: number,
): ColdBand {
  if (temp === null || !Number.isFinite(temp)) return 'unknown';
  const h = (band: ColdBand) => (current === band ? hysteresis : 0);

  // "Off" is judged first: a box at ambient is not failing, it is switched off.
  const offLine = ambient !== null ? ambient - t.offWithinOfAmbient : t.offAboveFallback;
  if (temp >= offLine - h('off')) return 'off';
  if (temp >= t.failingAbove - h('failing')) return 'failing';
  if (temp >= t.warmAbove - h('warm')) return 'warm';
  return 'normal';
}

function stepBox(
  box: ColdBox,
  s: ColdBoxState,
  temp: number | null,
  ambient: number | null,
  cfg: MarinaConfig,
  now: number,
): { state: ColdBoxState; transition: BandTransition | null } {
  const raw = classifyColdBox(temp, ambient, cfg[box], s.band, cfg.bandHysteresis);
  let pendingBand = s.pendingBand;
  let pendingSince = s.pendingSince;
  if (raw !== pendingBand) {
    pendingBand = raw;
    pendingSince = now;
  }
  const next: ColdBoxState = { ...s, pendingBand, pendingSince, lastTemp: temp };
  if (raw !== s.band && pendingSince !== null && now - pendingSince >= cfg.bandHoldMs) {
    next.band = raw;
    return { state: next, transition: { box, from: s.band, to: raw, temp, ambient } };
  }
  return { state: next, transition: null };
}

export interface MarinaConditions {
  /** Condition keys with severity that should be active after this step. */
  conditions: {
    key: MarinaConditionKey;
    severity: Severity;
    values: Record<string, number | string | null>;
  }[];
  transitions: BandTransition[];
}

export type MarinaConditionKey =
  | 'fridge-warm'
  | 'fridge-failing'
  | 'freezer-warm'
  | 'freezer-failing'
  | 'battery-low'
  | 'solar-no-yield';

const INSTRUMENT_MAX_AGE_MS = 10 * 60_000; // slow telemetry: temps and SoC arrive rarely

/**
 * Advance the marina monitors one tick. Pure. Returns the new sub-state, the
 * conditions that should be active, and any band transitions to report.
 */
export function stepMarina(
  s: MarinaState,
  telemetry: Telemetry,
  cfg: MarinaConfig,
  now: number,
  localHour: number | null,
): { state: MarinaState; result: MarinaConditions } {
  const ambient = fresh(telemetry.airTemp, now, INSTRUMENT_MAX_AGE_MS);
  const fridgeTemp = fresh(telemetry.fridgeTemp, now, INSTRUMENT_MAX_AGE_MS);
  const freezerTemp = fresh(telemetry.freezerTemp, now, INSTRUMENT_MAX_AGE_MS);

  const fridge = stepBox('fridge', s.fridge, fridgeTemp, ambient, cfg, now);
  const freezer = stepBox('freezer', s.freezer, freezerTemp, ambient, cfg, now);

  const conditions: MarinaConditions['conditions'] = [];
  const transitions: BandTransition[] = [];
  if (fridge.transition) transitions.push(fridge.transition);
  if (freezer.transition) transitions.push(freezer.transition);

  for (const [box, st, temp] of [
    ['fridge', fridge.state, fridgeTemp],
    ['freezer', freezer.state, freezerTemp],
  ] as const) {
    const values = { temp: roundK(temp), ambient: roundK(ambient), band: st.band };
    if (st.band === 'warm') conditions.push({ key: `${box}-warm`, severity: 'warning', values });
    if (st.band === 'failing')
      conditions.push({ key: `${box}-failing`, severity: 'critical', values });
  }

  // Battery: long holds so a normal overnight dip and morning recovery pass.
  const soc = fresh(telemetry.batterySoc, now, INSTRUMENT_MAX_AGE_MS);
  let socBelowWarnSince = s.socBelowWarnSince;
  let socBelowCriticalSince = s.socBelowCriticalSince;
  if (soc === null) {
    socBelowWarnSince = null;
    socBelowCriticalSince = null;
  } else {
    socBelowWarnSince = soc < cfg.socWarnBelow ? (socBelowWarnSince ?? now) : null;
    socBelowCriticalSince = soc < cfg.socCriticalBelow ? (socBelowCriticalSince ?? now) : null;
  }
  if (socBelowCriticalSince !== null && now - socBelowCriticalSince >= cfg.socHoldMs) {
    conditions.push({
      key: 'battery-low',
      severity: 'critical',
      values: { soc, threshold: cfg.socCriticalBelow },
    });
  } else if (socBelowWarnSince !== null && now - socBelowWarnSince >= cfg.socHoldMs) {
    conditions.push({
      key: 'battery-low',
      severity: 'warning',
      values: { soc, threshold: cfg.socWarnBelow },
    });
  }

  // Solar: near-zero production in the middle of the day is a controller,
  // breaker or DVCC failure, actionable days before the batteries get low.
  const solar = fresh(telemetry.solarPower, now, INSTRUMENT_MAX_AGE_MS);
  let solarNoYieldSince = s.solarNoYieldSince;
  const inWindow =
    localHour !== null &&
    localHour >= cfg.solarWindow.startHour &&
    localHour < cfg.solarWindow.endHour;
  if (solar === null || !inWindow) {
    solarNoYieldSince = null;
  } else {
    solarNoYieldSince = solar < cfg.solarMinWatts ? (solarNoYieldSince ?? now) : null;
  }
  if (solarNoYieldSince !== null && now - solarNoYieldSince >= cfg.solarHoldMs) {
    conditions.push({
      key: 'solar-no-yield',
      severity: 'warning',
      values: { watts: solar, localHour },
    });
  }

  return {
    state: {
      fridge: fridge.state,
      freezer: freezer.state,
      socBelowWarnSince,
      socBelowCriticalSince,
      solarNoYieldSince,
    },
    result: { conditions, transitions },
  };
}

function roundK(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10) / 10;
}

/** Flat, dotted paths into MarinaConfig with display units and reasons, for the settings UI. */
export interface MarinaDoc {
  path: string;
  label: string;
  unit: 'K' | 'Kdelta' | 'ms' | 'fraction' | 'hour' | 'W';
  why: string;
}

export const MARINA_CONFIG_DOCS: MarinaDoc[] = [
  {
    path: 'fridge.warmAbove',
    label: 'Fridge warm above',
    unit: 'K',
    why: 'Above 8 °C food is not safe for long. A warning, because a door left open for a moment gets here too.',
  },
  {
    path: 'fridge.failingAbove',
    label: 'Fridge failing above',
    unit: 'K',
    why: 'A running fridge at 12 °C is dying: compressor, gas or a breaker. Critical.',
  },
  {
    path: 'fridge.offWithinOfAmbient',
    label: 'Fridge "off" band',
    unit: 'Kdelta',
    why: 'Within this many degrees of the cabin the box was deliberately shut down, not failing. Reported as a transition so a failure that drifts to ambient does not hide.',
  },
  {
    path: 'freezer.warmAbove',
    label: 'Freezer warm above',
    unit: 'K',
    why: 'A freezer above -12 °C is losing its hold. Warning.',
  },
  {
    path: 'freezer.failingAbove',
    label: 'Freezer failing above',
    unit: 'K',
    why: 'Above -5 °C the contents are thawing. Critical.',
  },
  {
    path: 'freezer.offWithinOfAmbient',
    label: 'Freezer "off" band',
    unit: 'Kdelta',
    why: 'Same trap as the fridge: a failed freezer eventually reads ambient and looks switched off.',
  },
  {
    path: 'bandHoldMs',
    label: 'Band hold',
    unit: 'ms',
    why: 'A temperature must sit in a band this long before the change is reported. Loading provisions spikes the box for a few minutes; a failure does not recover.',
  },
  {
    path: 'socWarnBelow',
    label: 'Battery warning below',
    unit: 'fraction',
    why: 'The house bank dips overnight and recovers by mid-morning. This is only reported after the hold below, so a normal night passes.',
  },
  {
    path: 'socCriticalBelow',
    label: 'Battery critical below',
    unit: 'fraction',
    why: 'Below this the bank is being damaged and the fridge is next to go.',
  },
  {
    path: 'socHoldMs',
    label: 'Battery hold',
    unit: 'ms',
    why: 'Twenty minutes rides through the last hour before sunrise; a bank that stays low is a charging problem.',
  },
  {
    path: 'solarWindow.startHour',
    label: 'Solar window start',
    unit: 'hour',
    why: 'Local hour from which the panels should be producing on any day of the year.',
  },
  {
    path: 'solarWindow.endHour',
    label: 'Solar window end',
    unit: 'hour',
    why: 'Local hour until which production is expected.',
  },
  {
    path: 'solarMinWatts',
    label: 'Solar minimum',
    unit: 'W',
    why: 'Below this inside the window counts as no yield: a controller, breaker or DVCC fault, actionable days before the batteries get low.',
  },
  {
    path: 'solarHoldMs',
    label: 'Solar hold',
    unit: 'ms',
    why: 'Two hours of nothing at midday is not a cloud.',
  },
];
