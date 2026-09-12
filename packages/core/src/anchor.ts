import type { AlarmConfig } from './config.js';
import { fresh, sustainedInit, sustainedStep, type SustainedState } from './detectors.js';
import { bearingRad, distanceM } from './geodesy.js';
import {
  bowRollerPosition,
  computeAnchorGeometry,
  suggestedRode,
  type AnchorGeometry,
} from './geometry.js';
import type { BoatGeometry, LatLon, Severity, Telemetry } from './types.js';
import { evaluateZone, type ExclusionZone } from './zones.js';
import {
  createMarinaState,
  stepMarina,
  type ColdBand,
  type ColdBox,
  type MarinaConfig,
  type MarinaConditionKey,
  type MarinaState,
} from './marina.js';

/*
 * The anchor watch as a pure state machine.
 *
 *   IDLE ──drop──> DROPPING ──set──> SET ──┬──> WARNING ──> ALARM
 *     ^                │                   │       │          │
 *     │                │                   └───────┴──ack─────┘
 *     └────────weigh───┴───────────────────────────┘
 *
 *   IDLE ──marina──> MARINA ──> WARNING/ALARM
 *
 * WARNING and ALARM are not stored phases: they are derived from the set of
 * active conditions, each of which carries a severity. That is what makes
 * "ack never clears the condition" fall out naturally: an ack touches audio
 * state, the conditions remain, the derived state remains ALARM.
 *
 * Nothing in this file does I/O or reads a clock. The host supplies `now`,
 * telemetry, config, zones and an id generator. Every field of WatchState is
 * JSON-serialisable so the host can persist it verbatim and rehydrate on boot.
 */

export type WatchPhase = 'IDLE' | 'DROPPING' | 'SET' | 'MARINA';
export type WatchStateName = WatchPhase | 'WARNING' | 'ALARM';
export type SessionMode = 'anchor' | 'marina';

export type ConditionId =
  | 'position-warning'
  | 'position-outside'
  | 'wind-shift'
  | 'speed'
  | 'breakout'
  | 'gps-stale'
  | 'source-disconnected'
  | 'depth-shallow'
  | 'zone-breach'
  | 'zone-projected'
  | MarinaConditionKey;

export type ConditionValues = Record<string, number | string | boolean | null>;

export interface ActiveCondition {
  /** Unique within the state: the id, or `${id}:${zoneId}` for zone conditions. */
  key: string;
  id: ConditionId;
  severity: Severity;
  since: number;
  /** The measurements that caused it, captured when raised and updated on escalation. */
  values: ConditionValues;
  zoneId?: string;
}

export type DepthSource = 'sounder' | 'manual';

export interface AnchorSession {
  id: string;
  mode: SessionMode;
  startedAt: number;
  endedAt: number | null;

  // ---- anchor mode
  /** Bow-roller-corrected position when the anchor hit bottom. */
  dropPosition: LatLon | null;
  dropAt: number | null;
  /** False when no heading was available at drop and the antenna position was used. */
  dropCorrected: boolean;
  /** Captured once at drop and reused all session; the sounder may be off overnight. */
  depthAtDrop: number | null;
  depthSource: DepthSource | null;
  /** Effective anchor position: the drop point, unless nudged since. */
  anchor: LatLon | null;
  setPosition: LatLon | null;
  setAt: number | null;
  tideRange: number;
  geometry: AnchorGeometry | null;

  // ---- marina mode
  marinaCentre: LatLon | null;
  marinaRadius: number | null;
}

export interface Acknowledgement {
  at: number;
  by: string;
  until: number;
  /** Condition keys active when acked. */
  conditions: string[];
}

export interface LiveValues {
  /** Bow-roller position this tick, or null if no usable fix. */
  boat: LatLon | null;
  boatCorrected: boolean;
  distanceFromAnchor: number | null;
  /** Positive inside the circle, negative outside. */
  distanceToEdge: number | null;
  bearingFromAnchor: number | null;
  /** Rode to pay out for the target scope at the current depth (IDLE only). */
  suggestedRode: number | null;
  /** Seconds since the last usable position. */
  positionAgeS: number | null;
}

export interface WatchState {
  phase: WatchPhase;
  /** Derived; kept so transitions can be diffed and logged. */
  stateName: WatchStateName;
  session: AnchorSession | null;
  conditions: Record<string, ActiveCondition>;
  detectors: {
    positionWarning: SustainedState;
    positionOutside: SustainedState;
    windShift: SustainedState;
    speed: SustainedState;
    depth: SustainedState;
    zones: Record<string, { breach: SustainedState; projected: SustainedState }>;
  };
  /** Timestamp of the newest usable position seen. */
  lastPositionAt: number | null;
  /** When the engine started observing (boot or rehydrate); GPS staleness counts from here if no fix ever arrives. */
  observingSince: number;
  ack: Acknowledgement | null;
  /** Times the alarm has re-fired after a snooze in this alarm episode. */
  refires: number;
  live: LiveValues;
  /** Refrigeration / battery / solar monitors; only stepped in MARINA. */
  marina: MarinaState;
}

