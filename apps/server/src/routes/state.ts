import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HistoryQuery, type SeriesBucket } from '@rode/protocol';
import { parseQuery, type AppContext } from '../context.js';
import { requireRole } from '../auth/guard.js';
import { fullState } from '../state.js';

const HOUR = 3_600_000;

/** Read-only views: live state, event log, sessions, track history. */
export function stateRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/state', { preHandler: requireRole('crew') }, () => fullState(ctx.state));

  app.get('/api/events', { preHandler: requireRole('crew') }, (req, reply) => {
    const q = parseQuery(HistoryQuery, req, reply);
    if (!q) return;
    const to = q.to ?? ctx.now();
    const from = q.from ?? to - 24 * HOUR;
    return ctx.repos.events.range(from, to, q.limit);
  });

  app.get('/api/sessions', { preHandler: requireRole('crew') }, (req, reply) => {
    const q = parseQuery(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req,
      reply,
    );
    if (!q) return;
    return {
      total: ctx.repos.sessions.count(),
      sessions: ctx.repos.sessions.list(q.limit, q.offset),
    };
  });

  app.get('/api/sessions/:id', { preHandler: requireRole('crew') }, (req, reply) => {
    const { id } = req.params as { id: string };
    const session = ctx.repos.sessions.get(id);
    if (!session) return reply.code(404).send({ error: 'not-found' });
    const to = session.endedAt ?? ctx.now();
    return {
      session,
      events: ctx.repos.events.forSession(id),
      track: ctx.repos.samples.track(session.startedAt, to),
    };
  });

  app.get('/api/track', { preHandler: requireRole('crew') }, (req, reply) => {
    const q = parseQuery(HistoryQuery, req, reply);
    if (!q) return;
    const to = q.to ?? ctx.now();
    const from = q.from ?? to - HOUR;
    return ctx.repos.samples.track(from, to, q.limit);
  });

  /**
   * Rolling charts for the Data screen: the last hours bucketed to bucketS
   * seconds, averaged, with wind direction as a circular mean.
   * Done here rather than in SQL so direction averaging is honest.
   */
  app.get('/api/series/buckets', { preHandler: requireRole('crew') }, (req, reply) => {
    const q = parseQuery(
      z.object({
        hours: z.coerce.number().min(1).max(72).default(24),
        bucketS: z.coerce.number().int().min(10).max(3600).default(300),
      }),
      req,
      reply,
    );
    if (!q) return;
    const to = ctx.now();
    const from = to - q.hours * HOUR;
    const rows = ctx.repos.samples.series(from, to, 200_000);
    return bucketSeries(rows, q.bucketS * 1000);
  });

  /** The last hour of an AIS target's positions, oldest first; [] once it has timed out. */
  app.get<{ Params: { mmsi: string } }>(
    '/api/ais/:mmsi/track',
    { preHandler: requireRole('crew') },
    (req) => ctx.ingest.normalizer.ais.track(req.params.mmsi, ctx.now()),
  );

  app.get('/api/series', { preHandler: requireRole('crew') }, (req, reply) => {
    const q = parseQuery(HistoryQuery, req, reply);
    if (!q) return;
    const to = q.to ?? ctx.now();
    const from = q.from ?? to - 12 * HOUR;
    return ctx.repos.samples.series(from, to, q.limit).map((r) => ({
      ...r,
      extra: r.extra ? (JSON.parse(r.extra) as Record<string, number>) : null,
    }));
  });
}

interface RawSample {
  at: number;
  sog: number | null;
  heading: number | null;
  awa: number | null;
  aws: number | null;
  depth: number | null;
  extra: string | null;
}

/** Average each bucket; directions via mean of unit vectors. Exported for tests. */
export function bucketSeries(rows: RawSample[], bucketMs: number): SeriesBucket[] {
  const buckets = new Map<
    number,
    { n: Record<string, number>; sum: Record<string, number>; sx: number; sy: number; nd: number }
  >();
  for (const r of rows) {
    const key = Math.floor(r.at / bucketMs) * bucketMs;
    let b = buckets.get(key);
    if (!b) {
      b = { n: {}, sum: {}, sx: 0, sy: 0, nd: 0 };
      buckets.set(key, b);
    }
    const extra = r.extra ? (JSON.parse(r.extra) as Record<string, number>) : {};
    const add = (k: string, v: number | null | undefined) => {
      if (v === null || v === undefined || !Number.isFinite(v)) return;
      b.sum[k] = (b.sum[k] ?? 0) + v;
      b.n[k] = (b.n[k] ?? 0) + 1;
    };
    add('sog', r.sog);
    add('stw', extra.stw);
    add('aws', r.aws);
    add('pressure', extra.pressure);
    add('depth', r.depth);
    if (r.heading !== null && r.awa !== null) {
      const awd = r.heading + r.awa;
      b.sx += Math.sin(awd);
      b.sy += Math.cos(awd);
      b.nd += 1;
    }
  }
  const out: SeriesBucket[] = [];
  for (const [at, b] of [...buckets.entries()].sort((x, y) => x[0] - y[0])) {
    const mean = (k: string) => ((b.n[k] ?? 0) > 0 ? (b.sum[k] ?? 0) / (b.n[k] ?? 1) : null);
    let awd: number | null = null;
    if (b.nd > 0) {
      awd = Math.atan2(b.sx, b.sy);
      if (awd < 0) awd += 2 * Math.PI;
    }
    out.push({
      at,
      sog: mean('sog'),
      stw: mean('stw'),
      aws: mean('aws'),
      awd,
      pressure: mean('pressure'),
      depth: mean('depth'),
    });
  }
  return out;
}
