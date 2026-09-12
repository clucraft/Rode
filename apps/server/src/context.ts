import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { Bus } from './bus.js';
import type { Config } from './config.js';
import type { Db } from './db/database.js';
import type { Repos } from './db/repos.js';
import type { EngineHost } from './engine/host.js';
import type { IngestManager } from './ingest/manager.js';
import type { Diagnostics } from './diagnostics.js';
import type { AuthService } from './auth/service.js';
import type { Dispatcher } from './notify/dispatcher.js';
import type { Heartbeat } from './notify/heartbeat.js';
import type { Recipient } from '@rode/protocol';
import type { SettingsService } from './settings.js';
import type { StateDeps } from './state.js';

/** Everything a route handler may need. Built once in index.ts. */
export interface AppContext {
  config: Config;
  db: Db;
  repos: Repos;
  bus: Bus;
  settings: SettingsService;
  engine: EngineHost;
  ingest: IngestManager;
  diagnostics: Diagnostics;
  auth: AuthService;
  notify: { dispatcher: Dispatcher; heartbeat: Heartbeat; envRecipient: Recipient | null };
  state: StateDeps;
  version: string;
  bootedAt: number;
  /** The process clock. Injected so tests can drive time; never call Date.now() in a route. */
  now: () => number;
}

/** Who performed a request, for the event log. Filled by the auth layer. */
export interface Actor {
  id: string;
  name: string;
  role: 'admin' | 'crew' | 'token';
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}

/**
 * Validate a body with zod and reply 400 on failure. Returns undefined when
 * the reply has been sent so handlers can `if (!body) return`.
 */
export function parseBody<T>(
  schema: ZodType<T>,
  req: FastifyRequest,
  reply: FastifyReply,
): T | undefined {
  const r = schema.safeParse(req.body ?? {});
  if (r.success) return r.data;
  void reply.code(400).send({
    error: 'invalid-request',
    message: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
  });
  return undefined;
}

export function parseQuery<T>(
  schema: ZodType<T>,
  req: FastifyRequest,
  reply: FastifyReply,
): T | undefined {
  const r = schema.safeParse(req.query ?? {});
  if (r.success) return r.data;
  void reply.code(400).send({
    error: 'invalid-query',
    message: r.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; '),
  });
  return undefined;
}

export function actorName(req: FastifyRequest): string {
  return req.actor?.name ?? 'anonymous';
}