export type EngineEvent = { at: number } & (
  | { type: 'session-started'; sessionId: string; mode: SessionMode }
  | {
      type: 'anchor-dropped';
      sessionId: string;
      position: LatLon;
      corrected: boolean;
      depth: number | null;
      depthSource: DepthSource | null;
    }
  | { type: 'depth-entered'; sessionId: string; depth: number }
  | { type: 'anchor-set'; sessionId: string; setPosition: LatLon; geometry: AnchorGeometry }
  | { type: 'anchor-nudged'; sessionId: string; from: LatLon; to: LatLon; geometry: AnchorGeometry }
  | { type: 'tide-updated'; sessionId: string; tideRange: number; geometry: AnchorGeometry }
  | { type: 'marina-started'; sessionId: string; centre: LatLon; radius: number }
  | { type: 'session-ended'; sessionId: string; mode: SessionMode; durationMs: number; by: string }
  | { type: 'condition-raised'; condition: ActiveCondition }
  | { type: 'condition-escalated'; condition: ActiveCondition; previousSeverity: Severity }
  | {
      type: 'condition-cleared';
      key: string;
      id: ConditionId;
      durationMs: number;
      values: ConditionValues;
    }
  | { type: 'state-changed'; from: WatchStateName; to: WatchStateName; values: ConditionValues }
  | {
      type: 'acknowledged';
      by: string;
      until: number;
      snoozeMs: number;
      conditions: string[];
      values: ConditionValues;
    }
  | { type: 'alarm-refire'; refires: number; conditions: string[]; values: ConditionValues }
  | { type: 'command-rejected'; command: Command['type']; reason: string; message: string }
  | {
      type: 'cold-box-band-changed';
      box: ColdBox;
      from: ColdBand;
      to: ColdBand;
      temp: number | null;
      ambient: number | null;
    }
);

export type Command =
  | { type: 'drop'; manualDepth?: number }
  | { type: 'set-depth'; depth: number }
  | { type: 'set' }
  | { type: 'nudge'; anchor: LatLon }
  | { type: 'set-tide'; tideRange: number }
  | { type: 'weigh'; by?: string }
  | { type: 'ack'; by: string }
  | { type: 'marina' };

export interface EngineContext {
  now: number;
  telemetry: Telemetry;
  config: AlarmConfig;
  boat: BoatGeometry;
  zones: readonly ExclusionZone[];
  marinaConfig: MarinaConfig;
  /** Local hour of day (0–23) for the solar window; null when the clock is not synced. */
  localHour?: number | null;
  /** Session id generator. Injected so the core stays pure and tests stay deterministic. */
  newId: () => string;
  /** Target scope used for the IDLE rode suggestion. Default 5. */
  suggestedScope?: number;
}

export interface StepResult {
  state: WatchState;
  events: EngineEvent[];
}

/** Position samples older than this are not usable for geometry. */
const POSITION_MAX_AGE_MS = 10_000;
/** Heading/COG/SOG/wind/depth samples older than this are treated as absent. */
const INSTRUMENT_MAX_AGE_MS = 15_000;
/** Distance ring inside which a projected-breach warning is meaningful. */
const DEFAULT_SUGGESTED_SCOPE = 5;

export function createWatchState(now: number): WatchState {
  return {
    phase: 'IDLE',
    stateName: 'IDLE',
    session: null,
    conditions: {},
    detectors: freshDetectors(),
    lastPositionAt: null,
    observingSince: now,
    ack: null,
    refires: 0,
    live: emptyLive(),
    marina: createMarinaState(),
  };
}

/**
 * Called by the host after loading persisted state on boot. Detector timers
 * are kept (the boat did not stop moving while we were down) but the
 * observation clock restarts so GPS staleness is measured from now, not from
 * the last sample before the power cut.
 */
export function rehydrateWatchState(persisted: WatchState, now: number): WatchState {
  return {
    ...persisted,
    observingSince: now,
    lastPositionAt: null,
    live: emptyLive(),
  };
}

function freshDetectors(): WatchState['detectors'] {
  return {
    positionWarning: sustainedInit(),
    positionOutside: sustainedInit(),
    windShift: sustainedInit(),
    speed: sustainedInit(),
    depth: sustainedInit(),
    zones: {},
  };
}

