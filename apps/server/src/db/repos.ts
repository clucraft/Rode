import type { AnchorSession, EngineEvent, ExclusionZone, LatLon, WatchState } from '@rode/core';
import type { EventRecord, SessionSummary, TrackPoint, ZoneRecord } from '@rode/protocol';
import type { Statement } from 'better-sqlite3';
import type { Db } from './database.js';

/*
 * Thin typed repositories. Statements are prepared once per repo instance;
 * better-sqlite3 is synchronous, which keeps the 1 Hz engine tick simple and
 * makes "persist state + append events" one transaction.
 */

// ---------------------------------------------------------------- base

abstract class Repo {
  private readonly cache = new Map<string, Statement>();
  constructor(protected readonly db: Db) {}

  /** Prepare once per SQL string, on first use. */
  protected stmt(sql: string): Statement {
    let st = this.cache.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.cache.set(sql, st);
    }
    return st;
  }
}

// ---------------------------------------------------------------- settings

export class SettingsRepo extends Repo {
  private get get_(): Statement {
    return this.stmt('SELECT value FROM settings WHERE key = ?');
  }
  private get all_(): Statement {
    return this.stmt('SELECT key, value FROM settings');
  }
  private get set_(): Statement {
    return this.stmt(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    );
  }

  get(key: string): unknown {
    const row = this.get_.get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as unknown) : undefined;
  }

  set(key: string, value: unknown, now = Date.now()): void {
    this.set_.run(key, JSON.stringify(value), now);
  }

  all(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.all_.all() as { key: string; value: string }[])
      out[r.key] = JSON.parse(r.value);
    return out;
  }
}

// ---------------------------------------------------------------- runtime flags

export class RuntimeRepo extends Repo {
  private get get_(): Statement {
    return this.stmt('SELECT value FROM runtime WHERE key = ?');
  }
  private get set_(): Statement {
    return this.stmt(
      'INSERT INTO runtime (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
  }
  private get del_(): Statement {
    return this.stmt('DELETE FROM runtime WHERE key = ?');
  }

  get(key: string): string | undefined {
    return (this.get_.get(key) as { value: string } | undefined)?.value;
  }
  set(key: string, value: string): void {
    this.set_.run(key, value);
  }
  delete(key: string): void {
    this.del_.run(key);
  }
}

// ---------------------------------------------------------------- engine state

export class EngineStateRepo extends Repo {
  private get load_(): Statement {
    return this.stmt('SELECT state, updated_at FROM engine_state WHERE id = 1');
  }
  private get save_(): Statement {
    return this.stmt(
      'INSERT INTO engine_state (id, state, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at',
    );
  }

  load(): { state: WatchState; updatedAt: number } | null {
    const row = this.load_.get() as { state: string; updated_at: number } | undefined;
    if (!row) return null;
    try {
      return { state: JSON.parse(row.state) as WatchState, updatedAt: row.updated_at };
    } catch {
      return null;
    }
  }

