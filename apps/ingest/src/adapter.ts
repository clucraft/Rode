/**
 * Connection state of a data source. This is first-class: it is exposed on the
 * API, shown in the UI, and is an input to the alarm engine (a disconnected
 * source beyond the grace period is an alarm condition, not a diagnostic).
 */
export type ConnectionState =
  | { kind: 'disconnected'; since: number; reason?: string }
  | { kind: 'connecting'; attempt: number; nextRetryMs: number }
  | { kind: 'connected'; since: number };

/** Identifier for a source implementation, selectable by config. */
export type SourceKind = 'nmea0183-tcp' | 'nmea0183-udp' | 'signalk-ws' | 'simulator' | 'replay';

/**
 * Every source implements this. `start` must be safe to call after `stop`
 * (ingestion restarts must not touch the anchor session, which lives in the
 * engine, not here).
 */
export interface SourceAdapter {
  readonly kind: SourceKind;
  start(): Promise<void>;
  stop(): Promise<void>;
  getConnectionState(): ConnectionState;
}