function emptyLive(): LiveValues {
  return {
    boat: null,
    boatCorrected: false,
    distanceFromAnchor: null,
    distanceToEdge: null,
    bearingFromAnchor: null,
    suggestedRode: null,
    positionAgeS: null,
  };
}

// ---------------------------------------------------------------- commands

export function applyCommand(state: WatchState, cmd: Command, ctx: EngineContext): StepResult {
  switch (cmd.type) {
    case 'drop':
      return drop(state, cmd, ctx);
    case 'set-depth':
      return setDepth(state, cmd, ctx);
    case 'set':
      return set(state, ctx);
    case 'nudge':
      return nudge(state, cmd, ctx);
    case 'set-tide':
      return setTide(state, cmd, ctx);
    case 'weigh':
      return weigh(state, cmd, ctx);
    case 'ack':
      return ack(state, cmd, ctx);
    case 'marina':
      return marina(state, ctx);
  }
}

function reject(
  state: WatchState,
  command: Command['type'],
  reason: string,
  message: string,
  now: number,
): StepResult {
  return { state, events: [{ at: now, type: 'command-rejected', command, reason, message }] };
}

function currentBoatPosition(
  ctx: EngineContext,
): { position: LatLon; corrected: boolean; timestamp: number } | null {
  const pos = ctx.telemetry.position;
  const value = fresh(pos, ctx.now, POSITION_MAX_AGE_MS);
  if (!pos || value === null) return null;
  const heading = fresh(ctx.telemetry.heading, ctx.now, INSTRUMENT_MAX_AGE_MS);
  const { position, corrected } = bowRollerPosition(value, heading, ctx.boat);
  return { position, corrected, timestamp: pos.timestamp };
}

function drop(state: WatchState, cmd: { manualDepth?: number }, ctx: EngineContext): StepResult {
  const { now } = ctx;
  // Idempotent: dropping again while dropping is a no-op, not a new session.
  if (state.phase === 'DROPPING') return { state, events: [] };
  if (state.phase !== 'IDLE') {
    return reject(state, 'drop', 'not-idle', 'Weigh anchor before dropping again.', now);
  }
  const boat = currentBoatPosition(ctx);
  if (!boat) {
    return reject(
      state,
      'drop',
      'position-required',
      'No usable GPS fix. Wait for a position.',
      now,
    );
  }

  let depthAtDrop: number | null = null;
  let depthSource: DepthSource | null = null;
  if (cmd.manualDepth !== undefined && Number.isFinite(cmd.manualDepth) && cmd.manualDepth >= 0) {
    depthAtDrop = cmd.manualDepth;
    depthSource = 'manual';
  } else {
    const depth = fresh(ctx.telemetry.depth, now, INSTRUMENT_MAX_AGE_MS);
    if (depth !== null && depth >= 0) {
      depthAtDrop = depth;
      depthSource = 'sounder';
    }
  }

  const session: AnchorSession = {
    id: ctx.newId(),
    mode: 'anchor',
    startedAt: now,
    endedAt: null,
    dropPosition: boat.position,
    dropAt: now,
    dropCorrected: boat.corrected,
    depthAtDrop,
    depthSource,
    anchor: boat.position,
    setPosition: null,
    setAt: null,
    tideRange: 0,
    geometry: null,
    marinaCentre: null,
    marinaRadius: null,
  };

  const next: WatchState = {
    ...state,
    phase: 'DROPPING',
    session,
    conditions: {},
    detectors: freshDetectors(),
    ack: null,
    refires: 0,
  };
  const events: EngineEvent[] = [
    { at: now, type: 'session-started', sessionId: session.id, mode: 'anchor' },
    {
      at: now,
      type: 'anchor-dropped',
      sessionId: session.id,
      position: boat.position,
      corrected: boat.corrected,
      depth: depthAtDrop,
      depthSource,
    },
  ];
  return finishTransition(state, next, events, now, {});
}

function setDepth(state: WatchState, cmd: { depth: number }, ctx: EngineContext): StepResult {
  const { now } = ctx;
  if (state.session?.mode !== 'anchor') {
    return reject(state, 'set-depth', 'no-session', 'No anchor session is active.', now);
  }
  if (!Number.isFinite(cmd.depth) || cmd.depth < 0) {
    return reject(state, 'set-depth', 'invalid-depth', 'Depth must be a positive number.', now);
  }
  const session: AnchorSession = {
    ...state.session,
    depthAtDrop: cmd.depth,
    depthSource: 'manual',
  };
  const events: EngineEvent[] = [
    { at: now, type: 'depth-entered', sessionId: session.id, depth: cmd.depth },
  ];
  // If already set, the geometry depends on depth: recompute.
  if (session.geometry && session.anchor && session.setPosition) {
    session.geometry = geometryFor(session, ctx);
  }
  return { state: { ...state, session }, events };
}

