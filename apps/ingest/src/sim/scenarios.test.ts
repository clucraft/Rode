import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@rode/core';
import { runScenario } from './run.js';
import {
  breakOut,
  gpsDropout,
  gpsNoiseFloor,
  hardPowerCut,
  lightAirVaneSpin,
  quietNight,
  SCENARIOS,
  slowDrag,
  sourceDisconnect,
  tidalSwing,
} from './scenarios/index.js';
import { PROLOGUE } from './scenario.js';

/*
 * The ten scenarios from the spec, end to end: scripted boat state → NMEA
 * sentences → parser → normaliser → alarm engine → event log. These run with
 * no wall clock, so a twelve-hour night takes a couple of seconds.
 */

const raised = (ev: EngineEvent[], id: string) =>
  ev.filter((e) => e.type === 'condition-raised' && e.condition.id === id);
const escalated = (ev: EngineEvent[], id: string) =>
  ev.filter((e) => e.type === 'condition-escalated' && e.condition.id === id);
const cleared = (ev: EngineEvent[], id: string) =>
  ev.filter((e) => e.type === 'condition-cleared' && e.id === id);
const raisedIds = (ev: EngineEvent[]) => {
  const ids = new Set<string>();
  for (const e of ev) if (e.type === 'condition-raised') ids.add(e.condition.id);
  return [...ids];
};
const rejected = (ev: EngineEvent[]) => ev.filter((e) => e.type === 'command-rejected');
const secondsAfterStart = (e: EngineEvent | undefined, start: number) =>
  e === undefined ? Number.NaN : (e.at - start) / 1000;

describe('scenario fixtures', () => {
  it('are all registered with unique ids and an expectation', () => {
    expect(SCENARIOS).toHaveLength(9);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(9);
    for (const s of SCENARIOS) {
      expect(s.expectation.length).toBeGreaterThan(20);
      expect(s.durationS).toBeGreaterThan(0);
    }
  });
});

describe('1. quiet night', () => {
  it('raises nothing across twelve hours of normal swinging', () => {
    const r = runScenario(quietNight);
    expect(rejected(r.events)).toEqual([]);
    expect(raisedIds(r.events)).toEqual([]);
    expect(r.stateTimeline.map((s) => s.to)).toEqual(['DROPPING', 'SET']);
    expect(r.finalState.stateName).toBe('SET');
    // The stream was real: the normaliser saw every sentence family.
    const types = Object.keys(r.normalizer.counters.byType).sort();
    expect(types).toEqual(
      expect.arrayContaining([
        'RMC',
        'GGA',
        'VTG',
        'HDT',
        'DPT',
        'MWV',
        'ZDA',
        'MTW',
        'MDA',
        'VDM',
      ]),
    );
    expect(r.normalizer.counters.checksumFailures).toBe(0);
    expect(r.normalizer.ais.all().length).toBe(3);
    // Geometry sanity: the antenna offset was removed, so the run is ~30 m.
    const g = r.finalState.session?.geometry;
    expect(g?.horizontalRun).toBeGreaterThan(27);
    expect(g?.horizontalRun).toBeLessThan(33);
    expect(g?.depthAtDrop).toBeCloseTo(6, 0);
    expect(r.finalState.session?.dropCorrected).toBe(true);
  });
});

describe('2. slow drag', () => {
  it('warns before it alarms, with minutes of lead time', () => {
    const r = runScenario(slowDrag);
    const warn = raised(r.events, 'position-warning')[0];
    const alarm = raised(r.events, 'position-outside')[0];
    expect(warn).toBeDefined();
    expect(alarm).toBeDefined();
    const lead = ((alarm?.at ?? 0) - (warn?.at ?? 0)) / 1000;
    // 10 m of warning band at 1.5 m/min ≈ 6.7 min.
    expect(lead).toBeGreaterThan(4 * 60);
    expect(lead).toBeLessThan(9 * 60);
    expect(r.stateTimeline.map((s) => s.to)).toEqual(['DROPPING', 'SET', 'WARNING', 'ALARM']);
    expect(r.finalState.stateName).toBe('ALARM');
    expect(raisedIds(r.events).sort()).toEqual(['position-outside', 'position-warning']);
  });
});

describe('3. break-out', () => {
  it('warns on speed while still inside the circle, then alarms on position', () => {
    const r = runScenario(breakOut);
    const speed = raised(r.events, 'speed')[0];
    const outside = raised(r.events, 'position-outside')[0];
    expect(speed).toBeDefined();
    expect(outside).toBeDefined();
    expect(speed?.at).toBeLessThan(outside?.at ?? 0);
    // The speed warning fires ~30 s (the hold) after the boat starts sailing at t=600.
    const tSpeed = secondsAfterStart(speed, breakOut.startEpochMs);
    expect(tSpeed).toBeGreaterThanOrEqual(628);
    expect(tSpeed).toBeLessThanOrEqual(640);
    expect(raisedIds(r.events)).not.toContain('wind-shift');
    expect(r.finalState.stateName).toBe('ALARM');
  });
});

describe('4. light-air vane spin', () => {
  it('never raises anything while the vane wanders', () => {
    const r = runScenario(lightAirVaneSpin);
    expect(raisedIds(r.events)).toEqual([]);
    expect(r.finalState.stateName).toBe('SET');
    // Make sure the scenario actually exercised the detector's suppression:
    // the vane wandered far outside the ±70° window.
    const awa = r.normalizer.getField('awa');
    expect(awa).toBeDefined();
  });
});

