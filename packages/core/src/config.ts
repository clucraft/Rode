import { knotsToMps } from './units.js';

/**
 * Every tunable the alarm engine reads, in SI. The defaults below are not
 * guesses: each carries the field experience that produced it, and the UI
 * shows that explanation next to the control. See ALARM_CONFIG_DOCS.
 */
export interface AlarmConfig {
  // ---- swing circle
  /** Absolute margin added to the measured horizontal run, metres. */
  swingMargin: number;
  /** Metres of position uncertainty assumed per unit of HDOP. */
  hdopUere: number;
  /** Maximum HDOP-derived term added to the margin, metres. */
  hdopMarginCap: number;

  // ---- early warnings
  /** Warn when within this distance of the swing-circle edge, metres. Absolute, never a percentage. */
  warnDistance: number;
  /** How long the position must stay inside the warning band before the detector fires, ms. */
  positionHoldMs: number;
  /** How long the position must stay outside the circle before the alarm fires, ms. */
  outsideHoldMs: number;
  /** SOG above which the speed detector counts, m/s. */
  sogThreshold: number;
  /** SOG must exceed the threshold this long, ms. */
  sogHoldMs: number;
  /** A fired warning detector clears only after its condition is gone this long, ms. */
  clearHoldMs: number;

  // ---- data liveness
  /** No position update for this long → warning, ms. */
  gpsStaleWarnMs: number;
  /** No position update for this long → critical, ms. */
  gpsStaleCriticalMs: number;
  /** Source disconnected for this long → critical, ms. */
  sourceGraceMs: number;

  // ---- depth
  /** Alarm when live depth falls below this, metres. 0 disables. */
  minDepth: number;
  /** Depth must be below minimum this long, ms. */
  depthHoldMs: number;

  // ---- exclusion zones
  /** Project the boat's track this far ahead for zone warnings, ms. */
  zoneLookaheadMs: number;
  /** Zone conditions must persist this long, ms. */
  zoneHoldMs: number;

  // ---- acknowledgement
  /** How long an ack silences audio, ms. The condition itself is never cleared by an ack. */
  snoozeMs: number;
}

export const DEFAULT_ALARM_CONFIG: AlarmConfig = {
  swingMargin: 15,
  hdopUere: 3,
  hdopMarginCap: 20,

  warnDistance: 10,
  positionHoldMs: 10_000,
  outsideHoldMs: 5_000,
  sogThreshold: knotsToMps(1.2),
  sogHoldMs: 30_000,
  clearHoldMs: 10_000,

  gpsStaleWarnMs: 30_000,
  gpsStaleCriticalMs: 60_000,
  sourceGraceMs: 30_000,

  minDepth: 0,
  depthHoldMs: 10_000,

  zoneLookaheadMs: 5 * 60_000,
  zoneHoldMs: 5_000,

  snoozeMs: 10 * 60_000,
};

export type ConfigUnit = 'm' | 'm/s' | 'rad' | 'ms' | 'ratio';

export interface ConfigDoc {
  label: string;
  unit: ConfigUnit;
  /** One line on why the default is what it is. Shown in the UI next to the control. */
  why: string;
  min?: number;
  max?: number;
}

/**
 * Human explanations for every threshold. The UI renders these verbatim, with
 * the value converted to the user's display units.
 */
