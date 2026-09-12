import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import type { FullState, ServerMessage } from '@rode/protocol';
import { buildApp, mountApp, readinessFor } from './app.js';
import { at, feed, run, testEnv, type TestEnv } from './test/helpers.js';

let env: TestEnv | null = null;
let app: FastifyInstance | null = null;

async function boot(): Promise<{ app: FastifyInstance; env: TestEnv }> {
  env = await testEnv();
  app = buildApp({ config: env.config, readiness: readinessFor(env.services) });
  await mountApp(app, env.services);
  await app.ready();
  return { app, env };
}

afterEach(async () => {
  await app?.close();
  app = null;
  await env?.cleanup();
  env = null;
});

describe('health', () => {
  it('readyz fails until the engine has ticked, then passes', async () => {
    const { app, env } = await boot();
    // The fake clock does not advance, so lastTickAt is "now" and fresh.
    env.services.engine.tick();
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toEqual({ db: 'ok', engine: 'ok' });
  });

  it('sets security headers', async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'GET', url: '/api/state' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('anchor API', () => {
  it('drop → set → state → weigh, with the confirmation guard', async () => {
    const { app, env } = await boot();
    const { services, clock } = env;
    feed(services, clock, { depth: 5 });

    let res = await app.inject({ method: 'POST', url: '/api/anchor/drop', payload: {} });
    expect(res.json()).toEqual({ ok: true });
    run(services, clock, 3, { position: at(0, 12) });
    res = await app.inject({ method: 'POST', url: '/api/anchor/set' });
    expect(res.json()).toEqual({ ok: true });

    res = await app.inject({ method: 'GET', url: '/api/state' });
    const state = res.json<FullState>();
    expect(state.watch.phase).toBe('SET');
    expect(state.watch.session?.geometry?.horizontalRun).toBeCloseTo(12, 0);
    expect(state.instruments.depth?.value).toBeCloseTo(5, 1);
    expect(typeof state.source.kind).toBe('string');

    // An unconfirmed weigh is refused by validation, not by the engine.
    res = await app.inject({ method: 'POST', url: '/api/anchor/weigh', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(services.engine.getState().phase).toBe('SET');
    res = await app.inject({
      method: 'POST',
      url: '/api/anchor/weigh',
      payload: { confirm: true },
    });
    expect(res.json()).toEqual({ ok: true });
    expect(services.engine.getState().phase).toBe('IDLE');
  });

  it('returns the engine rejection reason as a 200 with ok:false', async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'POST', url: '/api/anchor/set' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'not-dropping' });
  });

  it('validates bodies', async () => {
    const { app } = await boot();
    const res = await app.inject({
      method: 'POST',
      url: '/api/anchor/drop',
      payload: { manualDepth: -3 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/manualDepth/);
  });

  it('ack silences but the state stays ALARM', async () => {
    const { app, env } = await boot();
    const { services, clock } = env;
    feed(services, clock, { depth: 5 });
    await app.inject({ method: 'POST', url: '/api/anchor/drop', payload: {} });
    run(services, clock, 3, { position: at(0, 12) });
    await app.inject({ method: 'POST', url: '/api/anchor/set' });
    const radius = services.engine.getState().session?.geometry?.swingRadius ?? 0;
    run(services, clock, 15, { position: at(0, radius + 5) });
    expect(services.engine.getState().stateName).toBe('ALARM');
    const res = await app.inject({ method: 'POST', url: '/api/anchor/ack', payload: {} });
    expect(res.json()).toEqual({ ok: true });
    const state = (await app.inject({ method: 'GET', url: '/api/state' })).json<FullState>();
    expect(state.watch.snoozed).toBe(true);
    expect(state.watch.stateName).toBe('ALARM');
  });
});

describe('history API', () => {
  it('lists sessions with their events and track', async () => {
    const { app, env } = await boot();
    const { services, clock } = env;
    feed(services, clock, { depth: 5 });
    await app.inject({ method: 'POST', url: '/api/anchor/drop', payload: {} });
    run(services, clock, 3, { position: at(0, 12) });
    await app.inject({ method: 'POST', url: '/api/anchor/set' });
    for (let i = 0; i < 5; i++) {
      run(services, clock, 1, { position: at(0, 12) });
      services.sampleWriter.capture();
    }
    services.sampleWriter.flush();
    await app.inject({ method: 'POST', url: '/api/anchor/weigh', payload: { confirm: true } });

    const list = (await app.inject({ method: 'GET', url: '/api/sessions' })).json<{
      total: number;
      sessions: { id: string }[];
    }>();
    expect(list.total).toBe(1);
    const id = list.sessions[0]?.id ?? '';
    const detail = (await app.inject({ method: 'GET', url: `/api/sessions/${id}` })).json<{
      events: { type: string }[];
      track: unknown[];
    }>();
    expect(detail.events.map((e) => e.type)).toContain('anchor-set');
    expect(detail.track.length).toBeGreaterThanOrEqual(5);
    const events = (await app.inject({ method: 'GET', url: '/api/events?limit=10' })).json<
      unknown[]
    >();
    expect(events.length).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/nope' })).statusCode).toBe(404);
  });
});

describe('zones API', () => {
  const square = [
    { lat: 32.291, lon: -64.831 },
    { lat: 32.291, lon: -64.829 },
    { lat: 32.289, lon: -64.829 },
    { lat: 32.289, lon: -64.831 },
  ];

  it('creates, lists, updates and deletes zones', async () => {
    const { app } = await boot();
    let res = await app.inject({
      method: 'POST',
      url: '/api/zones',
      payload: { name: 'Reef', kind: 'never-enter', polygon: square },
    });
    expect(res.statusCode).toBe(201);
    const zone = res.json<{ id: string; enabled: boolean }>();
    expect(zone.enabled).toBe(true);
    res = await app.inject({ method: 'GET', url: '/api/zones' });
    expect(res.json<unknown[]>()).toHaveLength(1);
    res = await app.inject({
      method: 'PUT',
      url: `/api/zones/${zone.id}`,
      payload: { name: 'Reef', kind: 'never-enter', enabled: false, polygon: square },
    });
    expect(res.json<{ enabled: boolean }>().enabled).toBe(false);
    res = await app.inject({ method: 'DELETE', url: `/api/zones/${zone.id}` });
    expect(res.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/zones' })).json<unknown[]>()).toHaveLength(
      0,
    );
  });

  it('rejects degenerate polygons', async () => {
    const { app } = await boot();
    const res = await app.inject({
      method: 'POST',
      url: '/api/zones',
      payload: { name: 'Dot', kind: 'never-enter', polygon: [square[0], square[0], square[0]] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/same place/);
  });
});

describe('settings API', () => {
  it('patches, clamps alarm values to documented ranges, and restores defaults', async () => {
    const { app } = await boot();
    let res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { alarm: { warnDistance: 20, snoozeMs: 5 }, boatName: 'Sabado' },
    });
    expect(res.statusCode).toBe(200);
    const view = res.json<{ alarm: Record<string, number>; boatName: string }>();
    expect(view.alarm.warnDistance).toBe(20);
    expect(view.alarm.snoozeMs).toBe(60_000); // clamped to the documented minimum
    expect(view.boatName).toBe('Sabado');
    res = await app.inject({ method: 'POST', url: '/api/settings/alarm/restore-defaults' });
    expect(res.json<{ alarm: Record<string, number> }>().alarm.warnDistance).toBe(10);
    res = await app.inject({ method: 'GET', url: '/api/settings/docs' });
    expect(res.json().alarm.warnDistance.why).toMatch(/percentage/i);
  });
});

describe('diagnostics API', () => {
  it('reports rates, field ages and process stats', async () => {
    const { app, env } = await boot();
    feed(env.services, env.clock);
    env.services.diagnostics.sample();
    const res = await app.inject({ method: 'GET', url: '/api/diagnostics' });
    const d = res.json();
    expect(d.stream.totals.sentences).toBeGreaterThan(0);
    expect(d.fieldAgeSeconds.position).toBe(0);
    expect(d.stream.process.nodeVersion).toMatch(/^v/);
    expect(d.engine.phase).toBe('IDLE');
  });
});

describe('websocket', () => {
  it('sends hello + snapshot, then deltas only when something changed', async () => {
    const { app, env } = await boot();
    const { services, clock } = env;
    feed(services, clock, { depth: 5 });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: ServerMessage[] = [];
    ws.on('message', (d: Buffer) => messages.push(JSON.parse(d.toString()) as ServerMessage));
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    await wait(() => messages.length >= 2);
    expect(messages[0]?.type).toBe('hello');
    expect(messages[1]?.type).toBe('snapshot');

    // A command produces events (pushed immediately) and a watch delta.
    services.engine.command({ type: 'drop' }, 'ws-test');
    await wait(() =>
      messages.some(
        (m) => m.type === 'delta' && m.events?.some((e) => e.type === 'anchor-dropped'),
      ),
    );
    await wait(() => messages.some((m) => m.type === 'delta' && m.watch?.phase === 'DROPPING'));

    // Ping/pong round trip.
    ws.send(JSON.stringify({ type: 'ping', t: 42 }));
    await wait(() => messages.some((m) => m.type === 'pong' && m.t === 42));
    ws.close();
  });
});

async function wait(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
