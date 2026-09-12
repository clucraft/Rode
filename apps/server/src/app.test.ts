import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig({ NODE_ENV: 'test', RODE_LOG_LEVEL: 'fatal' });
let app: ReturnType<typeof buildApp> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('health endpoints', () => {
  it('GET /healthz returns ok', async () => {
    app = buildApp({ config });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'server' });
  });

  it('GET /readyz is 200 when all checks pass', async () => {
    app = buildApp({ config, readiness: () => ({ db: 'ok', engine: 'ok' }) });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toEqual({ db: 'ok', engine: 'ok' });
  });

  it('GET /readyz is 503 when any check fails', async () => {
    app = buildApp({ config, readiness: () => ({ db: 'ok', engine: 'fail' }) });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('fail');
  });
});
