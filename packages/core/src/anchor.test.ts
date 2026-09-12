import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createWatchState,
  deriveStateName,
  effectiveRadii,
  isSnoozed,
  rehydrateWatchState,
  tick,
  type Command,
  type EngineContext,
  type EngineEvent,
  type WatchState,
} from './anchor.js';
import { DEFAULT_ALARM_CONFIG, type AlarmConfig } from './config.js';
import { DEFAULT_MARINA_CONFIG, type MarinaConfig } from './marina.js';
import { destination } from './geodesy.js';
import type { BoatGeometry, Field, LatLon, Telemetry } from './types.js';
import { celsiusToKelvin, degToRad, knotsToMps } from './units.js';
import type { ExclusionZone } from './zones.js';

// ---------------------------------------------------------------- harness

const ANCHOR: LatLon = { lat: 32.29, lon: -64.83 };
const BOAT: BoatGeometry = { antennaToBowForward: 0, antennaToBowStarboard: 0, bowRollerHeight: 1 };
const DEPTH = 5; // vertical drop 6 m with the roller

interface Scene {
  /** Boat (antenna) position; defaults to `at(bearing, distance)` helpers. */
  position?: LatLon | null;
  sog?: number | null;
  cog?: number | null;
  heading?: number | null;
  depth?: number | null;
  awa?: number | null;
  aws?: number | null;
  hdop?: number | null;
  connected?: boolean;
  /** Age of the position sample relative to now, ms. */
  positionAge?: number;
  fridgeTemp?: number | null;
  freezerTemp?: number | null;
  airTemp?: number | null;
  batterySoc?: number | null;
  solarPower?: number | null;
  localHour?: number | null;
}

function field<T>(value: T, now: number, age = 0): Field<T> {
  return { value, timestamp: now - age, source: 'test', stale: false };
}

class Harness {
  state: WatchState;
  now: number;
  events: EngineEvent[] = [];
  config: AlarmConfig;
  marinaConfig: MarinaConfig;
  zones: ExclusionZone[] = [];
  boat: BoatGeometry;
  private ids = 0;
  private disconnectedSince: number | null = null;

  constructor(
    opts: {
      config?: Partial<AlarmConfig>;
      marinaConfig?: Partial<MarinaConfig>;
      boat?: BoatGeometry;
      start?: number;
    } = {},
  ) {
    this.now = opts.start ?? 1_700_000_000_000;
    this.config = { ...DEFAULT_ALARM_CONFIG, ...opts.config };
    this.marinaConfig = { ...DEFAULT_MARINA_CONFIG, ...opts.marinaConfig };
    this.boat = opts.boat ?? BOAT;
    this.state = createWatchState(this.now);
  }

  ctx(scene: Scene): EngineContext {
    const now = this.now;
    const t: Telemetry = { source: { connected: true, since: now - 3_600_000 } };
    const connected = scene.connected ?? true;
    if (!connected) {
      this.disconnectedSince ??= now;
      t.source = { connected: false, since: this.disconnectedSince };
    } else {
      this.disconnectedSince = null;
    }
    if (scene.position !== null) {
      t.position = field(scene.position ?? ANCHOR, now, scene.positionAge ?? 0);
    }
    type NumKey =
      | 'sog'
      | 'cog'
      | 'heading'
      | 'depth'
      | 'awa'
      | 'aws'
      | 'hdop'
      | 'fridgeTemp'
      | 'freezerTemp'
      | 'airTemp'
      | 'batterySoc'
      | 'solarPower';
    const num = (k: NumKey, v: number | null | undefined, dflt?: number) => {
      const val = v === undefined ? dflt : v;
      if (val !== null && val !== undefined) t[k] = field(val, now);
    };
    num('sog', scene.sog, 0.1);
    num('cog', scene.cog, 0);
    num('heading', scene.heading, 0);
    num('depth', scene.depth, DEPTH);
    num('awa', scene.awa, 0);
    num('aws', scene.aws, knotsToMps(12));
    num('hdop', scene.hdop, 1);
    num('fridgeTemp', scene.fridgeTemp);
    num('freezerTemp', scene.freezerTemp);
    num('airTemp', scene.airTemp);
    num('batterySoc', scene.batterySoc);
    num('solarPower', scene.solarPower);
    return {
      now,
      telemetry: t,
      config: this.config,
      boat: this.boat,
      zones: this.zones,
      marinaConfig: this.marinaConfig,
      localHour: scene.localHour ?? null,
      newId: () => `s${++this.ids}`,
    };
  }

  cmd(c: Command, scene: Scene = {}): EngineEvent[] {
    const r = applyCommand(this.state, c, this.ctx(scene));
    this.state = r.state;
    this.events.push(...r.events);
    return r.events;
  }

  /** Advance `seconds` at 1 Hz, ticking with the same scene each second. */
  run(seconds: number, scene: Scene | ((i: number) => Scene) = {}): EngineEvent[] {
    const out: EngineEvent[] = [];
    for (let i = 0; i < seconds; i++) {
      this.now += 1000;
      const s = typeof scene === 'function' ? scene(i) : scene;
      const r = tick(this.state, this.ctx(s));
      this.state = r.state;
      this.events.push(...r.events);
      out.push(...r.events);
    }
    return out;
  }

  /** Drop at the anchor, motor back `run` metres on `bearing`, set. */
  anchorUp(run = 30, bearing = 0) {
    expect(this.cmd({ type: 'drop' }, { position: ANCHOR }).map((e) => e.type)).toEqual([
      'session-started',
      'anchor-dropped',
      'state-changed',
    ]);
    this.run(5, { position: at(bearing, run / 2) });
    this.cmd({ type: 'set' }, { position: at(bearing, run) });
    expect(this.state.phase).toBe('SET');
    return this.state.session?.geometry;
  }

