import { afterEach, describe, expect, it } from 'vitest';
import { at, feed, run, testEnv, type TestEnv } from '../test/helpers.js';

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.cleanup();
  env = null;
});

describe('EngineHost', () => {
  it('runs the watch with no HTTP layer at all: sentences in, ALARM out, events on disk', async () => {
    env = await testEnv();
    const { services, clock } = env;
    // No Fastify app is mounted anywhere in this test. Just services.
    feed(services, clock, { depth: 5 });
    const drop = services.engine.command({ type: 'drop' }, 'test');
    expect(drop.ok).toBe(true);
    run(services, clock, 5, { position: at(0, 15) });
    const set = services.engine.command({ type: 'set' }, 'test');
    expect(set.ok).toBe(true);
    const g = services.engine.getState().session?.geometry;
    expect(g?.horizontalRun).toBeCloseTo(15, 0);

    run(services, clock, 20, { position: at(0, (g?.swingRadius ?? 0) + 5) });
    expect(services.engine.getState().stateName).toBe('ALARM');

    const types = services.repos.events.recent(100).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'session-started',
        'anchor-dropped',
        'anchor-set',
        'condition-raised',
        'state-changed',
      ]),
    );
    const sessions = services.repos.sessions.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.alarmCount).toBeGreaterThanOrEqual(1);
    expect(services.engine.ticks).toBeGreaterThan(20);
  });

  it('persists every event with the state that produced it, in one transaction', async () => {
    env = await testEnv();
    const { services, clock } = env;
    feed(services, clock);
    services.engine.command({ type: 'drop' }, 'skipper');
    const persisted = services.repos.engineState.load();
    expect(persisted?.state.phase).toBe('DROPPING');
    const ev = services.repos.events.recent(10).find((e) => e.type === 'anchor-dropped');
    expect(ev).toBeDefined();
    expect((ev?.data as { by?: string }).by).toBe('skipper');
  });

  it('rejects bad commands with a reason and logs the rejection', async () => {
    env = await testEnv();
    const { services } = env;
    const r = services.engine.command({ type: 'set' }, 'test');
    expect(r).toMatchObject({ ok: false, reason: 'not-dropping' });
    expect(services.repos.events.recent(5).some((e) => e.type === 'command-rejected')).toBe(true);
  });

  it('survives a hard power cut: rehydrates the session with identical geometry and flags the restart', async () => {
    env = await testEnv();
    const { clock } = env;
    let services = env.services;
    feed(services, clock, { depth: 6 });
    services.engine.command({ type: 'drop' }, 'test');
    run(services, clock, 5, { position: at(90, 15) });
    services.engine.command({ type: 'set' }, 'test');
    run(services, clock, 30, { position: at(90, 15) });
    const before = services.engine.getState();
    expect(before.phase).toBe('SET');
    expect(services.state.unexpectedRestart).toBe(false);

    // Power cut: 40 s of darkness, then boot on the same database.
    clock.advance(40_000);
    services = await env.reboot();
    expect(services.state.unexpectedRestart).toBe(true);
    expect(services.engine.rehydrated).toBe(true);
    const after = services.engine.getState();
    expect(after.phase).toBe('SET');
    expect(after.session?.id).toBe(before.session?.id);
    expect(after.session?.geometry).toEqual(before.session?.geometry);
    expect(after.observingSince).toBe(clock.now());

    // Position comes straight back: no staleness alarm; the watch is live.
    run(services, clock, 10, { position: at(90, 15) });
    expect(Object.keys(services.engine.getState().conditions)).toEqual([]);
    run(services, clock, 20, { position: at(90, (after.session?.geometry?.swingRadius ?? 0) + 5) });
    expect(services.engine.getState().stateName).toBe('ALARM');
    const boots = services.repos.events.recent(200).filter((e) => e.type === 'boot');
    expect(boots).toHaveLength(2);
    expect((boots[1]?.data as { unexpectedRestart?: boolean }).unexpectedRestart).toBe(true);
  });

  it('a clean shutdown does not flag the next boot', async () => {
    env = await testEnv();
    const services = await env.reboot({ clean: true });
    expect(services.state.unexpectedRestart).toBe(false);
  });

  it('raises the GPS staleness alarm if no fix arrives after boot', async () => {
    env = await testEnv();
    const { clock } = env;
    let services = env.services;
    feed(services, clock, { depth: 6 });
    services.engine.command({ type: 'drop' }, 'test');
    run(services, clock, 3, { position: at(0, 10) });
    services.engine.command({ type: 'set' }, 'test');
    services = await env.reboot();
    // Nothing fed after reboot: the receiver is dark.
    for (let i = 0; i < 65; i++) {
      clock.advance(1000);
      services.engine.tick();
    }
    const c = services.engine.getState().conditions['gps-stale'];
    expect(c?.severity).toBe('critical');
    expect(services.engine.getState().stateName).toBe('ALARM');
  });
});
