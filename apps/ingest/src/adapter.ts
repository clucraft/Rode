import type { Command, LatLon } from '@rode/core';
import type { FieldName } from './normalize.js';

/**
 * Connection state of a data source. This is first-class: it is exposed on the
 * API, shown in the UI, and is an input to the alarm engine (a disconnected
 * source beyond the grace period is an alarm condition, not a diagnostic).
 */
export type ConnectionState =
  | { kind: 'disconnected'; since: number; reason?: string }
  | { kind: 'connecting'; since: number; attempt: number; nextRetryMs: number }
  | { kind: 'connected'; since: number; remote?: string };

/** Identifier for a source implementation, selectable by config. */
export type SourceKind = 'nmea0183-tcp' | 'nmea0183-udp' | 'signalk-ws' | 'simulator' | 'replay';

/**
 * What a source produces. NMEA sources emit raw lines for the normaliser to
 * parse; Signal K already speaks SI and emits fields directly. Both emit
 * connection-state changes. The simulator may also emit the scenario's
 * scripted skipper commands so a demo can run itself.
 */
export type SourceEvent =
  | { type: 'line'; line: string; now: number }
  | { type: 'field'; name: FieldName; value: number | LatLon; timestamp: number; source: string }
  | { type: 'state'; state: ConnectionState }
  | { type: 'command'; command: Command; now: number };

export type SourceListener = (event: SourceEvent) => void;

/**
 * Every source implements this. `start` must be safe to call after `stop`
 * (ingestion restarts must not touch the anchor session, which lives in the
 * engine, not here).
 */
export interface SourceAdapter {
  readonly kind: SourceKind;
  start(): void;
  stop(): Promise<void>;
  getConnectionState(): ConnectionState;
  on(listener: SourceListener): () => void;
  /** Free-form diagnostics for the UI: bytes, lines, reconnects, last error. */
  stats(): Record<string, number | string | null>;
}

/** Reconnect backoff: 1 s, 2 s, 4 s … capped at 30 s, with ±20 % jitter. */
export function backoffMs(
  attempt: number,
  capMs = 30_000,
  random: () => number = Math.random,
): number {
  const base = Math.min(capMs, 1000 * 2 ** Math.max(0, attempt));
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.round(Math.min(capMs, base * jitter));
}

/** Shared listener plumbing for adapters. */
export class SourceEmitter {
  private readonly listeners = new Set<SourceListener>();
  private state: ConnectionState;

  constructor(now: number) {
    this.state = { kind: 'disconnected', since: now, reason: 'not started' };
  }

  on(listener: SourceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: SourceEvent): void {
    for (const l of this.listeners) l(event);
  }

  getState(): ConnectionState {
    return this.state;
  }

  setState(state: ConnectionState): void {
    // Collapse identical transitions so a flapping socket does not spam the log.
    if (state.kind === this.state.kind && state.kind !== 'connecting') return;
    this.state = state;
    this.emit({ type: 'state', state });
  }
}
