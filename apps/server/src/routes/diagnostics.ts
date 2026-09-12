import type { FastifyInstance } from 'fastify';
import { type AppContext } from '../context.js';
import { requireRole } from '../auth/guard.js';
import { healthView, timeView } from '../state.js';

/**
 * Diagnostics: sentence rates per type, checksum error rate, source uptime
 * and reconnects, last sample age per field, DB size, CPU/RAM. Notification
 * success rate joins in phase 7.
 */
export function diagnosticsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/diagnostics', { preHandler: requireRole('crew') }, () => {
    const now = ctx.now();
    const n = ctx.ingest.normalizer;
    const fieldAges: Record<string, number | null> = {};
    for (const [name, f] of Object.entries(n.instruments(now))) {
      fieldAges[name] = Math.round((now - f.timestamp) / 1000);
    }
    const samples = ctx.repos.samples.stats();
    return {
      stream: ctx.diagnostics.view(),
      source: ctx.ingest.view(),
      fieldAgeSeconds: fieldAges,
      samples: { count: samples.count, oldestAt: samples.oldest },
      time: timeView(n, now, ctx.state.clockSource()),
      health: healthView(ctx.state, now),
      engine: {
        phase: ctx.engine.getState().phase,
        ticks: ctx.engine.ticks,
        lastTickAt: ctx.engine.lastTickAt,
        rehydrated: ctx.engine.rehydrated,
      },
      version: ctx.version,
    };
  });
}