  types(events = this.events): string[] {
    return events.map((e) => e.type);
  }

  conditionKeys(): string[] {
    return Object.keys(this.state.conditions).sort();
  }
}

function at(bearingDeg: number, distance: number): LatLon {
  return destination(ANCHOR, degToRad(bearingDeg), distance);
}

const has = (events: EngineEvent[], type: EngineEvent['type']) =>
  events.some((e) => e.type === type);
const raised = (events: EngineEvent[], id: string) =>
  events.filter((e) => e.type === 'condition-raised' && e.condition.id === id);
const cleared = (events: EngineEvent[], id: string) =>
  events.filter((e) => e.type === 'condition-cleared' && e.id === id);

// ---------------------------------------------------------------- lifecycle

describe('lifecycle', () => {
  it('starts idle with a rode suggestion from live depth', () => {
    const h = new Harness();
    h.run(1, { depth: 7 });
    expect(h.state.stateName).toBe('IDLE');
    expect(h.state.live.suggestedRode).toBeCloseTo((7 + 1) * 5);
    expect(h.events).toEqual([]);
  });

  it('drop → set computes geometry and starts watching; weigh ends it', () => {
    const h = new Harness();
    const g = h.anchorUp(30);
    expect(g).toBeDefined();
    expect(g?.horizontalRun).toBeCloseTo(30, 1);
    expect(g?.verticalDrop).toBe(6);
    expect(g?.rodeLength).toBeCloseTo(Math.hypot(30, 6), 1);
    expect(g?.scopeRatio).toBeCloseTo(Math.hypot(30, 6) / 6, 2);
    expect(g?.swingRadius).toBeCloseTo(30 + 15 + 3, 1); // margin + hdop 1 × 3 m
    expect(h.state.session?.depthSource).toBe('sounder');
    expect(h.state.session?.dropCorrected).toBe(false); // zero antenna offset

    h.run(10, { position: at(0, 30) });
    expect(h.state.stateName).toBe('SET');
    expect(h.conditionKeys()).toEqual([]);

    const ev = h.cmd({ type: 'weigh', by: 'skipper' });
    expect(ev.map((e) => e.type)).toEqual(['session-ended', 'state-changed']);
    expect(h.state.phase).toBe('IDLE');
    expect(h.state.session?.endedAt).toBe(h.now);
  });

  it('applies the antenna offset at drop and set', () => {
    const h = new Harness({ boat: { ...BOAT, antennaToBowForward: 10 } });
    // Heading north: bow roller is 10 m north of the antenna.
    h.cmd({ type: 'drop' }, { position: ANCHOR, heading: 0 });
    expect(h.state.session?.dropCorrected).toBe(true);
    const drop = h.state.session?.dropPosition;
    expect(drop?.lat).toBeGreaterThan(ANCHOR.lat);
    h.run(3, { position: at(0, 15), heading: 0 });
    h.cmd({ type: 'set' }, { position: at(0, 30), heading: 0 });
    // Both corrected by the same 10 m, so the run is still 30 m.
    expect(h.state.session?.geometry?.horizontalRun).toBeCloseTo(30, 1);
  });

  it('is idempotent: repeated drop/set/marina/weigh do nothing', () => {
    const h = new Harness();
    h.cmd({ type: 'drop' });
    expect(h.cmd({ type: 'drop' })).toEqual([]);
    h.cmd({ type: 'set' }, { position: at(0, 20) });
    expect(h.cmd({ type: 'set' })).toEqual([]);
    h.cmd({ type: 'weigh' });
    expect(h.cmd({ type: 'weigh' })).toEqual([]);
    h.cmd({ type: 'marina' });
    expect(h.cmd({ type: 'marina' })).toEqual([]);
  });

  it('rejects commands in the wrong state with a reason', () => {
    const h = new Harness();
    expect(h.cmd({ type: 'set' })[0]).toMatchObject({
      type: 'command-rejected',
      reason: 'not-dropping',
    });
    expect(h.cmd({ type: 'ack', by: 'x' })[0]).toMatchObject({ reason: 'nothing-to-ack' });
    expect(h.cmd({ type: 'nudge', anchor: ANCHOR })[0]).toMatchObject({ reason: 'not-set' });
    h.cmd({ type: 'drop' });
    expect(h.cmd({ type: 'marina' })[0]).toMatchObject({ reason: 'not-idle' });
    expect(h.cmd({ type: 'drop' })).toEqual([]); // DROPPING: idempotent
    h.cmd({ type: 'set' }, { position: at(0, 20) });
    expect(h.cmd({ type: 'drop' })[0]).toMatchObject({ reason: 'not-idle' });
  });

  it('refuses to drop or set without a usable fix', () => {
    const h = new Harness();
    expect(h.cmd({ type: 'drop' }, { position: null })[0]).toMatchObject({
      reason: 'position-required',
    });
    expect(h.cmd({ type: 'drop' }, { positionAge: 60_000 })[0]).toMatchObject({
      reason: 'position-required',
    });
    h.cmd({ type: 'drop' });
    expect(h.cmd({ type: 'set' }, { position: null })[0]).toMatchObject({
      reason: 'position-required',
    });
  });

  it('requires a depth before set when the sounder was off at drop', () => {
    const h = new Harness();
    h.cmd({ type: 'drop' }, { depth: null });
    expect(h.state.session?.depthAtDrop).toBeNull();
    expect(h.cmd({ type: 'set' }, { position: at(0, 20) })[0]).toMatchObject({
      reason: 'depth-required',
    });
    expect(h.cmd({ type: 'set-depth', depth: 8 })[0]).toMatchObject({
      type: 'depth-entered',
      depth: 8,
    });
    expect(h.state.session?.depthSource).toBe('manual');
    h.cmd({ type: 'set' }, { position: at(0, 20) });
    expect(h.state.session?.geometry?.verticalDrop).toBe(9);
  });

  it('accepts a manual depth on drop', () => {
    const h = new Harness();
    h.cmd({ type: 'drop', manualDepth: 12 }, { depth: 5 });
    expect(h.state.session?.depthAtDrop).toBe(12);
    expect(h.state.session?.depthSource).toBe('manual');
  });

  it('keeps the drop depth when the sounder later changes (tidal swing)', () => {
    const h = new Harness();
    h.anchorUp(30);
    const before = h.state.session?.geometry;
    h.run(60, (i) => ({ position: at(0, 30), depth: DEPTH + i * 0.05 }));
    expect(h.state.session?.geometry).toEqual(before);
    expect(h.state.session?.depthAtDrop).toBe(DEPTH);
    expect(h.conditionKeys()).toEqual([]);
  });

  it('nudging the anchor recomputes geometry and restarts position timers', () => {
    const h = new Harness();
    h.anchorUp(30);
    const moved = at(90, 10);
    const ev = h.cmd({ type: 'nudge', anchor: moved });
    expect(ev[0]?.type).toBe('anchor-nudged');
    expect(h.state.session?.anchor).toEqual(moved);
    // Run from the new anchor to the set position (30 m north of the old one).
    expect(h.state.session?.geometry?.horizontalRun).toBeCloseTo(Math.hypot(30, 10), 0);
    expect(h.state.session?.dropPosition).toEqual(ANCHOR); // drop point untouched
  });

  it('tide range widens the circle and lowers the high-water scope', () => {
    const h = new Harness();
    const g0 = h.anchorUp(30);
    const ev = h.cmd({ type: 'set-tide', tideRange: 2 });
    expect(ev[0]?.type).toBe('tide-updated');
    const g1 = h.state.session?.geometry;
    expect(g1?.swingRadius).toBeGreaterThan(g0?.swingRadius ?? 0);
    expect(g1?.scopeRatioAtHighWater).toBeLessThan(g0?.scopeRatio ?? 0);
  });
});

