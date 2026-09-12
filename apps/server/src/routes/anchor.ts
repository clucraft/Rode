import type { FastifyInstance } from 'fastify';
import type { Command } from '@rode/core';
import {
  AckRequest,
  DropRequest,
  NudgeRequest,
  SetDepthRequest,
  SetRadiusRequest,
  SetTideRequest,
  WeighRequest,
  type CommandResponse,
} from '@rode/protocol';
import { actorName, parseBody, type AppContext } from '../context.js';
import { requireRole } from '../auth/guard.js';

/**
 * Skipper commands. Every one goes through the engine host, which persists
 * state and events before answering. Crew may drop/set/weigh/ack; nothing
 * here changes configuration.
 */
export function anchorRoutes(app: FastifyInstance, ctx: AppContext): void {
  const run = (cmd: Command, by: string): CommandResponse => {
    const r = ctx.engine.command(cmd, by);
    return r.ok
      ? { ok: true }
      : { ok: false, reason: r.reason ?? 'rejected', message: r.message ?? 'Rejected.' };
  };

  app.post('/api/anchor/drop', { preHandler: requireRole('crew') }, (req, reply) => {
    const body = parseBody(DropRequest, req, reply);
    if (!body) return;
    const cmd: Command =
      body.manualDepth === undefined
        ? { type: 'drop' }
        : { type: 'drop', manualDepth: body.manualDepth };
    return run(cmd, actorName(req));
  });

  app.post('/api/anchor/depth', { preHandler: requireRole('crew') }, (req, reply) => {
    const body = parseBody(SetDepthRequest, req, reply);
    if (!body) return;
    return run({ type: 'set-depth', depth: body.depth }, actorName(req));
  });

  app.post('/api/anchor/set', { preHandler: requireRole('crew') }, (req) => {
    return run({ type: 'set' }, actorName(req));
  });

  app.post('/api/anchor/nudge', { preHandler: requireRole('crew') }, (req, reply) => {
    const body = parseBody(NudgeRequest, req, reply);
    if (!body) return;
    return run({ type: 'nudge', anchor: body.anchor }, actorName(req));
  });

  app.post('/api/anchor/tide', { preHandler: requireRole('crew') }, (req, reply) => {
    const body = parseBody(SetTideRequest, req, reply);
    if (!body) return;
    return run({ type: 'set-tide', tideRange: body.tideRange }, actorName(req));
  });

  app.post('/api/anchor/radius', { preHandler: requireRole('crew') }, (req, reply) => {
    const body = parseBody(SetRadiusRequest, req, reply);
    if (!body) return;
    const by = actorName(req);
    const cmd: Extract<Command, { type: 'set-radius' }> = {
      type: 'set-radius',
      mode: body.mode,
      by,
    };
    if (body.swingRadius !== undefined) cmd.swingRadius = body.swingRadius;
    if (body.warnRadius !== undefined) cmd.warnRadius = body.warnRadius;
    return run(cmd, by);
  });

  app.delete('/api/anchor/radius', { preHandler: requireRole('crew') }, (req) => {
    return run({ type: 'clear-radius', by: actorName(req) }, actorName(req));
  });

  // Weigh anchor requires the UI's confirmation: one accidental tap must not
  // wipe a session. The schema only accepts `confirm: true`.
  app.post('/api/anchor/weigh', { preHandler: requireRole('crew') }, (req, reply) => {
    const body = parseBody(WeighRequest, req, reply);
    if (!body) return;
    return run({ type: 'weigh', by: actorName(req) }, actorName(req));
  });

  app.post('/api/anchor/ack', { preHandler: requireRole('crew') }, (req, reply) => {
    const body = parseBody(AckRequest, req, reply);
    if (!body) return;
    return run({ type: 'ack', by: actorName(req) }, actorName(req));
  });

  app.post('/api/anchor/marina', { preHandler: requireRole('crew') }, (req) => {
    return run({ type: 'marina' }, actorName(req));
  });
}
