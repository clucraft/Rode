import { bearingRad, distanceM, toLocalXY, type LatLon } from '@rode/core';
import type { AisTarget, Normalizer } from '@rode/ingest';
import type {
  AisTargetView,
  FullState,
  HealthView,
  InstrumentsView,
  TimeView,
} from '@rode/protocol';
import { databaseSizeBytes } from './db/database.js';
import type { Repos } from './db/repos.js';
import type { EngineHost } from './engine/host.js';
import type { IngestManager } from './ingest/manager.js';

/*
 * Assembles the client-facing views. Pure functions of server state; the
 * WebSocket layer diffs successive results to produce deltas.
 */

export interface StateDeps {
  engine: EngineHost;
  ingest: IngestManager;
  repos: Repos;
  dbFile: string;
  bootedAt: number;
  unexpectedRestart: boolean;
  timeZone: () => string;
  notificationsLastConfirmedAt: () => number | null;
  now?: () => number;
}

export function instrumentsView(normalizer: Normalizer, now: number): InstrumentsView {
  const out: InstrumentsView = {};
  const fields = normalizer.instruments(now);
  for (const [name, f] of Object.entries(fields)) {
    (out as Record<string, unknown>)[name] = {
      value: f.value,
      timestamp: f.timestamp,
      stale: f.stale,
      source: f.source,
    };
  }
  const extras = normalizer.getExtras();
  if (Object.keys(extras).length > 0) {
    out.extras = {};
    for (const [name, e] of Object.entries(extras)) {
      out.extras[name] = { ...e.field, unit: e.unit };
    }
  }
  return out;
}

/**
 * CPA/TCPA relative to own position and motion. At anchor own motion is
 * effectively zero, which is the case that matters: something coming at you
 * while you sit still.
 */
export function cpaTcpa(
  own: LatLon,
  ownSog: number,
  ownCog: number,
  target: LatLon,
  targetSog: number | null,
  targetCog: number | null,
): { cpa: number; tcpa: number | null } {
  const r = toLocalXY(own, target);
  const tv =
    targetSog !== null && targetCog !== null
      ? { x: targetSog * Math.sin(targetCog), y: targetSog * Math.cos(targetCog) }
      : { x: 0, y: 0 };
  const ov = { x: ownSog * Math.sin(ownCog), y: ownSog * Math.cos(ownCog) };
  const v = { x: tv.x - ov.x, y: tv.y - ov.y };
  const vv = v.x * v.x + v.y * v.y;
  const range = Math.hypot(r.x, r.y);
  if (vv < 1e-6) return { cpa: range, tcpa: null };
  const tcpa = -(r.x * v.x + r.y * v.y) / vv;
  if (tcpa <= 0) return { cpa: range, tcpa };
  const cx = r.x + v.x * tcpa;
  const cy = r.y + v.y * tcpa;
  return { cpa: Math.hypot(cx, cy), tcpa };
}

export function aisView(
  targets: AisTarget[],
  own: LatLon | null,
  ownSog: number,
  ownCog: number,
): AisTargetView[] {
  return targets
    .filter((t) => !t.own)
    .map((t) => {
      let range: number | null = null;
      let bearing: number | null = null;
      let cpa: number | null = null;
      let tcpa: number | null = null;
      if (own && t.lat !== null && t.lon !== null) {
        const pos = { lat: t.lat, lon: t.lon };
        range = distanceM(own, pos);
        bearing = bearingRad(own, pos);
        const c = cpaTcpa(own, ownSog, ownCog, pos, t.sog, t.cog);
        cpa = c.cpa;
        tcpa = c.tcpa;
      }
      return {
        mmsi: t.mmsi,
        own: t.own,
        class: t.class,
        name: t.name,
        callsign: t.callsign,
        shipType: t.shipType,
        navStatus: t.navStatus,
        lat: t.lat,
        lon: t.lon,
        sog: t.sog,
        cog: t.cog,
        heading: t.heading,
        length: t.length,
        beam: t.beam,
        lastSeen: t.lastSeen,
        lastPositionAt: t.lastPositionAt,
        range,
        bearing,
        cpa,
        tcpa,
      };
    })
    .sort((a, b) => (a.range ?? Infinity) - (b.range ?? Infinity));
}

/**
 * Local hour in the configured time zone. Returns null when the system clock
 * is obviously unset (pre-2020) and GPS time has not arrived yet.
 */
export function localHour(now: number, timeZone: string): number | null {
  if (now < Date.UTC(2020, 0, 1)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const h = parts.find((p) => p.type === 'hour')?.value;
    return h === undefined ? null : Number(h);
  } catch {
    return new Date(now).getUTCHours();
  }
}

export function timeView(normalizer: Normalizer, now: number): TimeView {
  const gps = normalizer.getGpsTime();
  return {
    now,
    gpsSynced: gps !== null,
    gpsOffsetMs: gps ? gps.epochMs - gps.receivedAt : null,
    lastGpsSyncAt: gps?.receivedAt ?? null,
  };
}

export function healthView(deps: StateDeps, now: number): HealthView {
  return {
    engineTicks: deps.engine.ticks,
    lastTickAt: deps.engine.lastTickAt,
    unexpectedRestart: deps.unexpectedRestart,
    bootedAt: deps.bootedAt,
    uptimeMs: now - deps.bootedAt,
    dbSizeBytes: databaseSizeBytes(deps.dbFile),
    notificationsLastConfirmedAt: deps.notificationsLastConfirmedAt(),
  };
}

export function fullState(deps: StateDeps): FullState {
  const now = (deps.now ?? Date.now)();
  const n = deps.ingest.normalizer;
  const watch = deps.engine.view();
  const own = watch.live.boat ?? n.getField('position')?.value ?? null;
  const sog = n.getField('sog')?.value ?? 0;
  const cog = n.getField('cog')?.value ?? 0;
  return {
    watch,
    instruments: instrumentsView(n, now),
    source: deps.ingest.view(),
    ais: aisView(n.ais.all(), own, sog, cog),
    time: timeView(n, now),
    health: healthView(deps, now),
    recentEvents: deps.repos.events.recent(50),
  };
}