// ---------------------------------------------------------------- scenarios

describe('scenario: quiet night', () => {
  it('a boat swinging on a wind shift raises nothing', () => {
    const h = new Harness();
    h.anchorUp(30);
    // Swing through 120° over an hour, sitting at the full run, small SOG jitter,
    // wind within ±40° of the bow at 12 kn.
    h.run(3600, (i) => ({
      position: at(-60 + (120 * i) / 3600, 30 + Math.sin(i / 7) * 2),
      sog: knotsToMps(0.3 + Math.abs(Math.sin(i / 11)) * 0.5),
      awa: degToRad(Math.sin(i / 13) * 40),
      aws: knotsToMps(12),
      heading: degToRad(-60 + (120 * i) / 3600),
    }));
    expect(h.conditionKeys()).toEqual([]);
    expect(h.state.stateName).toBe('SET');
    expect(has(h.events, 'condition-raised')).toBe(false);
  });
});

describe('scenario: slow drag', () => {
  it('warns before it alarms, with lead time', () => {
    const h = new Harness();
    const g = h.anchorUp(30);
    const radius = g?.swingRadius ?? 0;
    // Drift outwards 1.5 m per minute from 30 m to radius + 10 m over 20 minutes.
    const total = 20 * 60;
    const from = 30;
    const to = radius + 10;
    const ev = h.run(total, (i) => ({
      position: at(0, from + ((to - from) * i) / total),
      sog: knotsToMps(0.4),
    }));
    const warn = ev.find(
      (e) => e.type === 'condition-raised' && e.condition.id === 'position-warning',
    );
    const alarm = ev.find(
      (e) => e.type === 'condition-raised' && e.condition.id === 'position-outside',
    );
    expect(warn).toBeDefined();
    expect(alarm).toBeDefined();
    const lead = (alarm?.at ?? 0) - (warn?.at ?? 0);
    // 10 m of warn band at 1.5 m/min ≈ 6.7 min; hold differences shave a few seconds.
    expect(lead).toBeGreaterThan(5 * 60_000);
    expect(lead).toBeLessThan(8 * 60_000);
    expect(h.state.stateName).toBe('ALARM');
    const states = h.events.filter((e) => e.type === 'state-changed').map((e) => e.to);
    expect(states).toEqual(['DROPPING', 'SET', 'WARNING', 'ALARM']);
  });
});

describe('scenario: break-out', () => {
  it('escalates straight to critical when wind angle and speed fire together', () => {
    const h = new Harness();
    h.anchorUp(30);
    h.run(60, { position: at(0, 30) });
    // Boat breaks out: SOG 2 kn, wind 120° off the bow, 15 kn, still inside the circle.
    const ev = h.run(45, (i) => ({
      position: at(90, 30 + i * 0.2),
      sog: knotsToMps(2),
      awa: degToRad(120),
      aws: knotsToMps(15),
    }));
    expect(raised(ev, 'wind-shift')).toHaveLength(1);
    expect(raised(ev, 'speed')).toHaveLength(1);
    expect(raised(ev, 'breakout')).toHaveLength(1);
    expect(raised(ev, 'position-outside')).toHaveLength(0);
    expect(h.state.stateName).toBe('ALARM');
    expect(h.state.conditions.breakout?.severity).toBe('critical');
  });
});

