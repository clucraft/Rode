import Fastify, { LogController, type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { HealthResponse } from '@rode/protocol';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { authenticate, configureGuard, setupGate } from './auth/guard.js';
import { anchorRoutes } from './routes/anchor.js';
import { authRoutes } from './routes/auth.js';
import { diagnosticsRoutes } from './routes/diagnostics.js';
import { settingsRoutes } from './routes/settings.js';
import { stateRoutes } from './routes/state.js';
import { zoneRoutes } from './routes/zones.js';
import { websocketRoutes } from './ws.js';

export const SERVICE_NAME = 'server';

/** The engine must have ticked within this long for the process to be "ready". */
const ENGINE_STALL_MS = 5000;

/**
 * Builds the bare Fastify instance with health endpoints and logging. Used
 * alone by the phase-0 smoke tests; `mountApp` adds the API on top.
 */
export function buildApp(opts: {
  config: Config;
  readiness?: () => Record<string, 'ok' | 'fail'>;
}): FastifyInstance {
  const startedAt = Date.now();
  const version = opts.config.RODE_VERSION;
  const app = Fastify({
    logger: {
      level: opts.config.RODE_LOG_LEVEL,
      // Never log credentials, tokens or cookies.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.password',
          '*.token',
          '*.secret',
          '*.signalkToken',
        ],
        censor: '[redacted]',
      },
      ...(opts.config.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
    trustProxy: true,
    bodyLimit: 256 * 1024,
    // Per-request access logs are noise on an SD card; health probes every few
    // seconds would dominate the log. Keep them off in production.
    logController: new LogController({
      disableRequestLogging: opts.config.NODE_ENV === 'production',
    }),
  });

  const readiness = opts.readiness ?? (() => ({}));

  app.get('/healthz', () => {
    const body: HealthResponse = {
      status: 'ok',
      service: SERVICE_NAME,
      version,
      uptimeMs: Date.now() - startedAt,
      checks: {},
    };
    return body;
  });

  app.get('/readyz', (_req, reply) => {
    const checks = readiness();
    const failed = Object.values(checks).some((v) => v === 'fail');
    const body: HealthResponse = {
      status: failed ? 'fail' : 'ok',
      service: SERVICE_NAME,
      version,
      uptimeMs: Date.now() - startedAt,
      checks,
    };
    return reply.code(failed ? 503 : 200).send(body);
  });

  return app;
}

/** Readiness checks wired to real services: database open, engine ticking. */
export function readinessFor(ctx: AppContext): () => Record<string, 'ok' | 'fail'> {
  return () => {
    let db: 'ok' | 'fail' = 'ok';
    try {
      ctx.db.prepare('SELECT 1').get();
    } catch {
      db = 'fail';
    }
    const last = ctx.engine.lastTickAt;
    const engine: 'ok' | 'fail' =
      last !== null && ctx.now() - last < ENGINE_STALL_MS ? 'ok' : 'fail';
    return { db, engine };
  };
}

/** Register the API, WebSocket and (in production) the static web app. */
export async function mountApp(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(fastifyCookie);
  // A generous global ceiling; login and setup carry their own tighter limits.
  await app.register(fastifyRateLimit, { global: true, max: 600, timeWindow: '1 minute' });

  configureGuard(ctx.auth);
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', setupGate);

  // Security headers on everything. HSTS only when TLS is terminated for us.
  app.addHook('onSend', (req, reply, payload, done) => {
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('Referrer-Policy', 'no-referrer');
    void reply.header('X-Frame-Options', 'DENY');
    if (ctx.config.RODE_TLS)
      void reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!req.url.startsWith('/api') && !req.url.startsWith('/ws')) {
      // Strict CSP for the app shell. MapLibre needs blob: workers and inline
      // styles for its controls; tiles come from the configured server.
      void reply.header(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: http: https:",
          "connect-src 'self' ws: wss: http: https:",
          "worker-src 'self' blob:",
          "font-src 'self'",
          "manifest-src 'self'",
          "frame-ancestors 'none'",
        ].join('; '),
      );
    }
    done(null, payload);
  });

  authRoutes(app, ctx, ctx.auth);
  anchorRoutes(app, ctx);
  stateRoutes(app, ctx);
  zoneRoutes(app, ctx);
  settingsRoutes(app, ctx);
  diagnosticsRoutes(app, ctx);
  websocketRoutes(app, ctx);

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not-found' });
    }
    return reply.code(404).send('Not found');
  });

  const webDir = ctx.config.RODE_WEB_DIR;
  if (webDir && existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
      wildcard: false,
      maxAge: '1h',
      immutable: false,
    });
    // SPA fallback: any non-API path serves the shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not-found' });
      }
      return reply.sendFile('index.html');
    });
  }
}
