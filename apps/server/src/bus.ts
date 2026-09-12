import type { EngineEvent, WatchState } from '@rode/core';
import type { AisUpdate, ConnectionState, NormalizerEvent } from '@rode/ingest';
import type { EventRecord } from '@rode/protocol';

/*
 * The internal bus: a tiny typed in-process pub/sub. No Redis, no sockets;
 * everything that needs to know about engine or telemetry changes runs in
 * this process (docs/decisions.md 0.2 / 0.3). The last engine state is the
 * persisted snapshot in SQLite, not a bus feature.
 */

export interface BusEvents {
  /** Engine state after a tick or command. Fired only when something changed. */
  'engine:state': { state: WatchState; now: number };
  /** Every engine event, already persisted with its sequence number. */
  'engine:event': { event: EngineEvent; record: EventRecord };
  /** Non-engine events appended to the log (auth, notifications, system). */
  'log:event': { record: EventRecord };
  /** Raw normaliser events (field updates, AIS, time). */
  telemetry: NormalizerEvent;
  ais: AisUpdate;
  'source:state': { kind: string; state: ConnectionState };
  /** Settings were changed; consumers reload what they cache. */
  'settings:changed': { keys: string[] };
}

type Listener<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

export class Bus {
  private readonly listeners = new Map<keyof BusEvents, Set<Listener<keyof BusEvents>>>();

  on<K extends keyof BusEvents>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<keyof BusEvents>);
    return () => {
      set.delete(listener as Listener<keyof BusEvents>);
    };
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const l of set) {
      try {
        (l as Listener<K>)(payload);
      } catch (err) {
        // A misbehaving subscriber must never take down the engine tick.
        console.error(`bus listener for ${event} threw`, err);
      }
    }
  }
}