describe('scenario: light-air vane spin', () => {
  it('never raises a wind-shift warning below 5 kn apparent', () => {
    const h = new Harness();
    h.anchorUp(30);
    const ev = h.run(600, (i) => ({
      position: at(0, 28),
      sog: knotsToMps(0.2),
      awa: degToRad(((i * 37) % 360) - 180), // wild
      aws: knotsToMps(2 + Math.sin(i / 5) * 2), // 0–4 kn
    }));
    expect(raised(ev, 'wind-shift')).toHaveLength(0);
    expect(h.conditionKeys()).toEqual([]);
  });

  it('does raise it once the wind is above the floor', () => {
    const h = new Harness();
    h.anchorUp(30);
    const ev = h.run(45, { position: at(0, 28), awa: degToRad(100), aws: knotsToMps(8) });
    expect(raised(ev, 'wind-shift')).toHaveLength(1);
    // and clears when the wind falls back under the floor
    const ev2 = h.run(15, { position: at(0, 28), awa: degToRad(100), aws: knotsToMps(3) });
    expect(cleared(ev2, 'wind-shift')).toHaveLength(1);
  });
});

describe('scenario: GPS noise floor', () => {
  it('a stationary boat with scatter and SOG near 1 kn raises nothing', () => {
    const h = new Harness();
    h.anchorUp(30);
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const ev = h.run(1800, () => ({
      position: at(rnd() * 360, 28 + (rnd() - 0.5) * 6),
      sog: knotsToMps(0.6 + rnd() * 0.5), // 0.6–1.1 kn, under the 1.2 threshold
      awa: degToRad((rnd() - 0.5) * 60),
    }));
    expect(has(ev, 'condition-raised')).toBe(false);
  });
});

describe('scenario: GPS dropout', () => {
  it('warns at 30 s, goes critical at 60 s, and clears cleanly when the fix returns', () => {
    const h = new Harness();
    h.anchorUp(30);
    h.run(10, { position: at(0, 30) });
    // Position freezes: the same sample gets older every tick.
    const ev = h.run(90, (i) => ({ position: at(0, 30), positionAge: (i + 1) * 1000 }));
    const gps = ev.filter(
      (e) =>
        (e.type === 'condition-raised' || e.type === 'condition-escalated') &&
        e.condition.id === 'gps-stale',
    );
    expect(gps).toHaveLength(2);
    expect(gps[0]).toMatchObject({ type: 'condition-raised', condition: { severity: 'warning' } });
    expect(gps[1]).toMatchObject({
      type: 'condition-escalated',
      condition: { severity: 'critical' },
    });
    const t0 = h.now - 90_000;
    expect((gps[0]?.at ?? 0) - t0).toBeGreaterThanOrEqual(30_000);
    expect((gps[0]?.at ?? 0) - t0).toBeLessThanOrEqual(31_000);
    expect((gps[1]?.at ?? 0) - t0).toBeGreaterThanOrEqual(60_000);
    expect((gps[1]?.at ?? 0) - t0).toBeLessThanOrEqual(61_000);
    expect(h.state.stateName).toBe('ALARM');
    // Position detectors held rather than firing on the frozen position.
    expect(raised(ev, 'position-outside')).toHaveLength(0);

    const back = h.run(2, { position: at(0, 30) });
    expect(cleared(back, 'gps-stale')).toHaveLength(1);
    expect(h.state.stateName).toBe('SET');
    expect(h.conditionKeys()).toEqual([]);
  });

  it('counts staleness from boot when no fix has ever arrived', () => {
    const h = new Harness();
    h.anchorUp(30);
    h.state = rehydrateWatchState(h.state, h.now);
    const ev = h.run(35, { position: null });
    expect(raised(ev, 'gps-stale')).toHaveLength(1);
  });
});

describe('scenario: source disconnect', () => {
  it('raises critical after the grace period and clears on reconnect; session intact', () => {
    const h = new Harness();
    const g = h.anchorUp(30);
    h.run(5, { position: at(0, 30) });
    const ev = h.run(40, (i) => ({
      connected: false,
      position: at(0, 30),
      positionAge: (i + 1) * 1000,
    }));
    expect(raised(ev, 'source-disconnected')).toHaveLength(1);
    expect(h.state.conditions['source-disconnected']?.severity).toBe('critical');
    expect(h.state.session?.geometry).toEqual(g);
    const back = h.run(2, { connected: true, position: at(0, 30) });
    expect(cleared(back, 'source-disconnected')).toHaveLength(1);
    expect(cleared(back, 'gps-stale')).toHaveLength(1);
    expect(h.state.phase).toBe('SET');
  });
});

describe('scenario: hard power cut', () => {
  it('rehydrates from serialised state with identical geometry and keeps watching', () => {
    const h = new Harness();
    const g = h.anchorUp(30);
    h.run(120, { position: at(0, 30) });

    const json = JSON.stringify(h.state);
    const h2 = new Harness({ start: h.now + 45_000 }); // 45 s of darkness
    h2.state = rehydrateWatchState(JSON.parse(json) as WatchState, h2.now);
    expect(h2.state.phase).toBe('SET');
    expect(h2.state.session?.geometry).toEqual(g);
    expect(h2.state.lastPositionAt).toBeNull();

    // Fix returns immediately after boot: no staleness alarm.
    h2.run(10, { position: at(0, 30) });
    expect(h2.conditionKeys()).toEqual([]);
    // And the watch is live: drag out and it alarms.
    h2.run(30, { position: at(0, (g?.swingRadius ?? 0) + 5) });
    expect(h2.state.stateName).toBe('ALARM');
  });
});