function set(state: WatchState, ctx: EngineContext): StepResult {
  const { now } = ctx;
  if (state.phase === 'SET') return { state, events: [] };
  if (state.phase !== 'DROPPING' || !state.session) {
    return reject(state, 'set', 'not-dropping', 'Drop the anchor first.', now);
  }
  if (state.session.depthAtDrop === null) {
    return reject(
      state,
      'set',
      'depth-required',
      'No depth was available at drop. Enter the depth to continue.',
      now,
    );
  }
  const boat = currentBoatPosition(ctx);
  if (!boat) {
    return reject(
      state,
      'set',
      'position-required',
      'No usable GPS fix. Wait for a position.',
      now,
    );
  }

  const session: AnchorSession = {
    ...state.session,
    setPosition: boat.position,
    setAt: now,
  };
  session.geometry = geometryFor(session, ctx);

  const next: WatchState = {
    ...state,
    phase: 'SET',
    session,
    detectors: freshDetectors(),
  };
  const events: EngineEvent[] = [
    {
      at: now,
      type: 'anchor-set',
      sessionId: session.id,
      setPosition: boat.position,
      geometry: session.geometry,
    },
  ];
  return finishTransition(state, next, events, now, geometryValues(session.geometry));
}

function geometryFor(session: AnchorSession, ctx: EngineContext): AnchorGeometry {
  if (!session.anchor || !session.setPosition || session.depthAtDrop === null) {
    throw new Error('geometryFor called without anchor, set position and depth');
  }
  return computeAnchorGeometry({
    anchor: session.anchor,
    setPosition: session.setPosition,
    depthAtDrop: session.depthAtDrop,
    tideRange: session.tideRange,
    hdop: session.geometry?.hdopAtSet ?? fresh(ctx.telemetry.hdop, ctx.now, INSTRUMENT_MAX_AGE_MS),
    boat: ctx.boat,
    config: ctx.config,
  });
}

function nudge(state: WatchState, cmd: { anchor: LatLon }, ctx: EngineContext): StepResult {
  const { now } = ctx;
  if (state.phase !== 'SET' || !state.session?.anchor) {
    return reject(
      state,
      'nudge',
      'not-set',
      'The anchor position can be adjusted once it is set.',
      now,
    );
  }
  if (!Number.isFinite(cmd.anchor.lat) || !Number.isFinite(cmd.anchor.lon)) {
    return reject(state, 'nudge', 'invalid-position', 'That is not a valid position.', now);
  }
  const from = state.session.anchor;
  const session: AnchorSession = { ...state.session, anchor: cmd.anchor };
  session.geometry = geometryFor(session, ctx);
  const events: EngineEvent[] = [
    {
      at: now,
      type: 'anchor-nudged',
      sessionId: session.id,
      from,
      to: cmd.anchor,
      geometry: session.geometry,
    },
  ];
  // Detector timers are position-relative; a moved anchor restarts them cleanly.
  const next: WatchState = {
    ...state,
    session,
    detectors: {
      ...state.detectors,
      positionWarning: sustainedInit(),
      positionOutside: sustainedInit(),
    },
  };
  return { state: next, events };
}

function setTide(state: WatchState, cmd: { tideRange: number }, ctx: EngineContext): StepResult {
  const { now } = ctx;
  if (state.session?.mode !== 'anchor') {
    return reject(state, 'set-tide', 'no-session', 'No anchor session is active.', now);
  }
  if (!Number.isFinite(cmd.tideRange) || cmd.tideRange < 0) {
    return reject(state, 'set-tide', 'invalid-tide', 'Tide range must be zero or more.', now);
  }
  const session: AnchorSession = { ...state.session, tideRange: cmd.tideRange };
  const events: EngineEvent[] = [];
  if (session.geometry) {
    session.geometry = geometryFor(session, ctx);
    events.push({
      at: now,
      type: 'tide-updated',
      sessionId: session.id,
      tideRange: cmd.tideRange,
      geometry: session.geometry,
    });
  }
  return { state: { ...state, session }, events };
}

