import type {
  Acknowledgement,
  ActiveCondition,
  AnchorSession,
  EngineEvent,
  LiveValues,
  MarinaState,
  WatchPhase,
  WatchStateName,
} from '@rode/core';
import type { ViewPrefs } from './api.js';

/*
 * What the web app sees. These are views: derived from engine and normaliser
 * state on the server, never computed in the browser.
 */

/** Engine state as shown to clients. */
export interface WatchView {
  phase: WatchPhase;
  stateName: WatchStateName;
  session: AnchorSession | null;
  conditions: ActiveCondition[];
  ack: Acknowledgement | null;
  /** True while an unexpired ack is silencing audio. */
  snoozed: boolean;
  refires: number;
  live: LiveValues;
  marina: MarinaState;
}

export interface FieldView<T = number> {
  value: T;
  timestamp: number;
  stale: boolean;
  source: string;
}

/** Every instrument the normaliser currently holds, keyed by field name. */
export interface InstrumentsView {
  position?: FieldView<{ lat: number; lon: number }>;
  sog?: FieldView;
  cog?: FieldView;
  heading?: FieldView;
  depth?: FieldView;
  awa?: FieldView;
  aws?: FieldView;
  twa?: FieldView;
  tws?: FieldView;
  twd?: FieldView;
  hdop?: FieldView;
  fixQuality?: FieldView;
  satellites?: FieldView;
  waterTemp?: FieldView;
  airTemp?: FieldView;
  pressure?: FieldView;
  batteryVoltage?: FieldView;
  batterySoc?: FieldView;
  solarPower?: FieldView;
  fridgeTemp?: FieldView;
  freezerTemp?: FieldView;
  /** Unmapped XDR transducers, keyed by their name, with the unit as sent. */
  extras?: Record<string, FieldView & { unit: string }>;
}

export type ConnectionStateView =
  | { kind: 'disconnected'; since: number; reason?: string }
  | { kind: 'connecting'; since: number; attempt: number; nextRetryMs: number }
  | { kind: 'connected'; since: number; remote?: string };

export interface SourceView {
  kind: string;
  state: ConnectionStateView;
  stats: Record<string, number | string | null>;
  /** Last time any sentence was accepted. */
  lastSentenceAt: number | null;
}

export interface AisTargetView {
  mmsi: string;
  own: boolean;
  class: 'A' | 'B' | 'other';
  name: string | null;
  callsign: string | null;
  shipType: number | null;
  navStatus: number | null;
  lat: number | null;
  lon: number | null;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  length: number | null;
  beam: number | null;
  lastSeen: number;
  lastPositionAt: number | null;
  /** Range from own bow roller, metres; null without positions. */
  range: number | null;
  /** Bearing from own boat, radians true. */
  bearing: number | null;
  /** Closest point of approach, metres, computed for the anchored case. */
  cpa: number | null;
  /** Time to CPA, seconds; negative means diverging. */
  tcpa: number | null;
}

export interface TimeView {
  /** Server wall clock, ms epoch. */
  now: number;
  /** Where the server's clock comes from. "unsynced" means timestamps cannot be trusted yet. */
  clockSource: 'system' | 'gps' | 'unsynced';
  /** True once a plausible GPS time has been seen this boot. */
  gpsSynced: boolean;
  /** GPS time minus system time at the last sync, ms. Large values mean the system clock is wrong. */
  gpsOffsetMs: number | null;
  lastGpsSyncAt: number | null;
}

export interface HealthView {
  /** Engine ticks since boot; the supervisor watches this advance. */
  engineTicks: number;
  lastTickAt: number | null;
  /** True when the last boot found no clean-shutdown flag. */
  unexpectedRestart: boolean;
  bootedAt: number;
  uptimeMs: number;
  dbSizeBytes: number;
  notificationsLastConfirmedAt: number | null;
}

export interface FullState {
  watch: WatchView;
  instruments: InstrumentsView;
  source: SourceView;
  ais: AisTargetView[];
  time: TimeView;
  health: HealthView;
  /** The most recent events, newest last, for the UI's activity strip. */
  recentEvents: EventRecord[];
  /** Shared display preferences; every device shows the same thing. */
  prefs: ViewPrefs;
}

/** An event as persisted: the engine event plus its log sequence. */
export interface EventRecord {
  seq: number;
  at: number;
  sessionId: string | null;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  data: EngineEvent | Record<string, unknown>;
}

// ---------------------------------------------------------------- websocket

/** Client → server. */
export type ClientMessage =
  | {
      type: 'subscribe';
      /** Desired telemetry update interval, ms. Server clamps to [500, 10000]. */
      intervalMs?: number;
      /** Drop instruments and AIS to the minimum; the chart is suspended client-side. */
      lowBandwidth?: boolean;
    }
  | { type: 'ping'; t: number };

/** Server → client. Deltas carry only what changed since the last message. */
export type ServerMessage =
  | { type: 'hello'; serverTime: number; version: string; intervalMs: number }
  | { type: 'snapshot'; state: FullState }
  | {
      type: 'delta';
      watch?: WatchView;
      instruments?: Partial<InstrumentsView>;
      source?: SourceView;
      ais?: { upsert?: AisTargetView[]; remove?: string[] };
      time?: TimeView;
      health?: HealthView;
      events?: EventRecord[];
      prefs?: ViewPrefs;
    }
  | { type: 'pong'; t: number; serverTime: number };