export const ALARM_CONFIG_DOCS: Record<keyof AlarmConfig, ConfigDoc> = {
  swingMargin: {
    label: 'Swing margin',
    unit: 'm',
    why: 'Covers GPS error, veering and rode stretch beyond the measured run. 15 m is comfortable for a chain rode in normal holding.',
    min: 0,
    max: 100,
  },
  hdopUere: {
    label: 'Position uncertainty per HDOP',
    unit: 'm',
    why: 'Consumer GNSS is roughly 3 m of error per unit of HDOP. The margin grows with a poor fix so a bad sky does not become a false alarm.',
    min: 0,
    max: 10,
  },
  hdopMarginCap: {
    label: 'Maximum HDOP margin',
    unit: 'm',
    why: 'Stops a terrible fix from inflating the circle until it means nothing.',
    min: 0,
    max: 100,
  },
  warnDistance: {
    label: 'Warn distance from edge',
    unit: 'm',
    why: 'Absolute, not a percentage. Percentage warnings fire constantly at tight radii and the crew learns to ignore them; a fixed distance works at any radius.',
    min: 0,
    max: 100,
  },
  positionHoldMs: {
    label: 'Position warning hold',
    unit: 'ms',
    why: 'GPS scatter can put a single fix in the warning band. Ten seconds of it is a boat that has moved.',
    min: 0,
    max: 120_000,
  },
  outsideHoldMs: {
    label: 'Outside-circle hold',
    unit: 'ms',
    why: 'Short, because this is the primary alarm; long enough that one glitched fix cannot fire it.',
    min: 0,
    max: 60_000,
  },
  sogThreshold: {
    label: 'Speed threshold',
    unit: 'm/s',
    why: '0.5 kn sits inside GPS noise for a stationary boat. 1.2 kn was the value that stopped tripping on calm nights.',
    min: 0,
    max: knotsToMps(5),
  },
  sogHoldMs: {
    label: 'Speed hold',
    unit: 'ms',
    why: 'Swinging on a shift produces short bursts of SOG. Thirty seconds sustained is movement.',
    min: 0,
    max: 300_000,
  },
  clearHoldMs: {
    label: 'Warning clear hold',
    unit: 'ms',
    why: 'Hysteresis. A warning that flickers on and off at the threshold is worse than one that stays up ten seconds too long.',
    min: 0,
    max: 120_000,
  },
  gpsStaleWarnMs: {
    label: 'GPS stale warning',
    unit: 'ms',
    why: 'An anchor watch with no position is blind and does not know it. Thirty seconds without a fix is worth a look.',
    min: 5_000,
    max: 300_000,
  },
  gpsStaleCriticalMs: {
    label: 'GPS stale critical',
    unit: 'ms',
    why: 'A minute blind at anchor is an emergency, whatever the cause. Clears itself when the fix returns.',
    min: 10_000,
    max: 600_000,
  },
  sourceGraceMs: {
    label: 'Source disconnect grace',
    unit: 'ms',
    why: 'WiFi to the hub drops for a few seconds routinely. Beyond thirty, the reconnect has failed and someone should know.',
    min: 5_000,
    max: 300_000,
  },
  minDepth: {
    label: 'Minimum depth',
    unit: 'm',
    why: 'Shoaling on a falling tide. Set it to your draft plus what you can sleep on; zero disables.',
    min: 0,
    max: 50,
  },
  depthHoldMs: {
    label: 'Depth hold',
    unit: 'ms',
    why: 'Sounders read weed and fish. Ten seconds below the line is water, not a fish.',
    min: 0,
    max: 120_000,
  },
  zoneLookaheadMs: {
    label: 'Zone look-ahead',
    unit: 'ms',
    why: 'Warn when the current course and speed reach a zone within this window. Five minutes is time to get on deck.',
    min: 0,
    max: 30 * 60_000,
  },
  zoneHoldMs: {
    label: 'Zone hold',
    unit: 'ms',
    why: 'Same hysteresis logic as the swing circle: one fix inside a zone is noise, five seconds is a boat.',
    min: 0,
    max: 60_000,
  },
  snoozeMs: {
    label: 'Acknowledge snooze',
    unit: 'ms',
    why: 'Silences audio, never the condition. Re-fires at higher volume if still alarming when the snooze ends.',
    min: 60_000,
    max: 60 * 60_000,
  },
};

/** Merge a partial override onto the defaults, dropping undefined keys. */
export function resolveAlarmConfig(partial?: Partial<AlarmConfig>): AlarmConfig {
  const out: AlarmConfig = { ...DEFAULT_ALARM_CONFIG };
  if (!partial) return out;
  for (const key of Object.keys(partial) as (keyof AlarmConfig)[]) {
    const v = partial[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}