function weigh(state: WatchState, cmd: { by?: string }, ctx: EngineContext): StepResult {
  const { now } = ctx;
  if (state.phase === 'IDLE' || !state.session) return { state, events: [] };
  const session = state.session;
  const events: EngineEvent[] = [];
  // Clear every condition explicitly so the log shows them ending.
  for (const c of Object.values(state.conditions)) {
    events.push({
      at: now,
      type: 'condition-cleared',
      key: c.key,
      id: c.id,
      durationMs: now - c.since,
      values: c.values,
    });
  }
  events.push({
    at: now,
    type: 'session-ended',
    sessionId: session.id,
    mode: session.mode,
    durationMs: now - session.startedAt,
    by: cmd.by ?? 'unknown',
  });
  const next: WatchState = {
    ...state,
    phase: 'IDLE',
    session: { ...session, endedAt: now },
    conditions: {},
    detectors: freshDetectors(),
    ack: null,
    refires: 0,
  };
  return finishTransition(state, next, events, now, {});
}

function ack(state: WatchState, cmd: { by: string }, ctx: EngineContext): StepResult {
  const { now, config } = ctx;
  const keys = Object.keys(state.conditions);
  if (keys.length === 0) {
    return reject(state, 'ack', 'nothing-to-ack', 'There is no active warning or alarm.', now);
  }
  const until = now + config.snoozeMs;
  const values = liveValues(state);
  const next: WatchState = { ...state, ack: { at: now, by: cmd.by, until, conditions: keys } };
  return {
    state: next,
    events: [
      {
        at: now,
        type: 'acknowledged',
        by: cmd.by,
        until,
        snoozeMs: config.snoozeMs,
        conditions: keys,
        values,
      },
    ],
  };
}

function marina(state: WatchState, ctx: EngineContext): StepResult {
  const { now, config } = ctx;
  if (state.phase === 'MARINA') return { state, events: [] };
  if (state.phase !== 'IDLE') {
    return reject(state, 'marina', 'not-idle', 'Weigh anchor before starting marina mode.', now);
  }
  const boat = currentBoatPosition(ctx);
  if (!boat) {
    return reject(
      state,
      'marina',
      'position-required',
      'No usable GPS fix. Wait for a position.',
      now,
    );
  }
  const session: AnchorSession = {
    id: ctx.newId(),
    mode: 'marina',
    startedAt: now,
    endedAt: null,
    dropPosition: null,
    dropAt: null,
    dropCorrected: false,
    depthAtDrop: null,
    depthSource: null,
    anchor: null,
    setPosition: null,
    setAt: null,
    tideRange: 0,
    geometry: null,
    marinaCentre: boat.position,
    marinaRadius: config.marinaRadius,
  };
  const next: WatchState = {
    ...state,
    phase: 'MARINA',
    session,
    conditions: {},
    detectors: freshDetectors(),
    ack: null,
    refires: 0,
    marina: createMarinaState(),
  };
  const events: EngineEvent[] = [
    { at: now, type: 'session-started', sessionId: session.id, mode: 'marina' },
    {
      at: now,
      type: 'marina-started',
      sessionId: session.id,
      centre: boat.position,
      radius: config.marinaRadius,
    },
  ];
  return finishTransition(state, next, events, now, { radius: config.marinaRadius });
}

/** Recompute the derived state name and append a state-changed event if it moved. */
function finishTransition(
  prev: WatchState,
  next: WatchState,
  events: EngineEvent[],
  now: number,
  values: ConditionValues,
): StepResult {
  const stateName = deriveStateName(next);
  const out = { ...next, stateName };
  if (stateName !== prev.stateName) {
    events.push({ at: now, type: 'state-changed', from: prev.stateName, to: stateName, values });
  }
  return { state: out, events };
}

// ---------------------------------------------------------------- tick

/**
 * Evaluate one sample. The host calls this at 1 Hz (and after any command).
 * Order matters: geometry first, then detectors, then conditions, then the
 * ack/refire logic, then the derived state.
 */