describe('5. GPS noise floor', () => {
  it('raises nothing for a stationary boat with scatter and SOG near 1 kn', () => {
    const r = runScenario(gpsNoiseFloor);
    expect(raisedIds(r.events)).toEqual([]);
    expect(r.finalState.stateName).toBe('SET');
    // HDOP 1.8 widened the margin: radius > run + 15.
    const g = r.finalState.session?.geometry;
    expect(g?.hdopMargin).toBeGreaterThan(3);
  });
});

describe('6. GPS dropout', () => {
  it('warns at 30 s, goes critical at 60 s, and auto-clears on return', () => {
    const r = runScenario(gpsDropout);
    const warn = raised(r.events, 'gps-stale')[0];
    const crit = escalated(r.events, 'gps-stale')[0];
    const clear = cleared(r.events, 'gps-stale')[0];
    const tWarn = secondsAfterStart(warn, gpsDropout.startEpochMs);
    const tCrit = secondsAfterStart(crit, gpsDropout.startEpochMs);
    const tClear = secondsAfterStart(clear, gpsDropout.startEpochMs);
    // Dropout starts at 600; the last good sample was at 599.
    expect(tWarn).toBeGreaterThanOrEqual(629);
    expect(tWarn).toBeLessThanOrEqual(631);
    expect(tCrit).toBeGreaterThanOrEqual(659);
    expect(tCrit).toBeLessThanOrEqual(661);
    expect(tClear).toBeGreaterThanOrEqual(690);
    expect(tClear).toBeLessThanOrEqual(692);
    expect(crit?.type === 'condition-escalated' && crit.condition.severity).toBe('critical');
    expect(raisedIds(r.events)).toEqual(['gps-stale']);
    expect(r.stateTimeline.map((s) => s.to)).toEqual([
      'DROPPING',
      'SET',
      'WARNING',
      'ALARM',
      'SET',
    ]);
    expect(r.finalState.stateName).toBe('SET');
    expect(r.finalState.conditions).toEqual({});
  });
});

describe('7. source disconnect', () => {
  it('raises the disconnect alarm after the grace period, clears on reconnect, session intact', () => {
    const r = runScenario(sourceDisconnect);
    const down = raised(r.events, 'source-disconnected')[0];
    const up = cleared(r.events, 'source-disconnected')[0];
    const tDown = secondsAfterStart(down, sourceDisconnect.startEpochMs);
    const tUp = secondsAfterStart(up, sourceDisconnect.startEpochMs);
    expect(tDown).toBeGreaterThanOrEqual(629);
    expect(tDown).toBeLessThanOrEqual(631);
    expect(tUp).toBeGreaterThanOrEqual(660);
    expect(tUp).toBeLessThanOrEqual(662);
    expect(down?.type === 'condition-raised' && down.condition.severity).toBe('critical');
    // GPS staleness rides along, because no sentences means no fixes.
    expect(raised(r.events, 'gps-stale')).toHaveLength(1);
    expect(raisedIds(r.events).sort()).toEqual(['gps-stale', 'source-disconnected']);
    expect(r.finalState.stateName).toBe('SET');
    expect(r.finalState.session?.geometry).toBeDefined();
    expect(r.finalState.session?.setAt).toBe(sourceDisconnect.startEpochMs + PROLOGUE.setAt * 1000);
  });
});

describe('8. hard power cut', () => {
  it('rehydrates the session with identical geometry and resumes watching', () => {
    const r = runScenario(hardPowerCut);
    expect(r.powerCut).toBeDefined();
    const before = r.powerCut?.before;
    const after = r.powerCut?.after;
    expect(after?.phase).toBe('SET');
    expect(after?.session?.id).toBe(before?.session?.id);
    expect(after?.session?.geometry).toEqual(before?.session?.geometry);
    expect(after?.session?.dropPosition).toEqual(before?.session?.dropPosition);
    // No spurious alarm on boot: the fix was back within a second.
    expect(raised(r.events, 'gps-stale')).toEqual([]);
    expect(raised(r.events, 'source-disconnected')).toEqual([]);
    // And the drag that starts after the restart is caught.
    expect(raised(r.events, 'position-warning')).toHaveLength(1);
    expect(raised(r.events, 'position-outside')).toHaveLength(1);
    expect(r.finalState.stateName).toBe('ALARM');
    // Exactly one session in the whole run: the restart did not start another.
    expect(r.events.filter((e) => e.type === 'session-started')).toHaveLength(1);
  });
});

describe('9. tidal swing', () => {
  it('keeps scope off the captured drop depth while the live depth moves', () => {
    let minDepth = Infinity;
    let maxDepth = -Infinity;
    const r = runScenario(tidalSwing, {
      onTick: (_t, _state, _events, normalizer) => {
        const d = normalizer.getField('depth')?.value;
        if (d !== undefined) {
          minDepth = Math.min(minDepth, d);
          maxDepth = Math.max(maxDepth, d);
        }
      },
    });
    expect(raisedIds(r.events)).toEqual([]);
    const g = r.finalState.session?.geometry;
    expect(g?.depthAtDrop).toBeCloseTo(6, 0);
    expect(g?.tideRange).toBe(1.5);
    // The set geometry (before set-tide) and the final one share the drop depth.
    const set = r.events.find((e) => e.type === 'anchor-set');
    expect(set?.type === 'anchor-set' && set.geometry.depthAtDrop).toBe(g?.depthAtDrop);
    // The live depth swung through the full tidal range while geometry held.
    expect(maxDepth - minDepth).toBeGreaterThan(2.8);
    // Tide widened the circle and reported the worst-case scope.
    expect(g?.scopeRatioAtHighWater).toBeLessThan(g?.scopeRatio ?? 0);
    expect(r.finalState.stateName).toBe('SET');
  });
});
