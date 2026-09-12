import { randomUUID } from 'node:crypto';
import {
  applyCommand,
  createWatchState,
  isSnoozed,
  rehydrateWatchState,
  tick,
  type Command,
  type EngineContext,
  type EngineEvent,
  type Telemetry,
  type WatchState,
} from '@rode/core';
import type { EventRecord, WatchView } from '@rode/protocol';
import type { Bus } from '../bus.js';
import type { Db } from '../db/database.js';
import type { Repos } from '../db/repos.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from '../settings.js';

/*
 * The engine host. Owns the WatchState, ticks the pure engine at 1 Hz from
 * the in-memory telemetry stream, persists state and events in one SQLite
 * transaction, and publishes changes on the bus.
 *
 * This is the only place that touches the clock, the database, or the
 * engine state. The web app is a view of what happens here; it never
 * computes anything. See spec §2.1 and docs/decisions.md 0.2.
 *
 * Persistence strategy: every event forces a write (the state that produced
 * it must survive a power cut), and a periodic write every PERSIST_EVERY_MS
 * keeps detector timers roughly current without hammering the SD card.
 */

const TICK_MS = 1000;
const PERSIST_EVERY_MS = 15_000;

export interface EngineHostOptions {
  db: Db;
  repos: Repos;
  bus: Bus;
  settings: SettingsService;
  log: Logger;
  /** Latest telemetry snapshot, evaluated at `now`. */
  telemetry: (now: number) => Telemetry;
  /** Local hour for the solar window, or null when unknown. */
  localHour: (now: number) => number | null;
  now?: () => number;
}

export class EngineHost {
  private state: WatchState;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private lastPersistAt = 0;
  /** Supervisor heartbeat: advances on every completed tick. */
  public ticks = 0;
  public lastTickAt: number | null = null;
  /** Set when boot found persisted state with an active session. */
  public rehydrated = false;

  constructor(private readonly opts: EngineHostOptions) {
    this.now = opts.now ?? Date.now;
    this.state = this.boot();
  }

  /** Load persisted state, or start fresh. Logs what it found. */
  private boot(): WatchState {
    const now = this.now();
    const loaded = this.opts.repos.engineState.load();
    if (loaded) {
      const state = rehydrateWatchState(loaded.state, now);
      const active = state.phase !== 'IDLE' && state.session;
      this.rehydrated = Boolean(active);
      this.opts.log.info(
        {
          phase: state.phase,
          sessionId: state.session?.id ?? null,
          persistedAgoMs: now - loaded.updatedAt,
          conditions: Object.keys(state.conditions),
        },
        active ? 'rehydrated active anchor session' : 'rehydrated idle engine state',
      );
      return state;
    }
    this.opts.log.info('no persisted engine state; starting idle');
    return createWatchState(now);
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Never keep the process alive just for the tick; shutdown handles it.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.persist(this.now(), []);
  }

  getState(): WatchState {
    return this.state;
  }

  private context(now: number): EngineContext {
    const s = this.opts.settings;
    return {
      now,
      telemetry: this.opts.telemetry(now),
      config: s.alarm(),
      boat: s.boat(),
      zones: this.opts.repos.zones.active(),
      marinaConfig: s.marina(),
      localHour: this.opts.localHour(now),
      suggestedScope: s.suggestedScope(),
      newId: () => randomUUID(),
    };
  }

  /** One evaluation. Public so tests can drive it without timers. */
  tick(): EngineEvent[] {
    const now = this.now();
    let events: EngineEvent[] = [];
    try {
      const before = this.state;
      const r = tick(before, this.context(now));
      this.state = r.state;
      events = r.events;
      const changed = r.state !== before && stateChanged(before, r.state);
      if (events.length > 0 || now - this.lastPersistAt >= PERSIST_EVERY_MS)
        this.persist(now, events);
      if (changed || events.length > 0)
        this.opts.bus.emit('engine:state', { state: this.state, now });
    } catch (err) {
      // A tick must never stop the loop. Log loudly; the supervisor sees the
      // heartbeat still advancing but the error rate climbing.
      this.opts.log.error({ err }, 'engine tick failed');
    }
    this.ticks++;
    this.lastTickAt = now;
    return events;
  }

