import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { HealthResponse } from '@rode/protocol';
import type { Config } from './config.js';

export const SERVICE_NAME = 'server';
export const VERSION = process.env.RODE_VERSION ?? '0.0.0-dev';

export interface AppOptions {
  config: Config;
  /** Injected so tests can flip readiness without a real engine. */
  readiness?: () => Record<string, 'ok' | 'fail'>;
}

/**
 * Builds the Fastify instance without listening. Tests use `app.inject()`.
 */
export function buildApp(opts: AppOptions): FastifyInstance {
  const startedAt = Date.now();
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
        ],
        censor: '[redacted]',
      },
      ...(opts.config.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
    trustProxy: true,
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
      version: VERSION,
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
      version: VERSION,
      uptimeMs: Date.now() - startedAt,
      checks,
    };
    return reply.code(failed ? 503 : 200).send(body);
  });

  return app;
}