  save(state: WatchState, now: number): void {
    this.save_.run(JSON.stringify(state), now);
  }
}

// ---------------------------------------------------------------- anchor sessions

interface SessionRow {
  id: string;
  mode: 'anchor' | 'marina';
  started_at: number;
  ended_at: number | null;
  ended_by: string | null;
  drop_lat: number | null;
  drop_lon: number | null;
  drop_at: number | null;
  drop_corrected: number;
  depth_at_drop: number | null;
  depth_source: string | null;
  anchor_lat: number | null;
  anchor_lon: number | null;
  set_lat: number | null;
  set_lon: number | null;
  set_at: number | null;
  tide_range: number;
  geometry: string | null;
  marina_lat: number | null;
  marina_lon: number | null;
  marina_radius: number | null;
  max_distance: number | null;
  warning_count: number;
  alarm_count: number;
}

export class SessionsRepo extends Repo {
  private get upsert_(): Statement {
    return this.stmt(`
    INSERT INTO anchor_sessions (
      id, mode, started_at, ended_at, ended_by, drop_lat, drop_lon, drop_at, drop_corrected,
      depth_at_drop, depth_source, anchor_lat, anchor_lon, set_lat, set_lon, set_at, tide_range,
      geometry, marina_lat, marina_lon, marina_radius
    ) VALUES (
      @id, @mode, @started_at, @ended_at, @ended_by, @drop_lat, @drop_lon, @drop_at, @drop_corrected,
      @depth_at_drop, @depth_source, @anchor_lat, @anchor_lon, @set_lat, @set_lon, @set_at, @tide_range,
      @geometry, @marina_lat, @marina_lon, @marina_radius
    ) ON CONFLICT(id) DO UPDATE SET
      ended_at = excluded.ended_at, ended_by = COALESCE(excluded.ended_by, ended_by),
      drop_lat = excluded.drop_lat, drop_lon = excluded.drop_lon, drop_at = excluded.drop_at,
      drop_corrected = excluded.drop_corrected, depth_at_drop = excluded.depth_at_drop,
      depth_source = excluded.depth_source, anchor_lat = excluded.anchor_lat, anchor_lon = excluded.anchor_lon,
      set_lat = excluded.set_lat, set_lon = excluded.set_lon, set_at = excluded.set_at,
      tide_range = excluded.tide_range, geometry = excluded.geometry,
      marina_lat = excluded.marina_lat, marina_lon = excluded.marina_lon, marina_radius = excluded.marina_radius
  `);
  }
  private get stats_(): Statement {
    return this.stmt(
      'UPDATE anchor_sessions SET max_distance = MAX(COALESCE(max_distance, 0), ?), warning_count = warning_count + ?, alarm_count = alarm_count + ? WHERE id = ?',
    );
  }
  private get list_(): Statement {
    return this.stmt('SELECT * FROM anchor_sessions ORDER BY started_at DESC LIMIT ? OFFSET ?');
  }
  private get get_(): Statement {
    return this.stmt('SELECT * FROM anchor_sessions WHERE id = ?');
  }
  private get count_(): Statement {
    return this.stmt('SELECT COUNT(*) AS n FROM anchor_sessions');
  }

  upsert(s: AnchorSession, endedBy: string | null = null): void {
    this.upsert_.run({
      id: s.id,
      mode: s.mode,
      started_at: s.startedAt,
      ended_at: s.endedAt,
      ended_by: endedBy,
      drop_lat: s.dropPosition?.lat ?? null,
      drop_lon: s.dropPosition?.lon ?? null,
      drop_at: s.dropAt,
      drop_corrected: s.dropCorrected ? 1 : 0,
      depth_at_drop: s.depthAtDrop,
      depth_source: s.depthSource,
      anchor_lat: s.anchor?.lat ?? null,
      anchor_lon: s.anchor?.lon ?? null,
      set_lat: s.setPosition?.lat ?? null,
      set_lon: s.setPosition?.lon ?? null,
      set_at: s.setAt,
      tide_range: s.tideRange,
      // The manual circle rides along inside the geometry JSON so History can
      // show what was actually watched without a schema change.
      geometry:
        s.geometry || s.radiusOverride
          ? JSON.stringify({ ...(s.geometry ?? {}), radiusOverride: s.radiusOverride ?? null })
          : null,
      marina_lat: null,
      marina_lon: null,
      marina_radius: null,
    });
  }

  bumpStats(id: string, distance: number | null, warnings: number, alarms: number): void {
    this.stats_.run(distance ?? 0, warnings, alarms, id);
  }

  list(limit = 50, offset = 0): SessionSummary[] {
    return (this.list_.all(limit, offset) as SessionRow[]).map(toSummary);
  }

  get(id: string): SessionSummary | null {
    const row = this.get_.get(id) as SessionRow | undefined;
    return row ? toSummary(row) : null;
  }