  /** Apply a skipper command, persist, publish, and tick immediately. */
  command(
    cmd: Command,
    by: string,
  ): { ok: boolean; reason?: string; message?: string; events: EngineEvent[] } {
    const now = this.now();
    const r = applyCommand(this.state, cmd, this.context(now));
    this.state = r.state;
    const rejected = r.events.find((e) => e.type === 'command-rejected');
    this.persist(now, r.events, by);
    this.opts.bus.emit('engine:state', { state: this.state, now });
    this.opts.log.info(
      {
        cmd: cmd.type,
        by,
        rejected: rejected?.type === 'command-rejected' ? rejected.reason : null,
      },
      'command',
    );
    // Evaluate right away so the UI sees the consequence without waiting a second.
    const tickEvents = this.tick();
    if (rejected?.type === 'command-rejected') {
      return {
        ok: false,
        reason: rejected.reason,
        message: rejected.message,
        events: [...r.events, ...tickEvents],
      };
    }
    return { ok: true, events: [...r.events, ...tickEvents] };
  }

  /**
   * State + events in one transaction. If the process dies between the
   * engine producing an event and this commit, the event is lost *with* the
   * state that produced it, so the two can never disagree on disk.
   */
  private persist(now: number, events: EngineEvent[], by?: string): void {
    const { repos, db, bus } = this.opts;
    const sessionId = this.state.session?.id ?? null;
    const records: EventRecord[] = [];
    db.transaction(() => {
      repos.engineState.save(this.state, now);
      for (const e of events) {
        const data = by ? { ...e, by } : e;
        const seq = repos.events.appendEngine(data, sessionId);
        records.push({
          seq,
          at: e.at,
          sessionId,
          type: e.type,
          severity: severityOfEvent(e),
          data,
        });
        this.bookkeepSession(e, by ?? null);
      }
    })();
    this.lastPersistAt = now;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const record = records[i];
      if (event && record) bus.emit('engine:event', { event, record });
    }
  }

  /** Keep the anchor_sessions row in step with the session inside the state. */
  private bookkeepSession(e: EngineEvent, by: string | null): void {
    const s = this.state.session;
    if (!s) return;
    switch (e.type) {
      case 'session-started':
      case 'anchor-dropped':
      case 'depth-entered':
      case 'anchor-set':
      case 'anchor-nudged':
      case 'tide-updated':
      case 'radius-overridden':
      case 'radius-override-cleared':
      case 'geometry-recomputed':
      case 'marina-started':
        this.opts.repos.sessions.upsert(s);
        break;
      case 'session-ended':
        this.opts.repos.sessions.upsert(s, by ?? e.by);
        break;
      case 'condition-raised':
        this.opts.repos.sessions.bumpStats(
          s.id,
          this.state.live.distanceFromAnchor,
          e.condition.severity === 'warning' ? 1 : 0,
          e.condition.severity === 'critical' ? 1 : 0,
        );
        break;
      case 'condition-escalated':
        this.opts.repos.sessions.bumpStats(s.id, this.state.live.distanceFromAnchor, 0, 1);
        break;
      default:
        break;
    }
  }

  /** Record the running maximum distance once a minute; cheap and useful in history. */
  recordDistance(): void {
    const s = this.state.session;
    if (s && this.state.live.distanceFromAnchor !== null) {
      this.opts.repos.sessions.bumpStats(s.id, this.state.live.distanceFromAnchor, 0, 0);
    }
  }

  view(): WatchView {
    const now = this.now();
    return {
      phase: this.state.phase,
      stateName: this.state.stateName,
      session: this.state.session,
      conditions: Object.values(this.state.conditions),
      ack: this.state.ack,
      snoozed: isSnoozed(this.state, now),
      refires: this.state.refires,
      live: this.state.live,
      marina: this.state.marina,
    };
  }
}

/** Cheap change detection for the bus: the things the UI renders. */
function stateChanged(a: WatchState, b: WatchState): boolean {
  if (a.stateName !== b.stateName || a.phase !== b.phase) return true;
  if (a.ack !== b.ack || a.refires !== b.refires) return true;
  if (a.session !== b.session) return true;
  const la = a.live;
  const lb = b.live;
  return (
    la.distanceFromAnchor !== lb.distanceFromAnchor ||
    la.boat?.lat !== lb.boat?.lat ||
    la.boat?.lon !== lb.boat?.lon ||
    la.positionAgeS !== lb.positionAgeS ||
    la.suggestedRode !== lb.suggestedRode
  );
}

function severityOfEvent(e: EngineEvent): EventRecord['severity'] {
  switch (e.type) {
    case 'condition-raised':
    case 'condition-escalated':
      return e.condition.severity;
    case 'alarm-refire':
      return 'critical';
    case 'state-changed':
      return e.to === 'ALARM' ? 'critical' : e.to === 'WARNING' ? 'warning' : 'info';
    case 'command-rejected':
      return 'warning';
    default:
      return 'info';
  }
}
