import { afterEach, describe, expect, it } from 'vitest';
import type { NotificationSettings } from '@rode/protocol';
import { at, feed, run, testEnv, type TestEnv } from '../test/helpers.js';
import { Dispatcher, MASK } from './dispatcher.js';
import { Supervisor } from '../supervisor.js';

/*
 * Notification delivery with a fake fetch: routing by severity, retries,
 * the set/weigh confirmation, masking, the heartbeat schedule, and the
 * supervisor's stall detection.
 */

let env: TestEnv | null = null;
const dispatchers: Dispatcher[] = [];
afterEach(async () => {
  // Stop every dispatcher before the database closes: an in-flight delivery
  // must not try to log into a closed connection.
  for (const d of dispatchers.splice(0)) await d.stop();
  await env?.cleanup();
  env = null;
});

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(
  behaviour: (url: string, init: RequestInit) => { status: number; body?: string } = () => ({
    status: 200,
  }),
) {
  const calls: Call[] = [];
  const fn: typeof fetch = (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    const r = behaviour(url, init ?? {});
    return Promise.resolve(
      new Response(r.body ?? '{}', {
        status: r.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  return { fn, calls };
}

const SETTINGS: NotificationSettings = {
  recipients: [
    {
      id: 'owner',
      name: 'Owner',
      enabled: true,
      channels: [
        {
          kind: 'ntfy',
          enabled: true,
          severities: ['info', 'warning', 'critical'],
          url: 'https://ntfy.example/rode',
          token: 'tk_secret',
        },
        {
          kind: 'pushover',
          enabled: true,
          severities: ['critical'],
          token: 'po-app',
          user: 'po-user',
        },
        {
          kind: 'telegram',
          enabled: true,
          severities: ['warning', 'critical'],
          botToken: '123:abc',
          chatId: '42',
        },
      ],
    },
    {
      id: 'crew',
      name: 'Crew phone',
      enabled: true,
      channels: [
        {
          kind: 'webhook',
          enabled: true,
          severities: ['info', 'warning', 'critical'],
          url: 'https://hooks.example/rode',
          headers: { Authorization: 'Bearer hook' },
        },
      ],
    },
  ],
  heartbeat: { enabled: true, localTime: '08:00' },
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
  collapseWarningsMs: 60_000,
};

function dispatcherFor(
  env: TestEnv,
  fetchFn: typeof fetch,
  schedule?: (fn: () => void, ms: number) => () => void,
) {
  const { services, clock } = env;
  const d = new Dispatcher({
    settingsRepo: services.repos.settings,
    events: services.repos.events,
    bus: services.bus,
    log: silentLog(),
    units: () => ({ distance: 'm', temperature: 'C' }),
    boatName: () => 'Sabado',
    fetch: fetchFn,
    now: clock.now,
    schedule: schedule ?? (() => () => undefined),
  });
  d.updateSettings(SETTINGS);
  dispatchers.push(d);
  return d;
}

function silentLog() {
  const noop = () => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => silentLog(),
    level: 'silent',
    silent: noop,
  } as never;
}

const flush = () => new Promise((r) => setTimeout(r, 20));
const bodyText = (c: Call | undefined): string =>
  typeof c?.init.body === 'string' ? c.init.body : '';

describe('Dispatcher', () => {
  it('routes by severity across recipients and channels, with platform priorities', async () => {
    env = await testEnv();
    const f = fakeFetch();
    const d = dispatcherFor(env, f.fn);
    expect(
      d.notify({
        at: env.clock.now(),
        severity: 'critical',
        title: 'Sabado: ALARM',
        body: 'outside',
      }),
    ).toBe(4);
    await flush();
    const urls = f.calls.map((c) => c.url).sort();
    expect(urls).toEqual([
      'https://api.pushover.net/1/messages.json',
      'https://api.telegram.org/bot123:abc/sendMessage',
      'https://hooks.example/rode',
      'https://ntfy.example/rode',
    ]);
    const ntfy = f.calls.find((c) => c.url.startsWith('https://ntfy'));
    expect((ntfy?.init.headers as Record<string, string>).Priority).toBe('5');
    expect((ntfy?.init.headers as Record<string, string>).Authorization).toBe('Bearer tk_secret');
    const po = f.calls.find((c) => c.url.startsWith('https://api.pushover'));
    const form = po?.init.body as URLSearchParams;
    expect(form.get('priority')).toBe('2');
    expect(form.get('retry')).toBe('60');
    const hook = f.calls.find((c) => c.url.startsWith('https://hooks'));
    expect((hook?.init.headers as Record<string, string>).Authorization).toBe('Bearer hook');
    expect(JSON.parse(bodyText(hook))).toMatchObject({
      source: 'rode',
      severity: 'critical',
      title: 'Sabado: ALARM',
    });

    // Info goes only where info is enabled.
    f.calls.length = 0;
    expect(d.notify({ at: env.clock.now(), severity: 'info', title: 'hello', body: '' })).toBe(2);
    await flush();
    expect(f.calls.map((c) => c.url).sort()).toEqual([
      'https://hooks.example/rode',
      'https://ntfy.example/rode',
    ]);
    const stats = d.getStats();
    expect(stats.lastConfirmedAt).toBe(env.clock.now());
    expect(stats.sent24h).toBe(6);
    expect(
      env.services.repos.events.recent(20).filter((e) => e.type === 'notification-sent'),
    ).toHaveLength(6);
  });

  it('retries failures with backoff and gives up after three attempts, logging each', async () => {
    env = await testEnv();
    let fails = 0;
    const f = fakeFetch((url) =>
      url.startsWith('https://ntfy') ? (fails++, { status: 500 }) : { status: 200 },
    );
    const scheduled: { fn: () => void; ms: number }[] = [];
    const d = dispatcherFor(env, f.fn, (fn, ms) => {
      scheduled.push({ fn, ms });
      return () => undefined;
    });
    d.notify({ at: env.clock.now(), severity: 'info', title: 't', body: 'b' });
    await flush();
    expect(fails).toBe(1);
    expect(scheduled.at(-1)?.ms).toBe(5000);
    for (const delay of [5000, 20_000, 60_000]) {
      env.clock.advance(delay);
      scheduled.at(-1)?.fn();
      await flush();
    }
    // One attempt plus three retries.
    expect(fails).toBe(4);
    const failed = env.services.repos.events
      .recent(50)
      .filter((e) => e.type === 'notification-failed');
    expect(failed).toHaveLength(4);
    expect(d.getStats().targets['owner:ntfy']?.failed).toBe(4);
    expect(d.getStats().targets['crew:webhook']?.sent).toBe(1);
    expect(d.getStats().lastConfirmedAt).not.toBeNull();
  });

  it('collapses identical warnings inside the window but never criticals', async () => {
    env = await testEnv();
    const f = fakeFetch();
    const d = dispatcherFor(env, f.fn);
    d.notify({ at: env.clock.now(), severity: 'warning', title: 'w', body: 'same' });
    expect(d.notify({ at: env.clock.now(), severity: 'warning', title: 'w', body: 'same' })).toBe(
      0,
    );
    env.clock.advance(61_000);
    expect(
      d.notify({ at: env.clock.now(), severity: 'warning', title: 'w', body: 'same' }),
    ).toBeGreaterThan(0);
    d.notify({ at: env.clock.now(), severity: 'critical', title: 'c', body: 'same' });
    expect(
      d.notify({ at: env.clock.now(), severity: 'critical', title: 'c', body: 'same' }),
    ).toBeGreaterThan(0);
  });

  it('masking round trip', async () => {
    env = await testEnv();
    const d = dispatcherFor(env, fakeFetch().fn);
    const masked = d.maskedSettings();
    const ntfy = masked.recipients[0]?.channels[0];
    expect(ntfy?.kind === 'ntfy' && ntfy.token).toBe(MASK);
    const hook = masked.recipients[1]?.channels[0];
    expect(hook?.kind === 'webhook' && hook.headers.Authorization).toBe(MASK);
    // Write the masked settings back with one real change.
    masked.recipients[0]!.name = 'Owner (renamed)';
    const stored = d.updateSettings(masked);
    const t = stored.recipients[0]?.channels[0];
    expect(t?.kind === 'ntfy' && t.token).toBe('tk_secret');
    const h = stored.recipients[1]?.channels[0];
    expect(h?.kind === 'webhook' && h.headers.Authorization).toBe('Bearer hook');
    expect(stored.recipients[0]?.name).toBe('Owner (renamed)');
  });

  it('sends the set and weigh confirmations: every anchor set is a live test of the path', async () => {
    env = await testEnv();
    const { services, clock } = env;
    const f = fakeFetch();
    const d = dispatcherFor(env, f.fn);
    d.start();
    feed(services, clock, { depth: 5 });
    services.engine.command({ type: 'drop' }, 'skipper');
    run(services, clock, 3, { position: at(0, 20) });
    services.engine.command({ type: 'set' }, 'skipper');
    await flush();
    const ntfy = f.calls.filter((c) => c.url.startsWith('https://ntfy'));
    expect(ntfy).toHaveLength(1);
    expect((ntfy[0]?.init.headers as Record<string, string>).Title).toBe(
      'Sabado: anchor watch active',
    );
    expect(bodyText(ntfy[0])).toMatch(/Radius \d+ m, rode \d+ m, scope \d+\.\d:1, depth 5 m\./);

    // Drag out → warning (telegram + ntfy + webhook), then alarm (all four).
    const radius = services.engine.getState().session?.geometry?.swingRadius ?? 0;
    run(services, clock, 15, { position: at(0, radius - 5) });
    await flush();
    run(services, clock, 10, { position: at(0, radius + 5) });
    await flush();
    const titles = f.calls
      .map((c) => (c.init.headers as Record<string, string> | undefined)?.Title)
      .filter(Boolean);
    expect(titles).toEqual(
      expect.arrayContaining(['Sabado: near the edge of the swing circle', 'Sabado: ALARM']),
    );
    const po = f.calls.filter((c) => c.url.startsWith('https://api.pushover'));
    expect(po.length).toBeGreaterThanOrEqual(1);

    services.engine.command({ type: 'weigh', by: 'skipper' }, 'skipper');
    await flush();
    const weigh = f.calls.find(
      (c) =>
        (c.init.headers as Record<string, string> | undefined)?.Title === 'Sabado: anchor weighed',
    );
    expect(weigh).toBeDefined();
    await d.stop();
  });

  it('the test endpoint reports per-target results', async () => {
    env = await testEnv();
    const f = fakeFetch((url) => ({
      status: url.includes('telegram') ? 401 : 200,
      body: url.includes('telegram') ? '{"description":"Unauthorized"}' : '{}',
    }));
    const d = dispatcherFor(env, f.fn);
    const results = await d.test('owner');
    expect(results.map((r) => [r.channel, r.ok])).toEqual([
      ['ntfy', true],
      ['pushover', true],
      ['telegram', false],
    ]);
    expect(results[2]?.error).toBe('Unauthorized');
  });
});

describe('Heartbeat', () => {
  it('sends once per local day after the configured time, and not before', async () => {
    env = await testEnv();
    const { services, clock } = env;
    services.notify.dispatcher.updateSettings({
      ...SETTINGS,
      heartbeat: { enabled: true, localTime: '08:00' },
    });
    // Swap in the fake fetch via a new dispatcher instance is awkward; instead
    // observe the queue count through the bus/events: notify() logs a queued
    // event only after delivery, so count recipients returned by notify.
    // Count sends without touching the network.
    let queued = 0;
    services.notify.dispatcher.notify = () => {
      queued++;
      return 1;
    };
    // Clock: 2026-09-11 03:00 UTC; time zone UTC by default → before 08:00.
    expect(services.notify.heartbeat.maybeSend()).toBe(false);
    clock.advance(5 * 3_600_000 + 60_000); // 08:01
    expect(services.notify.heartbeat.maybeSend()).toBe(true);
    expect(queued).toBe(1);
    expect(services.notify.heartbeat.maybeSend()).toBe(false); // same day
    clock.advance(24 * 3_600_000);
    expect(services.notify.heartbeat.maybeSend()).toBe(true);
    expect(queued).toBe(2);
    expect(services.repos.runtime.get('last_heartbeat_day')).toBe('2026-09-12');
  });

  it('composes a status snapshot with the fields the owner needs', async () => {
    env = await testEnv();
    const { services, clock } = env;
    feed(services, clock, { depth: 5 });
    let captured: { title: string; body: string } | null = null;
    services.notify.dispatcher.notify = (n) => {
      captured = { title: n.title, body: n.body };
      return 0;
    };
    services.notify.heartbeat.send();
    expect(captured).not.toBeNull();
    const body = (captured as unknown as { body: string }).body;
    expect(body).toMatch(/Watch: IDLE/);
    expect(body).toMatch(/Position: 32\.29000, -64\.83000/);
    expect(body).toMatch(/GPS: ok/);
    expect(body).toMatch(/Uptime:/);
  });
});

describe('Supervisor', () => {
  it('detects a stalled engine, notifies, restarts the loop, and reports recovery', async () => {
    env = await testEnv();
    const { services, clock } = env;
    const notified: string[] = [];
    services.notify.dispatcher.notify = (n) => {
      notified.push(n.title);
      return 0;
    };
    const sup = new Supervisor({
      engine: services.engine,
      events: services.repos.events,
      dispatcher: services.notify.dispatcher,
      log: silentLog(),
      boatName: () => 'Sabado',
      now: clock.now,
    });
    expect(sup.check()).toBe('ok'); // first observation
    services.engine.tick();
    clock.advance(10_000);
    expect(sup.check()).toBe('ok'); // advanced
    // Now nothing ticks for 20 s.
    clock.advance(20_000);
    expect(sup.check()).toBe('stalled');
    expect(notified).toEqual(['Sabado: alarm engine stalled']);
    expect(
      services.repos.events
        .recent(5)
        .some((e) => e.type === 'engine-stalled' && e.severity === 'critical'),
    ).toBe(true);
    // engine.start() ticked once synchronously → recovery on the next check.
    clock.advance(1000);
    expect(sup.check()).toBe('recovered');
    expect(sup.restarts).toBe(1);
  });
});
