import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { validateZonePolygon } from '@rode/core';
import { ZoneInput } from '@rode/protocol';
import { actorName, parseBody, type AppContext } from '../context.js';
import { requireRole } from '../auth/guard.js';

/** Exclusion zones persist across sessions; admin edits, crew reads. */
export function zoneRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/zones', { preHandler: requireRole('crew') }, () => ctx.repos.zones.all());

  app.post('/api/zones', { preHandler: requireRole('admin') }, (req, reply) => {
    const body = parseBody(ZoneInput, req, reply);
    if (!body) return;
    const problem = validateZonePolygon(body.polygon);
    if (problem) return reply.code(400).send({ error: 'invalid-zone', message: problem });
    const zone = ctx.repos.zones.insert({ id: randomUUID(), ...body });
    ctx.repos.events.append('zone-created', {
      zoneId: zone.id,
      name: zone.name,
      kind: zone.kind,
      by: actorName(req),
    });
    return reply.code(201).send(zone);
  });

  app.put('/api/zones/:id', { preHandler: requireRole('admin') }, (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(ZoneInput, req, reply);
    if (!body) return;
    const problem = validateZonePolygon(body.polygon);
    if (problem) return reply.code(400).send({ error: 'invalid-zone', message: problem });
    if (!ctx.repos.zones.update({ id, ...body }))
      return reply.code(404).send({ error: 'not-found' });
    ctx.repos.events.append('zone-updated', {
      zoneId: id,
      name: body.name,
      enabled: body.enabled,
      by: actorName(req),
    });
    return ctx.repos.zones.get(id);
  });

  app.delete('/api/zones/:id', { preHandler: requireRole('admin') }, (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ctx.repos.zones.delete(id)) return reply.code(404).send({ error: 'not-found' });
    ctx.repos.events.append('zone-deleted', { zoneId: id, by: actorName(req) });
    return reply.code(204).send();
  });
}
