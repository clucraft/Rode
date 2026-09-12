/**
 * Sustained-condition detector with hysteresis.
 *
 * Every warning and alarm in Rode goes through one of these. A raw condition
 * must hold continuously for `onHoldMs` before the detector fires, and must be
 * continuously false for `offHoldMs` before it clears. No single-sample
 * triggers, no flicker at the threshold.
 *
 * The state is a plain object so it can be persisted with the session and
 * survive a restart with its timers intact.
 */
export interface SustainedState {
  /** When the raw condition became continuously true; null when it is false or unknown. */
  trueSince: number | null;
  /** When the raw condition became continuously false while active; null otherwise. */
  falseSince: number | null;
  /** Whether the detector has fired and not yet cleared. */
  active: boolean;
  /** When the detector fired. */
  activeSince: number | null;
}

export function sustainedInit(): SustainedState {
  return { trueSince: null, falseSince: null, active: false, activeSince: null };
}

export type SustainedChange = 'fired' | 'cleared' | null;

/**
 * Advance the detector one step.
 *
 * `raw` is the instantaneous condition. Pass `null` to *hold*: the input is
 * unavailable this tick (position stale, sensor off) and the detector should
 * neither accumulate nor clear. Pass `false` when the condition is known to be
 * absent, including when it is deliberately suppressed (wind below the floor).
 */
export function sustainedStep(
  s: SustainedState,
  raw: boolean | null,
  now: number,
  onHoldMs: number,
  offHoldMs: number,
): { state: SustainedState; change: SustainedChange } {
  if (raw === null) return { state: s, change: null };

  if (raw) {
    const trueSince = s.trueSince ?? now;
    if (!s.active && now - trueSince >= onHoldMs) {
      return {
        state: { trueSince, falseSince: null, active: true, activeSince: now },
        change: 'fired',
      };
    }
    return { state: { ...s, trueSince, falseSince: null }, change: null };
  }

  // raw === false
  if (s.active) {
    const falseSince = s.falseSince ?? now;
    if (now - falseSince >= offHoldMs) {
      return { state: sustainedInit(), change: 'cleared' };
    }
    return { state: { ...s, trueSince: null, falseSince }, change: null };
  }
  if (s.trueSince !== null) {
    return { state: { ...s, trueSince: null }, change: null };
  }
  return { state: s, change: null };
}

/**
 * A field is usable this tick when it exists and its sample is younger than
 * `maxAgeMs`. The normaliser's own `stale` flag is respected too.
 */
export function fresh<T>(
  field: { value: T; timestamp: number; stale: boolean } | undefined,
  now: number,
  maxAgeMs: number,
): T | null {
  if (!field || field.stale) return null;
  if (now - field.timestamp > maxAgeMs) return null;
  return field.value;
}
