import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fresh, sustainedInit, sustainedStep, type SustainedState } from './detectors.js';

const ON = 30_000;
const OFF = 10_000;

/** Feed a sequence of raw values at 1 Hz from t=0 and return the trace of changes. */
function run(raws: (boolean | null)[], on = ON, off = OFF) {
  let s: SustainedState = sustainedInit();
  const changes: { t: number; change: 'fired' | 'cleared' }[] = [];
  raws.forEach((raw, i) => {
    const t = i * 1000;
    const r = sustainedStep(s, raw, t, on, off);
    s = r.state;
    if (r.change) changes.push({ t, change: r.change });
  });
  return { state: s, changes };
}

describe('sustainedStep', () => {
  it('does not fire on a single sample', () => {
    const { state, changes } = run([true, false, false]);
    expect(changes).toEqual([]);
    expect(state.active).toBe(false);
  });

  it('fires once the condition has held for the on-hold', () => {
    const raws = Array<boolean>(35).fill(true);
    const { changes } = run(raws);
    expect(changes).toEqual([{ t: 30_000, change: 'fired' }]);
  });

  it('resets accumulation on a false sample', () => {
    // 29 s true, 1 s false, 29 s true: never reaches 30 s continuous.
    const raws = [...Array<boolean>(29).fill(true), false, ...Array<boolean>(29).fill(true)];
    expect(run(raws).changes).toEqual([]);
  });

  it('holds (neither accumulates nor clears) on null', () => {
    // 20 s true, 20 s unknown, then true again: the 20 s already banked survive.
    const raws = [
      ...Array<boolean>(20).fill(true),
      ...Array<null>(20).fill(null),
      ...Array<boolean>(15).fill(true),
    ];
    const { changes } = run(raws);
    // trueSince = 0; at t=40 s..54 s the condition is true; fires when now - 0 >= 30 s → t=40 s.
    expect(changes).toEqual([{ t: 40_000, change: 'fired' }]);
  });

  it('clears only after the off-hold', () => {
    const raws = [...Array<boolean>(31).fill(true), ...Array<boolean>(12).fill(false)];
    const { changes } = run(raws);
    expect(changes).toEqual([
      { t: 30_000, change: 'fired' },
      { t: 41_000, change: 'cleared' },
    ]);
  });

  it('does not clear when the condition flickers back within the off-hold', () => {
    const raws = [
      ...Array<boolean>(31).fill(true),
      ...Array<boolean>(5).fill(false),
      ...Array<boolean>(5).fill(true),
      ...Array<boolean>(5).fill(false),
    ];
    const { state, changes } = run(raws);
    expect(changes).toEqual([{ t: 30_000, change: 'fired' }]);
    expect(state.active).toBe(true);
  });

  it('fires immediately with a zero hold', () => {
    expect(run([true], 0, 0).changes).toEqual([{ t: 0, change: 'fired' }]);
  });

  it('never fires unless the condition was true continuously for the hold (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 200 }), (raws) => {
        const hold = 5_000;
        const { changes } = run(raws, hold, 2_000);
        for (const c of changes.filter((x) => x.change === 'fired')) {
          const i = c.t / 1000;
          // The five samples ending at i must all be true.
          for (let k = i - 5; k <= i; k++) expect(raws[k]).toBe(true);
        }
      }),
    );
  });

  it('is idempotent on the state object (does not mutate input)', () => {
    const s = sustainedInit();
    const frozen = Object.freeze({ ...s });
    sustainedStep(frozen, true, 0, ON, OFF);
    expect(frozen).toEqual(sustainedInit());
  });
});

describe('fresh', () => {
  it('returns the value when young enough', () => {
    expect(fresh({ value: 3, timestamp: 1000, stale: false }, 2000, 5000)).toBe(3);
  });

  it('returns null when missing, stale-flagged, or too old', () => {
    expect(fresh(undefined, 0, 1000)).toBeNull();
    expect(fresh({ value: 3, timestamp: 0, stale: true }, 0, 1000)).toBeNull();
    expect(fresh({ value: 3, timestamp: 0, stale: false }, 5000, 1000)).toBeNull();
  });
});
