import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HistoryQuery } from '@rode/protocol';
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