export function tick(state: WatchState, ctx: EngineContext): StepResult {
  const { now, telemetry, config } = ctx;
  const events: EngineEvent[] = [];

  // ---- position bookkeeping
  const boat = currentBoatPosition(ctx);
  let lastPositionAt = state.lastPositionAt;
  if (boat && (lastPositionAt === null || boat.timestamp > lastPositionAt)) {
    lastPositionAt = boat.timestamp;
  }
  const positionAgeMs = lastPositionAt !== null ? now - lastPositionAt : now - state.observingSince;

  const live: LiveValues = {
    boat: boat?.position ?? null,
    boatCorrected: boat?.corrected ?? false,
    distanceFromAnchor: null,
    distanceToEdge: null,
    bearingFromAnchor: null,
    suggestedRode: null,
    positionAgeS: Math.round(positionAgeMs / 1000),
  };

  const watching = state.phase === 'SET' || state.phase === 'MARINA';
  const session = state.session;

  // IDLE: only the rode suggestion.
  if (state.phase === 'IDLE') {
    const depth = fresh(telemetry.depth, now, INSTRUMENT_MAX_AGE_MS);
    if (depth !== null) {
      live.suggestedRode = suggestedRode(
        depth,
        ctx.boat.bowRollerHeight,
        ctx.suggestedScope ?? DEFAULT_SUGGESTED_SCOPE,
      );
    }
    return { state: { ...state, lastPositionAt, live, stateName: 'IDLE' }, events };
  }

  // ---- detectors
  const det = { ...state.detectors, zones: { ...state.detectors.zones } };
  const raised: ActiveCondition[] = [];
  const cleared: string[] = [];

  // Reference geometry for anchor or marina.
  const centre = session
    ? session.mode === 'marina'
      ? session.marinaCentre
      : session.anchor
    : null;
  const radius =
    session?.mode === 'marina'
      ? (session.marinaRadius ?? config.marinaRadius)
      : (session?.geometry?.swingRadius ?? null);
  const warnRadius =
    session?.mode === 'marina'
      ? Math.max(0, (session.marinaRadius ?? config.marinaRadius) - config.warnDistance)
      : (session?.geometry?.warnRadius ?? null);

  if (centre && boat) {
    live.distanceFromAnchor = distanceM(centre, boat.position);
    live.bearingFromAnchor = bearingRad(centre, boat.position);
    if (radius !== null) live.distanceToEdge = radius - live.distanceFromAnchor;
  }

  const sog = fresh(telemetry.sog, now, INSTRUMENT_MAX_AGE_MS);
  const cog = fresh(telemetry.cog, now, INSTRUMENT_MAX_AGE_MS);

  if (watching && centre && radius !== null && warnRadius !== null) {
    // Position detectors hold (null) when there is no usable fix: we cannot
    // know, and GPS staleness is raising its own alarm.
    const d = live.distanceFromAnchor;
    const outsideRaw = d === null ? null : d > radius;
    const warnRaw = d === null ? null : d > warnRadius;

    const o = sustainedStep(
      det.positionOutside,
      outsideRaw,
      now,
      config.outsideHoldMs,
      config.clearHoldMs,
    );
    det.positionOutside = o.state;
    const w = sustainedStep(
      det.positionWarning,
      warnRaw,
      now,
      config.positionHoldMs,
      config.clearHoldMs,
    );
    det.positionWarning = w.state;

    const posValues: ConditionValues = {
      distance: round(d),
      radius: round(radius),
      warnRadius: round(warnRadius),
      sog: round(sog),
    };
    syncCondition(
      state,
      raised,
      cleared,
      'position-outside',
      det.positionOutside.active,
      'critical',
      now,
      posValues,
    );
    syncCondition(
      state,
      raised,
      cleared,
      'position-warning',
      det.positionWarning.active,
      'warning',
      now,
      posValues,
    );

    // Speed detector: both modes.
    const sogThreshold =
      session?.mode === 'marina' ? config.marinaSogThreshold : config.sogThreshold;
    const sogRaw = sog === null ? false : sog > sogThreshold;
    const s = sustainedStep(det.speed, sogRaw, now, config.sogHoldMs, config.clearHoldMs);
    det.speed = s.state;
    syncCondition(state, raised, cleared, 'speed', det.speed.active, 'warning', now, {
      sog: round(sog),
      threshold: round(sogThreshold),
    });

    // Wind-angle detector: anchor mode only. A docked boat does not weathervane.
    if (session?.mode === 'anchor') {
      const awa = fresh(telemetry.awa, now, INSTRUMENT_MAX_AGE_MS);
      const aws = fresh(telemetry.aws, now, INSTRUMENT_MAX_AGE_MS);
      // Suppressed (false, not null) below the wind floor: a free-spinning vane
      // must not accumulate, and an active warning should clear.
      const windRaw =
        awa === null || aws === null || aws < config.awaMinWindSpeed
          ? false
          : Math.abs(awa) > config.awaWindow;
      const wd = sustainedStep(det.windShift, windRaw, now, config.awaHoldMs, config.clearHoldMs);
      det.windShift = wd.state;
      syncCondition(state, raised, cleared, 'wind-shift', det.windShift.active, 'warning', now, {
        awa: round(awa),
        aws: round(aws),
        window: round(config.awaWindow),
      });
    } else {
      det.windShift = sustainedInit();
      syncCondition(state, raised, cleared, 'wind-shift', false, 'warning', now, {});
    }

    // Break-out: both early-warning detectors at once is a boat that has let
    // go and is moving. Straight to critical; bypasses Do Not Disturb.
    const breakout = det.windShift.active && det.speed.active;
    syncCondition(state, raised, cleared, 'breakout', breakout, 'critical', now, {
      sog: round(sog),
      awa: round(fresh(telemetry.awa, now, INSTRUMENT_MAX_AGE_MS)),
    });

    // Depth: only with a live sounder and a configured minimum.
    const depth = fresh(telemetry.depth, now, INSTRUMENT_MAX_AGE_MS);
    const depthRaw = config.minDepth > 0 && depth !== null ? depth < config.minDepth : false;
    const dd = sustainedStep(det.depth, depthRaw, now, config.depthHoldMs, config.clearHoldMs);
    det.depth = dd.state;
    syncCondition(state, raised, cleared, 'depth-shallow', det.depth.active, 'critical', now, {
      depth: round(depth),
      minDepth: round(config.minDepth),
    });

    // Exclusion zones, each independently.
    const seen = new Set<string>();
    for (const zone of ctx.zones) {
      if (!zone.enabled || zone.polygon.length < 3) continue;
      seen.add(zone.id);
      const zs = det.zones[zone.id] ?? { breach: sustainedInit(), projected: sustainedInit() };
      let breachRaw: boolean | null = null;
      let projectedRaw: boolean | null = null;
      let values: ConditionValues = { zone: zone.name, kind: zone.kind };
      if (boat) {
        const ev = evaluateZone(zone, boat.position, cog, sog, config.zoneLookaheadMs);
        breachRaw = ev.breached;
        projectedRaw = ev.projected;
        values = {
          ...values,
          distanceToEdge: round(ev.distanceToEdge),
          secondsToBreach: ev.secondsToBreach === null ? null : Math.round(ev.secondsToBreach),
          sog: round(sog),
          cog: round(cog),
        };
      }
      const b = sustainedStep(zs.breach, breachRaw, now, config.zoneHoldMs, config.clearHoldMs);
      const p = sustainedStep(
        zs.projected,
        projectedRaw,
        now,
        config.zoneHoldMs,
        config.clearHoldMs,
      );
      det.zones[zone.id] = { breach: b.state, projected: p.state };
      syncCondition(
        state,
        raised,
        cleared,
        'zone-breach',
        b.state.active,
        'critical',
        now,
        values,
        zone.id,
      );
      syncCondition(
        state,
        raised,
        cleared,
        'zone-projected',
        p.state.active,
        'warning',
        now,
        values,
        zone.id,
      );
    }
    // Zones removed or disabled since last tick: clear their conditions.
    for (const zoneId of Object.keys(det.zones)) {
      if (!seen.has(zoneId)) {
        det.zones = omit(det.zones, zoneId);
        syncCondition(state, raised, cleared, 'zone-breach', false, 'critical', now, {}, zoneId);
        syncCondition(state, raised, cleared, 'zone-projected', false, 'warning', now, {}, zoneId);
      }
    }
  }

  // ---- marina monitors: refrigeration bands, battery, solar.
  let marinaState = state.marina;
  if (watching && session?.mode === 'marina') {
    const m = stepMarina(state.marina, telemetry, ctx.marinaConfig, now, ctx.localHour ?? null);
    marinaState = m.state;
    for (const t of m.result.transitions) {
      events.push({ at: now, type: 'cold-box-band-changed', ...t });
    }
    const wanted = new Map(m.result.conditions.map((c) => [c.key, c]));
    const allKeys: MarinaConditionKey[] = [
      'fridge-warm',
      'fridge-failing',
      'freezer-warm',
      'freezer-failing',
      'battery-low',
      'solar-no-yield',
    ];
    for (const key of allKeys) {
      const c = wanted.get(key);
      syncCondition(
        state,
        raised,
        cleared,
        key,
        c !== undefined,
        c?.severity ?? 'warning',
        now,
        c?.values ?? {},
      );
    }
  }

  // ---- liveness: evaluated while DROPPING too, because the next step depends on it.
  const gpsSeverity: Severity | null =
    positionAgeMs >= config.gpsStaleCriticalMs
      ? 'critical'
      : positionAgeMs >= config.gpsStaleWarnMs
        ? 'warning'
        : null;
  syncCondition(
    state,
    raised,
    cleared,
    'gps-stale',
    gpsSeverity !== null,
    gpsSeverity ?? 'warning',
    now,
    {
      ageS: Math.round(positionAgeMs / 1000),
    },
  );

  const src = telemetry.source;
  const sourceDown = !src.connected && now - src.since >= config.sourceGraceMs;
  syncCondition(state, raised, cleared, 'source-disconnected', sourceDown, 'critical', now, {
    disconnectedS: src.connected ? 0 : Math.round((now - src.since) / 1000),
  });

  // ---- apply condition changes
  let conditions: Record<string, ActiveCondition> = { ...state.conditions };
  for (const key of cleared) {
    const c = conditions[key];
    if (!c) continue;
    conditions = omit(conditions, key);
    events.push({
      at: now,
      type: 'condition-cleared',
      key,
      id: c.id,
      durationMs: now - c.since,
      values: c.values,
    });
  }
  let newCritical = false;
  for (const c of raised) {
    const prev = conditions[c.key];
    if (prev && prev.severity !== c.severity) {
      if (c.severity === 'critical') newCritical = true;
      const escalated: ActiveCondition = { ...prev, severity: c.severity, values: c.values };
      conditions[c.key] = escalated;
      events.push({
        at: now,
        type: 'condition-escalated',
        condition: escalated,
        previousSeverity: prev.severity,
      });
    } else if (!prev) {
      if (c.severity === 'critical') newCritical = true;
      conditions[c.key] = c;
      events.push({ at: now, type: 'condition-raised', condition: c });
    } else {
      // Keep the latest measurements on the live condition without an event.
      conditions[c.key] = { ...prev, values: c.values };
    }
  }

  // ---- ack / refire
  let ackState = state.ack;
  let refires = state.refires;
  const active = Object.keys(conditions);
  if (active.length === 0) {
    ackState = null;
    refires = 0;
  } else if (ackState && newCritical) {
    // A new or escalated critical is new information; a snooze taken on a
    // warning must not silence it.
    ackState = null;
  } else if (ackState && now >= ackState.until) {
    // Snooze over and still alarming: re-fire, louder. The host maps `refires`
    // to volume; the ack is gone until someone presses it again.
    refires += 1;
    ackState = null;
    events.push({
      at: now,
      type: 'alarm-refire',
      refires,
      conditions: active,
      values: liveValuesFrom(live, sog),
    });
  }

  const next: WatchState = {
    ...state,
    conditions,
    detectors: det,
    lastPositionAt,
    ack: ackState,
    refires,
    live,
    marina: marinaState,
  };
  return finishTransition(state, next, events, now, liveValuesFrom(live, sog));
}