describe('scenario: depth', () => {
  it('alarms on shoaling below the configured minimum with a live sounder', () => {
    const h = new Harness({ config: { minDepth: 2.5 } });
    h.anchorUp(30);
    const ev = h.run(15, { position: at(0, 30), depth: 2.0 });
    expect(raised(ev, 'depth-shallow')).toHaveLength(1);
    expect(h.state.stateName).toBe('ALARM');
  });

  it('is silent with no minimum configured or no live sounder', () => {
    const h = new Harness();
    h.anchorUp(30);
    expect(has(h.run(15, { position: at(0, 30), depth: 0.5 }), 'condition-raised')).toBe(false);
    const h2 = new Harness({ config: { minDepth: 2.5 } });
    h2.anchorUp(30);
    expect(has(h2.run(15, { position: at(0, 30), depth: null }), 'condition-raised')).toBe(false);
  });
});

describe('scenario: exclusion zones', () => {
  const reef: ExclusionZone = {
    id: 'reef',
    name: 'Reef',
    kind: 'never-enter',
    enabled: true,
    // 60 m square centred 40 m east of the anchor: inside the swing circle.
    polygon: [
      destination(at(90, 40), degToRad(315), 42.4),
      destination(at(90, 40), degToRad(45), 42.4),
      destination(at(90, 40), degToRad(135), 42.4),
      destination(at(90, 40), degToRad(225), 42.4),
    ],
  };

  it('alarms on entering a zone that sits inside the swing circle', () => {
    const h = new Harness();
    h.zones = [reef];
    h.anchorUp(30, 0);
    // Swing east onto the reef at 35 m: well inside the 48 m radius.
    const ev = h.run(10, { position: at(90, 35) });
    expect(raised(ev, 'zone-breach')).toHaveLength(1);
    expect(raised(ev, 'position-outside')).toHaveLength(0);
    expect(h.state.conditions['zone-breach:reef']?.severity).toBe('critical');
    expect(h.state.stateName).toBe('ALARM');
  });

  it('warns on projected entry', () => {
    const h = new Harness();
    h.zones = [reef];
    h.anchorUp(30, 0);
    // From 30 m north, moving south-east at 1 kn toward the reef.
    const ev = h.run(10, { position: at(0, 30), sog: knotsToMps(1), cog: degToRad(120) });
    expect(raised(ev, 'zone-projected')).toHaveLength(1);
    expect(h.state.stateName).toBe('WARNING');
  });

  it('clears conditions when a zone is disabled', () => {
    const h = new Harness();
    h.zones = [reef];
    h.anchorUp(30, 0);
    h.run(10, { position: at(90, 35) });
    expect(h.conditionKeys()).toContain('zone-breach:reef');
    h.zones = [{ ...reef, enabled: false }];
    const ev = h.run(1, { position: at(90, 35) });
    expect(cleared(ev, 'zone-breach')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- ack

describe('acknowledgement', () => {
  function alarming() {
    const h = new Harness({ config: { snoozeMs: 60_000 } });
    const g = h.anchorUp(30);
    h.run(10, { position: at(0, (g?.swingRadius ?? 0) + 5) });
    expect(h.state.stateName).toBe('ALARM');
    return { h, outside: at(0, (g?.swingRadius ?? 0) + 5) };
  }

  it('silences audio but never clears the condition', () => {
    const { h, outside } = alarming();
    const ev = h.cmd({ type: 'ack', by: 'crew' });
    expect(ev[0]).toMatchObject({
      type: 'acknowledged',
      by: 'crew',
      conditions: ['position-outside'],
    });
    expect(isSnoozed(h.state, h.now)).toBe(true);
    expect(h.state.stateName).toBe('ALARM');
    h.run(30, { position: outside });
    expect(h.state.stateName).toBe('ALARM');
    expect(isSnoozed(h.state, h.now)).toBe(true);
  });

  it('re-fires after the snooze if still alarming, with an escalating count', () => {
    const { h, outside } = alarming();
    h.cmd({ type: 'ack', by: 'crew' });
    const ev = h.run(61, { position: outside });
    expect(ev.filter((e) => e.type === 'alarm-refire')).toHaveLength(1);
    expect(h.state.refires).toBe(1);
    expect(isSnoozed(h.state, h.now)).toBe(false);
    h.cmd({ type: 'ack', by: 'crew' });
    h.run(61, { position: outside });
    expect(h.state.refires).toBe(2);
  });

  it('resets the refire count and ack when everything clears', () => {
    const { h, outside } = alarming();
    h.cmd({ type: 'ack', by: 'crew' });
    h.run(61, { position: outside });
    h.run(15, { position: at(0, 20) });
    expect(h.conditionKeys()).toEqual([]);
    expect(h.state.ack).toBeNull();
    expect(h.state.refires).toBe(0);
  });

  it('a new critical breaks through a snooze taken on a warning', () => {
    const h = new Harness({ config: { snoozeMs: 600_000 } });
    const g = h.anchorUp(30);
    const radius = g?.swingRadius ?? 0;
    h.run(15, { position: at(0, radius - 5) });
    expect(h.state.stateName).toBe('WARNING');
    h.cmd({ type: 'ack', by: 'crew' });
    expect(isSnoozed(h.state, h.now)).toBe(true);
    h.run(10, { position: at(0, radius + 5) });
    expect(h.state.stateName).toBe('ALARM');
    expect(isSnoozed(h.state, h.now)).toBe(false);
  });
});

// ---------------------------------------------------------------- marina

describe('marina mode', () => {
  it('starts with one command at the current position and a tight radius', () => {
    const h = new Harness();
    const ev = h.cmd({ type: 'marina' }, { position: ANCHOR });
    expect(ev.map((e) => e.type)).toEqual(['session-started', 'marina-started', 'state-changed']);
    expect(h.state.phase).toBe('MARINA');
    expect(h.state.session?.marinaRadius).toBe(DEFAULT_ALARM_CONFIG.marinaRadius);
    expect(h.state.session?.geometry).toBeNull();
  });

  it('ignores wind angle entirely, watches position and SOG', () => {
    const h = new Harness();
    h.cmd({ type: 'marina' }, { position: ANCHOR });
    const calm = h.run(120, { position: at(45, 3), awa: degToRad(150), aws: knotsToMps(25) });
    expect(has(calm, 'condition-raised')).toBe(false);
    const moving = h.run(40, { position: at(45, 3), sog: knotsToMps(2) });
    expect(raised(moving, 'speed')).toHaveLength(1);
    expect(raised(moving, 'breakout')).toHaveLength(0);
    const gone = h.run(10, { position: at(45, 40) });
    expect(raised(gone, 'position-outside')).toHaveLength(1);
    expect(h.state.stateName).toBe('ALARM');
  });
});

// ---------------------------------------------------------------- invariants

describe('invariants', () => {
  it('derived state matches conditions', () => {
    const h = new Harness();
    const g = h.anchorUp(30);
    h.run(15, { position: at(0, (g?.swingRadius ?? 0) - 5) });
    expect(deriveStateName(h.state)).toBe('WARNING');
    expect(h.state.stateName).toBe('WARNING');
  });

  it('every event has a timestamp and the state is always JSON-serialisable', () => {
    const h = new Harness();
    const g = h.anchorUp(30);
    h.run(60, { position: at(0, (g?.swingRadius ?? 0) + 5) });
    h.cmd({ type: 'ack', by: 'x' });
    h.cmd({ type: 'weigh' });
    for (const e of h.events) expect(typeof e.at).toBe('number');
    expect(JSON.parse(JSON.stringify(h.state))).toEqual(h.state);
  });

  it('does not mutate the input state', () => {
    const h = new Harness();
    const before = JSON.stringify(h.state);
    const frozen = JSON.parse(before) as WatchState;
    tick(frozen, h.ctx({}));
    applyCommand(frozen, { type: 'drop' }, h.ctx({}));
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it('the engine evaluates with nothing but a clock and telemetry (no UI, no I/O)', () => {
    // This is the "web app entirely absent" test at the core level: the whole
    // watch runs on plain function calls.
    const h = new Harness();
    const g = h.anchorUp(30);
    h.run(20, { position: at(0, (g?.swingRadius ?? 0) + 5) });
    expect(h.state.stateName).toBe('ALARM');
  });
});

// ---------------------------------------------------------------- marina monitors

describe('marina: refrigeration', () => {
  const C = (c: number) => celsiusToKelvin(c);

  it('reports every band transition as the freezer fails, including into "off"', () => {
    const h = new Harness({ marinaConfig: { bandHoldMs: 10_000 } });
    h.cmd({ type: 'marina' }, { position: ANCHOR });
    h.run(30, { position: ANCHOR, freezerTemp: C(-18), airTemp: C(22) });
    // Warms 1 °C per 20 s from -18 to +22 (ambient): 800 s.
    const ev = h.run(800, (i) => ({
      position: ANCHOR,
      freezerTemp: C(-18 + i / 20),
      airTemp: C(22),
    }));
    const bands = ev
      .filter((e) => e.type === 'cold-box-band-changed' && e.box === 'freezer')
      .map((e) => (e.type === 'cold-box-band-changed' ? e.to : ''));
    expect(bands).toEqual(['warm', 'failing', 'off']);
    // The condition raised and cleared along the way and the state is now
    // quiet: that is the trap, and the transition log is what catches it.
    expect(raised(ev, 'freezer-warm')).toHaveLength(1);
    expect(raised(ev, 'freezer-failing')).toHaveLength(1);
    expect(cleared(ev, 'freezer-failing')).toHaveLength(1);
    expect(h.conditionKeys()).toEqual([]);
    expect(h.state.marina.freezer.band).toBe('off');
  });

  it('a box at ambient is "off", not failing; leaving "off" for normal is reported', () => {
    const h = new Harness({ marinaConfig: { bandHoldMs: 10_000 } });
    h.cmd({ type: 'marina' }, { position: ANCHOR });
    const off = h.run(30, { position: ANCHOR, fridgeTemp: C(21), airTemp: C(22) });
    expect(off.filter((e) => e.type === 'cold-box-band-changed')).toHaveLength(1);
    expect(h.state.marina.fridge.band).toBe('off');
    expect(h.conditionKeys()).toEqual([]);
    const on = h.run(30, { position: ANCHOR, fridgeTemp: C(4), airTemp: C(22) });
    expect(on.find((e) => e.type === 'cold-box-band-changed')).toMatchObject({
      box: 'fridge',
      from: 'off',
      to: 'normal',
    });
  });

  it('does not report a transition for a brief spike (loading provisions)', () => {
    const h = new Harness({ marinaConfig: { bandHoldMs: 60_000 } });
    h.cmd({ type: 'marina' }, { position: ANCHOR });
    h.run(70, { position: ANCHOR, fridgeTemp: C(4), airTemp: C(22) });
    const spike = h.run(40, { position: ANCHOR, fridgeTemp: C(10), airTemp: C(22) });
    const back = h.run(70, { position: ANCHOR, fridgeTemp: C(4), airTemp: C(22) });
    expect([...spike, ...back].filter((e) => e.type === 'cold-box-band-changed')).toHaveLength(0);
  });

  it('uses the absolute fallback when there is no ambient reading', () => {
    const h = new Harness({ marinaConfig: { bandHoldMs: 10_000 } });
    h.cmd({ type: 'marina' }, { position: ANCHOR });
    h.run(30, { position: ANCHOR, freezerTemp: C(16) });
    expect(h.state.marina.freezer.band).toBe('off');
  });
});

describe('marina: battery and solar', () => {
  it('rides through an overnight SoC dip but alarms on a sustained one', () => {
    const h = new Harness({ marinaConfig: { socHoldMs: 20 * 60_000 } });
    h.cmd({ type: 'marina' }, { position: ANCHOR });
    const dip = h.run(600, { position: ANCHOR, batterySoc: 0.45 });
    const rec = h.run(60, { position: ANCHOR, batterySoc: 0.6 });
    expect(has([...dip, ...rec], 'condition-raised')).toBe(false);
    const low = h.run(25 * 60, { position: ANCHOR, batterySoc: 0.45 });
    expect(raised(low, 'battery-low')).toHaveLength(1);
    expect(h.state.conditions['battery-low']?.severity).toBe('warning');
    const crit = h.run(25 * 60, { position: ANCHOR, batterySoc: 0.25 });
    expect(crit.filter((e) => e.type === 'condition-escalated')).toHaveLength(1);
  });

  it('warns on no solar yield through the midday window, not at night', () => {
    const h = new Harness({ marinaConfig: { solarHoldMs: 60 * 60_000 } });
    h.cmd({ type: 'marina' }, { position: ANCHOR });
    const night = h.run(2 * 3600, { position: ANCHOR, solarPower: 0, localHour: 2 });
    expect(has(night, 'condition-raised')).toBe(false);
    const day = h.run(2 * 3600, { position: ANCHOR, solarPower: 5, localHour: 12 });
    expect(raised(day, 'solar-no-yield')).toHaveLength(1);
    const producing = h.run(15, { position: ANCHOR, solarPower: 180, localHour: 12 });
    expect(cleared(producing, 'solar-no-yield')).toHaveLength(1);
  });

  it('does not run the monitors at anchor', () => {
    const h = new Harness({ marinaConfig: { bandHoldMs: 1_000 } });
    h.anchorUp(30);
    const ev = h.run(30, {
      position: at(0, 30),
      freezerTemp: celsiusToKelvin(0),
      airTemp: celsiusToKelvin(22),
    });
    expect(ev.filter((e) => e.type === 'cold-box-band-changed')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- manual circle

describe('manual radius', () => {
  it('linked mode moves both circles from one value, keeping the warn distance', () => {
    const h = new Harness();
    h.anchorUp(30); // computed swing 48 m, warn 38 m
    const ev = h.cmd({ type: 'set-radius', swingRadius: 60, mode: 'linked', by: 'skipper' });
    expect(ev[0]?.type).toBe('radius-overridden');
    if (ev[0]?.type !== 'radius-overridden') throw new Error('unreachable');
    expect(ev[0].computed?.swingRadius).toBeCloseTo(48, 1);
    const o = h.state.session?.radiusOverride;
    expect(o).toMatchObject({ swingRadius: 60, warnRadius: 50, mode: 'linked', by: 'skipper' });
    expect(effectiveRadii(h.state.session, h.config)).toEqual({
      swingRadius: 60,
      warnRadius: 50,
      manual: true,
    });
    // Driving the warning circle instead pushes the alarm circle out.
    h.cmd({ type: 'set-radius', warnRadius: 70, mode: 'linked', by: 'skipper' });
    expect(h.state.session?.radiusOverride).toMatchObject({ swingRadius: 80, warnRadius: 70 });
    // The computed geometry is untouched underneath.
    expect(h.state.session?.geometry?.swingRadius).toBeCloseTo(48, 1);
  });

  it('independent mode takes each value as given and validates the band', () => {
    const h = new Harness();
    h.anchorUp(30);
    h.cmd({ type: 'set-radius', swingRadius: 100, warnRadius: 40, mode: 'independent', by: 'a' });
    expect(h.state.session?.radiusOverride).toMatchObject({ swingRadius: 100, warnRadius: 40 });
    // One value at a time keeps the other.
    h.cmd({ type: 'set-radius', warnRadius: 55, mode: 'independent', by: 'a' });
    expect(h.state.session?.radiusOverride).toMatchObject({ swingRadius: 100, warnRadius: 55 });
    expect(
      h.cmd({ type: 'set-radius', warnRadius: 120, mode: 'independent', by: 'a' })[0],
    ).toMatchObject({ type: 'command-rejected', reason: 'warn-outside-alarm' });
    expect(
      h.cmd({ type: 'set-radius', swingRadius: 2, mode: 'independent', by: 'a' })[0],
    ).toMatchObject({ reason: 'radius-out-of-range' });
    expect(h.cmd({ type: 'set-radius', mode: 'independent', by: 'a' })[0]).toMatchObject({
      reason: 'nothing-given',
    });
  });

  it('the engine watches the manual circle, not the computed one', () => {
    const h = new Harness();
    h.anchorUp(30);
    // 55 m out is inside the computed 48 m? No: outside. Widen manually to 80 m first.
    h.cmd({ type: 'set-radius', swingRadius: 80, mode: 'linked', by: 'a' });
    h.run(30, { position: at(0, 55) });
    expect(h.conditionKeys()).toEqual([]);
    expect(h.state.live.distanceToEdge).toBeCloseTo(25, 0);
    // Shrink it under the boat: alarms after the full hold, not instantly.
    h.cmd({ type: 'set-radius', swingRadius: 40, mode: 'linked', by: 'a' });
    h.run(3, { position: at(0, 55) });
    expect(h.conditionKeys()).toEqual([]);
    h.run(10, { position: at(0, 55) });
    expect(h.conditionKeys()).toContain('position-outside');
    expect(h.state.stateName).toBe('ALARM');
  });

  it('clearing the override returns to the computed circle', () => {
    const h = new Harness();
    h.anchorUp(30);
    h.cmd({ type: 'set-radius', swingRadius: 80, mode: 'linked', by: 'a' });
    expect(h.cmd({ type: 'clear-radius', by: 'a' })[0]).toMatchObject({
      type: 'radius-override-cleared',
    });
    expect(h.state.session?.radiusOverride).toBeNull();
    expect(effectiveRadii(h.state.session, h.config)?.manual).toBe(false);
    expect(h.cmd({ type: 'clear-radius', by: 'a' })).toEqual([]);
  });

  it('is only allowed while watching, and works in marina mode too', () => {
    const h = new Harness();
    expect(
      h.cmd({ type: 'set-radius', swingRadius: 50, mode: 'linked', by: 'a' })[0],
    ).toMatchObject({ reason: 'not-watching' });
    h.cmd({ type: 'marina' });
    h.cmd({ type: 'set-radius', swingRadius: 50, mode: 'linked', by: 'a' });
    expect(effectiveRadii(h.state.session, h.config)).toMatchObject({ swingRadius: 50 });
    h.run(20, { position: at(0, 30) });
    expect(h.conditionKeys()).toEqual([]);
  });

  it('survives a power cut, and old persisted sessions get a null override', () => {
    const h = new Harness();
    h.anchorUp(30);
    h.cmd({ type: 'set-radius', swingRadius: 80, warnRadius: 60, mode: 'independent', by: 'a' });
    const json = JSON.stringify(h.state);
    const back = rehydrateWatchState(JSON.parse(json) as WatchState, h.now + 60_000);
    expect(back.session?.radiusOverride).toMatchObject({ swingRadius: 80, warnRadius: 60 });
    const legacy = JSON.parse(json) as WatchState;
    delete (legacy.session as unknown as Record<string, unknown>).radiusOverride;
    expect(rehydrateWatchState(legacy, h.now).session?.radiusOverride).toBeNull();
  });
});

describe('settings change under an active session', () => {
  it('recompute re-derives the circle from new margins and warn distance', () => {
    const h = new Harness();
    h.anchorUp(30);
    expect(h.state.session?.geometry?.swingRadius).toBeCloseTo(48, 1);
    expect(h.cmd({ type: 'recompute' })).toEqual([]); // nothing changed
    h.config = { ...h.config, swingMargin: 25, warnDistance: 20 };
    const ev = h.cmd({ type: 'recompute' });
    expect(ev[0]?.type).toBe('geometry-recomputed');
    if (ev[0]?.type !== 'geometry-recomputed') throw new Error('unreachable');
    expect(ev[0].swingRadius).toBeCloseTo(58, 1);
    expect(ev[0].warnRadius).toBeCloseTo(38, 1);
    expect(h.state.session?.geometry?.swingRadius).toBeCloseTo(58, 1);
    // The HDOP term stays as it was at set: settings can change, the fix cannot.
    expect(h.state.session?.geometry?.hdopAtSet).toBe(1);
  });

  it('a linked override follows the new warn distance; an independent one is frozen', () => {
    const h = new Harness();
    h.anchorUp(30);
    h.cmd({ type: 'set-radius', swingRadius: 60, mode: 'linked', by: 'a' });
    h.config = { ...h.config, warnDistance: 25 };
    h.cmd({ type: 'recompute' });
    expect(h.state.session?.radiusOverride).toMatchObject({ swingRadius: 60, warnRadius: 35 });
    h.cmd({ type: 'set-radius', swingRadius: 60, warnRadius: 50, mode: 'independent', by: 'a' });
    h.config = { ...h.config, warnDistance: 5, swingMargin: 40 };
    h.cmd({ type: 'recompute' });
    expect(h.state.session?.radiusOverride).toMatchObject({ swingRadius: 60, warnRadius: 50 });
    expect(effectiveRadii(h.state.session, h.config)).toMatchObject({ swingRadius: 60 });
  });

  it('marina sessions pick up a new marina radius', () => {
    const h = new Harness();
    h.cmd({ type: 'marina' });
    h.config = { ...h.config, marinaRadius: 35 };
    expect(h.cmd({ type: 'recompute' })[0]).toMatchObject({ marinaRadius: 35, swingRadius: 35 });
    expect(h.state.session?.marinaRadius).toBe(35);
  });

  it('is a no-op when idle', () => {
    const h = new Harness();
    expect(h.cmd({ type: 'recompute' })).toEqual([]);
  });
});
