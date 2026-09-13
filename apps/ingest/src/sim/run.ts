import {
  applyCommand,
  createWatchState,
  rehydrateWatchState,
  resolveAlarmConfig,
  tick,
  type EngineContext,
  type EngineEvent,
  type ExclusionZone,
  type WatchState,
} from '@rode/core';
import { Normalizer } from '../normalize.js';
import { sentencesFor } from './generator.js';
import type { Scenario } from './scenario.js';

/**
 * Headless scenario runner: scenario → NMEA sentences → parser → normaliser →
 * alarm engine, one second at a time, with no wall-clock involvement. This is
 * the integration path the ten scenario tests use, and what `rode-sim run`
 * prints from the command line.
 */
export interface RunOptions {
  zones?: ExclusionZone[];
  /** Called each scenario second after the tick. */
  onTick?: (t: number, state: WatchState, events: EngineEvent[], normalizer: Normalizer) => void;
}

export interface RunResult {
  events: EngineEvent[];
  finalState: WatchState;
  /** Every state-changed event's target, in order. */
  stateTimeline: { t: number; to: string }[];
  /** Snapshots around a simulated power cut, when the scenario has one. */
  powerCut?: { before: WatchState; after: WatchState };
  normalizer: Normalizer;
}

export function runScenario(scenario: Scenario, opts: RunOptions = {}): RunResult {
  const config = resolveAlarmConfig(scenario.alarmConfig);
  let normalizer = new Normalizer();
  let ids = 0;
  const newId = () => `sim-${scenario.id}-${++ids}`;

  const t0 = scenario.startEpochMs;
  let state = createWatchState(t0);
  const events: EngineEvent[] = [];
  const stateTimeline: { t: number; to: string }[] = [];
  let powerCut: RunResult['powerCut'];
  let persisted: string | null = null;
  let disconnectedSince: number | null = null;

  const commands = [...scenario.commands].sort((a, b) => a.at - b.at);
  let nextCommand = 0;

  for (let t = 0; t <= scenario.durationS; t++) {
    const now = t0 + t * 1000;
    const cut = scenario.powerCut;

    // ---- power cut: the process is gone. Persist at the moment of the cut,
    // skip everything until restart, then boot with a fresh normaliser and
    // the persisted engine state.
    if (cut?.cutAt === t) {
      persisted = JSON.stringify(state);
      powerCut = { before: JSON.parse(persisted) as WatchState, after: state };
    }
    if (cut && t > cut.cutAt && t < cut.restartAt) continue;
    if (cut?.restartAt === t && persisted) {
      state = rehydrateWatchState(JSON.parse(persisted) as WatchState, now);
      normalizer = new Normalizer();
      disconnectedSince = null;
      if (powerCut) powerCut.after = state;
    }

    const boat = scenario.state(t);
    if (boat.connected) {
      disconnectedSince = null;
      normalizer.setSourceState({ connected: true, since: t0 });
      for (const line of sentencesFor(boat, t)) normalizer.feedLine(line, now, 'sim');
    } else {
      disconnectedSince ??= now;
      normalizer.setSourceState({ connected: false, since: disconnectedSince });
    }

    const ctx: EngineContext = {
      now,
      telemetry: normalizer.snapshot(now),
      config,
      boat: scenario.boat,
      zones: opts.zones ?? [],
      newId,
    };

    const tickEvents: EngineEvent[] = [];
    while (nextCommand < commands.length && (commands[nextCommand]?.at ?? Infinity) <= t) {
      const c = commands[nextCommand++];
      if (!c) break;
      const r = applyCommand(state, c.command, ctx);
      state = r.state;
      tickEvents.push(...r.events);
    }
    const r = tick(state, ctx);
    state = r.state;
    tickEvents.push(...r.events);

    for (const e of tickEvents) {
      events.push(e);
      if (e.type === 'state-changed') stateTimeline.push({ t, to: e.to });
    }
    opts.onTick?.(t, state, tickEvents, normalizer);
  }

  const result: RunResult = { events, finalState: state, stateTimeline, normalizer };
  if (powerCut) result.powerCut = powerCut;
  return result;
}