/**
 * Compare a detector's current truth against the condition map and queue a
 * raise or clear. Escalation (same key, higher severity) is expressed as a
 * raise with the new severity and resolved when applied.
 */
function syncCondition(
  state: WatchState,
  raised: ActiveCondition[],
  cleared: string[],
  id: ConditionId,
  active: boolean,
  severity: Severity,
  now: number,
  values: ConditionValues,
  zoneId?: string,
): void {
  const key = zoneId ? `${id}:${zoneId}` : id;
  const existing = state.conditions[key];
  if (active) {
    const since = existing?.since ?? now;
    raised.push(
      zoneId ? { key, id, severity, since, values, zoneId } : { key, id, severity, since, values },
    );
  } else if (existing) {
    cleared.push(key);
  }
}

export function deriveStateName(state: WatchState): WatchStateName {
  if (state.phase === 'IDLE' || state.phase === 'DROPPING') return state.phase;
  let worst: Severity | null = null;
  for (const c of Object.values(state.conditions)) {
    if (c.severity === 'critical') return 'ALARM';
    worst = 'warning';
  }
  return worst === 'warning' ? 'WARNING' : state.phase;
}

/** True when audio should be silent because of an unexpired ack. */
export function isSnoozed(state: WatchState, now: number): boolean {
  return state.ack !== null && now < state.ack.until;
}

/** Highest severity among active conditions, or null. */
export function worstSeverity(state: WatchState): Severity | null {
  let worst: Severity | null = null;
  for (const c of Object.values(state.conditions)) {
    if (c.severity === 'critical') return 'critical';
    worst = 'warning';
  }
  return worst;
}

function geometryValues(g: AnchorGeometry): ConditionValues {
  return {
    rodeLength: round(g.rodeLength),
    scopeRatio: round(g.scopeRatio, 2),
    swingRadius: round(g.swingRadius),
    horizontalRun: round(g.horizontalRun),
    depthAtDrop: round(g.depthAtDrop),
  };
}

function liveValues(state: WatchState): ConditionValues {
  return liveValuesFrom(state.live, null);
}

function liveValuesFrom(live: LiveValues, sog: number | null): ConditionValues {
  return {
    distance: round(live.distanceFromAnchor),
    distanceToEdge: round(live.distanceToEdge),
    sog: round(sog),
    positionAgeS: live.positionAgeS,
  };
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(record)) if (k !== key) out[k] = v;
  return out;
}

function round(v: number | null, dp = 1): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
