import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  IMAGERY_PRESETS,
  ImagerySourceInput,
  MAX_IMAGERY_SOURCES,
  PrefetchRequest,
  ViewPrefsPatch,
} from '@rode/protocol';
import { requireRole } from '../auth/guard.js';
import { actorName, parseBody, type AppContext } from '../context.js';

/*
 * Shared view preferences and the imagery sources behind the polar view.
 * Preferences are crew-level (anyone watching may move the track slider);
 * the source list is admin-level because it names files and URLs on the box.
 */

const SourceList = z
  .array(ImagerySourceInput.extend({ id: z.string().optional() }))
  .max(MAX_IMAGERY_SOURCES);

const TileParams = z.object({
  id: z.string().max(40),
  z: z.coerce.number().int().min(0).max(22),
  x: z.coerce.number().int().min(0),
  y: z.coerce.number().int().min(0),
});

export function imageryRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---------------------------------------------------------------- prefs

  app.get('/api/prefs', { preHandler: requireRole('crew') }, () => ctx.settings.prefs());

  app.patch('/api/prefs', { preHandler: requireRole('crew') }, (req, reply) => {
    const body = parseBody(ViewPrefsPatch, req, reply);
    if (!body) return;
    return ctx.settings.patchPrefs(body, ctx.now());
  });

  // ---------------------------------------------------------------- sources

  app.get('/api/imagery', { preHandler: requireRole('crew') }, () => ({
    sources: ctx.settings.imagery(),
    max: MAX_IMAGERY_SOURCES,
    presets: IMAGERY_PRESETS,
  }));

  app.put('/api/imagery', { preHandler: requireRole('admin') }, (req, reply) => {
    const body = parseBody(SourceList, req, reply);
    if (!body) return;
    for (const s of body) {
      if (s.kind === 'mbtiles') {
        if (!s.path || ctx.imagery.resolveMbtiles(s.path) === null) {
          void reply.code(400).send({
            error: 'invalid-request',
            message: `${s.name}: path must be a file inside the MBTiles directory.`,
          });
          return;
        }
      } else if (!s.urlTemplate || !/^https?:\/\//i.test(s.urlTemplate)) {
        void reply.code(400).send({
          error: 'invalid-request',
          message: `${s.name}: URL template must start with http(s)://.`,
        });
        return;
      }
      if (s.minZoom > s.maxZoom) {
        void reply
          .code(400)
          .send({ error: 'invalid-request', message: `${s.name}: min zoom is above max zoom.` });
        return;
      }
    }
    const sources = ctx.settings.setImagery(body, () => randomUUID().slice(0, 8), ctx.now());
    ctx.imagery.reconcile();
    ctx.repos.events.append(
      'imagery-updated',
      { by: actorName(req), count: sources.length },
      'info',
      ctx.now(),
    );
    return { sources, max: MAX_IMAGERY_SOURCES, presets: IMAGERY_PRESETS };
  });

  app.get('/api/imagery/files', { preHandler: requireRole('admin') }, async () => ({
    dir: ctx.config.RODE_MBTILES_DIR,
    files: await ctx.imagery.listFiles(),
  }));

  app.get<{ Params: { id: string } }>(
    '/api/imagery/:id/status',
    { preHandler: requireRole('crew') },
    async (req, reply) => {
      const s = await ctx.imagery.status(req.params.id);
      if (!s) return reply.code(404).send({ error: 'not-found', message: 'No such source.' });
      return s;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/imagery/:id/prefetch',
    { preHandler: requireRole('admin') },
    (req, reply) => {
      const body = parseBody(PrefetchRequest, req, reply);
      if (!body) return;
      const centre =
        body.centre ??
        ctx.engine.getState().live.boat ??
        ctx.ingest.normalizer.getField('position')?.value ??
        null;
      if (!centre) {
        void reply
          .code(409)
          .send({ error: 'no-position', message: 'No boat position yet; pass a centre.' });
        return;
      }
      const planned = ctx.imagery.prefetch(req.params.id, centre, body);
      if (planned === null) {
        void reply
          .code(400)
          .send({ error: 'not-online', message: 'Only online sources can be prefetched.' });
        return;
      }
      return { planned, centre };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/imagery/:id/prefetch',
    { preHandler: requireRole('admin') },
    (req) => {
      ctx.imagery.cancelPrefetch(req.params.id);
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------- tiles

  app.get<{ Params: { id: string; z: string; x: string; y: string } }>(
    '/api/tiles/:id/:z/:x/:y',
    { preHandler: requireRole('crew') },
    async (req, reply) => {
      const p = TileParams.safeParse(req.params);
      if (!p.success)
        return reply.code(400).send({ error: 'invalid-request', message: 'Bad tile.' });
      const tile = await ctx.imagery.tile(p.data.id, { z: p.data.z, x: p.data.x, y: p.data.y });
      if (!tile) return reply.code(404).send({ error: 'not-found', message: 'No tile.' });
      return reply
        .header('content-type', tile.contentType)
        .header('cache-control', 'private, max-age=86400')
        .send(tile.data);
    },
  );
}