  count(): number {
    return (this.count_.get() as { n: number }).n;
  }
}

function toSummary(r: SessionRow): SessionSummary {
  const anchor: LatLon | null =
    r.mode === 'marina'
      ? r.marina_lat !== null && r.marina_lon !== null
        ? { lat: r.marina_lat, lon: r.marina_lon }
        : null
      : r.anchor_lat !== null && r.anchor_lon !== null
        ? { lat: r.anchor_lat, lon: r.anchor_lon }
        : null;
  return {
    id: r.id,
    mode: r.mode,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    geometry: r.geometry ? (JSON.parse(r.geometry) as Record<string, unknown>) : null,
    anchor,
    depthAtDrop: r.depth_at_drop,
    maxDistance: r.max_distance,
    warningCount: r.warning_count,
    alarmCount: r.alarm_count,
    endedBy: r.ended_by,
  };
}

// ---------------------------------------------------------------- events

export type EventSeverity = 'info' | 'warning' | 'critical';

export function severityOf(e: EngineEvent): EventSeverity {
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

export class EventsRepo extends Repo {
  private get insert_(): Statement {
    return this.stmt(
      'INSERT INTO events (at, session_id, type, severity, data) VALUES (?, ?, ?, ?, ?)',
    );
  }
  private get recent_(): Statement {
    return this.stmt('SELECT * FROM events ORDER BY seq DESC LIMIT ?');
  }
  private get range_(): Statement {
    return this.stmt('SELECT * FROM events WHERE at >= ? AND at <= ? ORDER BY seq ASC LIMIT ?');
  }
  private get session_(): Statement {
    return this.stmt('SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC LIMIT ?');
  }
  private get byType_(): Statement {
    return this.stmt('SELECT * FROM events WHERE type = ? AND at >= ? ORDER BY seq DESC LIMIT ?');
  }

  /** Append an engine event. Returns the sequence number. */
  appendEngine(e: EngineEvent, sessionId: string | null): number {
    const r = this.insert_.run(e.at, sessionId, e.type, severityOf(e), JSON.stringify(e));
    return Number(r.lastInsertRowid);
  }

  /** Append a non-engine event (auth, notification, system). */
  append(
    type: string,
    data: Record<string, unknown>,
    severity: EventSeverity = 'info',
    at = Date.now(),
    sessionId: string | null = null,
  ): number {
    const r = this.insert_.run(
      at,
      sessionId,
      type,
      severity,
      JSON.stringify({ at, type, ...data }),
    );
    return Number(r.lastInsertRowid);
  }

  recent(limit = 50): EventRecord[] {
    return (this.recent_.all(limit) as EventRow[]).map(toEvent).reverse();
  }

  range(from: number, to: number, limit = 500): EventRecord[] {
    return (this.range_.all(from, to, limit) as EventRow[]).map(toEvent);
  }

  forSession(sessionId: string, limit = 5000): EventRecord[] {
    return (this.session_.all(sessionId, limit) as EventRow[]).map(toEvent);
  }

  latestOfType(type: string, since = 0, limit = 20): EventRecord[] {
    return (this.byType_.all(type, since, limit) as EventRow[]).map(toEvent);
  }
}

interface EventRow {
  seq: number;
  at: number;
  session_id: string | null;
  type: string;
  severity: EventSeverity;
  data: string;
}

function toEvent(r: EventRow): EventRecord {
  return {
    seq: r.seq,
    at: r.at,
    sessionId: r.session_id,
    type: r.type,
    severity: r.severity,
    data: JSON.parse(r.data) as EventRecord['data'],
  };
}

// ---------------------------------------------------------------- samples

export interface SampleInput {
  at: number;
  lat: number | null;
  lon: number | null;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  depth: number | null;
  awa: number | null;
  aws: number | null;
  hdop: number | null;
  distance: number | null;
  extra: Record<string, number> | null;
}

export class SamplesRepo extends Repo {
  private get insert_(): Statement {
    return this.stmt(
      'INSERT OR REPLACE INTO samples (at, lat, lon, sog, cog, heading, depth, awa, aws, hdop, distance, extra) VALUES (@at, @lat, @lon, @sog, @cog, @heading, @depth, @awa, @aws, @hdop, @distance, @extra)',
    );
  }
  private insertMany_(rows: SampleInput[]): void {
    this.db.transaction(() => {
      for (const r of rows)
        this.insert_.run({ ...r, extra: r.extra ? JSON.stringify(r.extra) : null });
    })();
  }
  private get track_(): Statement {
    return this.stmt(
      'SELECT at, lat, lon, sog, heading, distance FROM samples WHERE at >= ? AND at <= ? AND lat IS NOT NULL ORDER BY at ASC LIMIT ?',
    );
  }
  private get series_(): Statement {
    return this.stmt('SELECT * FROM samples WHERE at >= ? AND at <= ? ORDER BY at ASC LIMIT ?');
  }
  private get count_(): Statement {
    return this.stmt('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM samples');
  }

  insertMany(rows: SampleInput[]): void {
    if (rows.length > 0) this.insertMany_(rows);
  }

  track(from: number, to: number, limit = 20_000): TrackPoint[] {
    return this.track_.all(from, to, limit) as TrackPoint[];
  }

  series(
    from: number,
    to: number,
    limit = 20_000,
  ): (Omit<SampleInput, 'extra'> & { extra: string | null })[] {
    return this.series_.all(from, to, limit) as (Omit<SampleInput, 'extra'> & {
      extra: string | null;
    })[];
  }

  stats(): { count: number; oldest: number | null } {
    const r = this.count_.get() as { n: number; oldest: number | null };
    return { count: r.n, oldest: r.oldest };
  }

  /**
   * Nightly housekeeping: anything older than `keepFullMs` is thinned to one
   * sample per `bucketMs`; anything older than `retentionMs` is deleted.
   * Runs as one transaction per step so a power cut mid-way leaves a
   * consistent table.
   */
  downsample(
    now: number,
    keepFullMs: number,
    bucketMs: number,
    retentionMs: number,
  ): { thinned: number; pruned: number } {
    const cutoff = now - keepFullMs;
    const pruned = this.db
      .prepare('DELETE FROM samples WHERE at < ?')
      .run(now - retentionMs).changes;
    // Keep the first sample of each bucket, delete the rest.
    const thinned = this.db
      .prepare(
        `DELETE FROM samples WHERE at < ? AND at NOT IN (
           SELECT MIN(at) FROM samples WHERE at < ? GROUP BY at / ?
         )`,
      )
      .run(cutoff, cutoff, bucketMs).changes;
    return { thinned, pruned };
  }
}

// ---------------------------------------------------------------- zones

interface ZoneRow {
  id: string;
  name: string;
  kind: 'never-enter' | 'must-stay-inside';
  enabled: number;
  polygon: string;
  created_at: number;
  updated_at: number;
}

export class ZonesRepo extends Repo {
  private get all_(): Statement {
    return this.stmt('SELECT * FROM zones ORDER BY created_at ASC');
  }
  private get get_(): Statement {
    return this.stmt('SELECT * FROM zones WHERE id = ?');
  }
  private get insert_(): Statement {
    return this.stmt(
      'INSERT INTO zones (id, name, kind, enabled, polygon, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
  }
  private get update_(): Statement {
    return this.stmt(
      'UPDATE zones SET name = ?, kind = ?, enabled = ?, polygon = ?, updated_at = ? WHERE id = ?',
    );
  }
  private get delete_(): Statement {
    return this.stmt('DELETE FROM zones WHERE id = ?');
  }

  all(): ZoneRecord[] {
    return (this.all_.all() as ZoneRow[]).map(toZone);
  }

  /** Engine-facing view. */
  active(): ExclusionZone[] {
    return this.all().map((z) => ({
      id: z.id,
      name: z.name,
      kind: z.kind,
      enabled: z.enabled,
      polygon: z.polygon,
    }));
  }

  get(id: string): ZoneRecord | null {
    const r = this.get_.get(id) as ZoneRow | undefined;
    return r ? toZone(r) : null;
  }

  insert(z: Omit<ZoneRecord, 'createdAt' | 'updatedAt'>, now = Date.now()): ZoneRecord {
    this.insert_.run(z.id, z.name, z.kind, z.enabled ? 1 : 0, JSON.stringify(z.polygon), now, now);
    return { ...z, createdAt: now, updatedAt: now };
  }

  update(z: Omit<ZoneRecord, 'createdAt' | 'updatedAt'>, now = Date.now()): boolean {
    return (
      this.update_.run(z.name, z.kind, z.enabled ? 1 : 0, JSON.stringify(z.polygon), now, z.id)
        .changes > 0
    );
  }

  delete(id: string): boolean {
    return this.delete_.run(id).changes > 0;
  }

  /** Weighing anchor leaves the anchorage; its zones go with it. Returns how many. */
  deleteAll(): number {
    return this.stmt('DELETE FROM zones').run().changes;
  }

  count(): number {
    return (this.stmt('SELECT COUNT(*) AS n FROM zones').get() as { n: number }).n;
  }
}

function toZone(r: ZoneRow): ZoneRecord {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    enabled: r.enabled === 1,
    polygon: JSON.parse(r.polygon) as LatLon[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------- bundle

export interface Repos {
  settings: SettingsRepo;
  runtime: RuntimeRepo;
  engineState: EngineStateRepo;
  sessions: SessionsRepo;
  events: EventsRepo;
  samples: SamplesRepo;
  zones: ZonesRepo;
}

export function createRepos(db: Db): Repos {
  return {
    settings: new SettingsRepo(db),
    runtime: new RuntimeRepo(db),
    engineState: new EngineStateRepo(db),
    sessions: new SessionsRepo(db),
    events: new EventsRepo(db),
    samples: new SamplesRepo(db),
    zones: new ZonesRepo(db),
  };
}
