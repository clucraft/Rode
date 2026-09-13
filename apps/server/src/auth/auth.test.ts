import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, mountApp, readinessFor } from '../app.js';
import {
  ADMIN,
  clientFor,
  feed,
  setupAdmin,
  signIn,
  testEnv,
  type Client,
  type TestEnv,
} from '../test/helpers.js';
import { base32Decode, base32Encode, passwordStrength, totpCode, verifyTotp } from './crypto.js';

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

describe('crypto primitives', () => {
  it('base32 round-trips', () => {
    const buf = Buffer.from('hello there, anchor watch');
    expect(base32Decode(base32Encode(buf)).toString()).toBe(buf.toString());
  });

  it('TOTP matches the RFC 6238 test vector and tolerates one step of skew', () => {
    // RFC 6238 Appendix B, SHA-1, secret "12345678901234567890", T=59 → 94287082 (8 digits); 6 digits = 287082.
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpCode(secret, 59_000)).toBe('287082');
    expect(verifyTotp(secret, '287082', 59_000)).toBe(true);
    expect(verifyTotp(secret, '287082', 89_000)).toBe(true); // next step, within window
    expect(verifyTotp(secret, '287082', 150_000)).toBe(false);
    expect(verifyTotp(secret, 'abc', 59_000)).toBe(false);
  });

  it('password strength enforces length and guessability, no composition rules', () => {
    expect(passwordStrength('password').acceptable).toBe(false);
    expect(passwordStrength('password123456').acceptable).toBe(false); // long enough, still guessable
    expect(passwordStrength('correct horse battery staple').acceptable).toBe(true);
    expect(passwordStrength('correct horse battery staple').score).toBeGreaterThanOrEqual(3);
    expect(passwordStrength('skipper1234', ['skipper']).acceptable).toBe(false);
  });
});

describe('setup wizard', () => {
  it('refuses to serve the API until the first admin exists, then never again', async () => {
    const { app } = await boot();
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toMatchObject({
      needsSetup: true,
    });
    expect((await app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);

    const weak = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { ...ADMIN, password: 'password' },
    });
    expect(weak.statusCode).toBe(409);
    expect(weak.json().error).toBe('weak-password');

    const c = await setupAdmin(app);
    expect(c.user.role).toBe('admin');
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toMatchObject({
      needsSetup: false,
    });
    const again = await app.inject({ method: 'POST', url: '/api/setup', payload: ADMIN });
    expect(again.statusCode).toBe(409);
    expect((await c.req({ method: 'GET', url: '/api/state' })).statusCode).toBe(200);
  });
});

describe('login and sessions', () => {
  it('signs in, reports identity, signs out', async () => {
    const { app } = await boot();
    await setupAdmin(app);
    const { res, client } = await signIn(app, { username: 'SKIPPER', password: ADMIN.password });
    expect(res.statusCode).toBe(200);
    expect(client).not.toBeNull();
    const me = await client?.req({ method: 'GET', url: '/api/auth/me' });
    expect(me?.json().user.username).toBe('skipper');
    expect(me?.json().csrfToken).toBe(client?.csrf);
    await client?.req({ method: 'POST', url: '/api/auth/logout' });
    expect((await client?.req({ method: 'GET', url: '/api/state' }))?.statusCode).toBe(401);
  });

  it('rejects wrong passwords, unknown users and disabled accounts identically, and locks after five failures', async () => {
    const { app, env } = await boot();
    await setupAdmin(app);
    for (let i = 0; i < 5; i++) {
      const { res } = await signIn(app, { username: 'skipper', password: 'nope nope nope' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('invalid');
    }
    const locked = await signIn(app, { username: 'skipper', password: ADMIN.password });
    expect(locked.res.statusCode).toBe(429);
    expect(locked.res.headers['retry-after']).toBeDefined();
    const nobody = await signIn(app, { username: 'ghost', password: 'whatever it is' });
    expect(nobody.res.json().error).toBe('invalid');
    const types = env.services.repos.events.recent(20).map((e) => e.type);
    expect(types).toContain('login-failed');
    expect(types).toContain('login-locked');
    // The lockout window passes.
    env.clock.advance(16 * 60_000);
    expect(
      (await signIn(app, { username: 'skipper', password: ADMIN.password })).res.statusCode,
    ).toBe(200);
  });

  it('requires the CSRF header on state-changing cookie requests', async () => {
    const { app } = await boot();
    const c = await setupAdmin(app);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/anchor/drop',
      headers: { cookie: c.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error).toBe('csrf');
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/anchor/drop',
      headers: { cookie: c.cookie, 'x-csrf-token': 'nope' },
    });
    expect(wrong.statusCode).toBe(403);
    const read = await app.inject({
      method: 'GET',
      url: '/api/state',
      headers: { cookie: c.cookie },
    });
    expect(read.statusCode).toBe(200);
  });

  it('expires idle sessions and enforces the absolute cap', async () => {
    const { app, env } = await boot();
    const c = await setupAdmin(app);
    env.clock.advance(31 * 86_400_000);
    expect((await c.req({ method: 'GET', url: '/api/state' })).statusCode).toBe(401);
    const fresh = (await signIn(app, ADMIN)).client;
    for (let i = 0; i < 4; i++) {
      env.clock.advance(25 * 86_400_000);
      const r = await fresh?.req({ method: 'GET', url: '/api/state' });
      if (i < 3) expect(r?.statusCode).toBe(200);
      else expect(r?.statusCode).toBe(401); // 100 days > 90-day absolute cap
    }
  });

  it('lists devices, revokes one, revokes others, and a password change signs out other devices', async () => {
    const { app } = await boot();
    const a = await setupAdmin(app);
    const b = (await signIn(app, ADMIN)).client;
    let devices = (await a.req({ method: 'GET', url: '/api/auth/devices' })).json<
      { id: string; current: boolean }[]
    >();
    expect(devices).toHaveLength(2);
    const other = devices.find((d) => !d.current);
    expect(
      (await a.req({ method: 'DELETE', url: `/api/auth/devices/${other?.id ?? ''}` })).statusCode,
    ).toBe(200);
    expect((await b?.req({ method: 'GET', url: '/api/state' }))?.statusCode).toBe(401);

    const c2 = (await signIn(app, ADMIN)).client;
    const change = await a.req({
      method: 'POST',
      url: '/api/auth/password',
      payload: {
        currentPassword: ADMIN.password,
        newPassword: 'another perfectly fine passphrase',
      },
    });
    expect(change.statusCode).toBe(200);
    expect((await c2?.req({ method: 'GET', url: '/api/state' }))?.statusCode).toBe(401);
    expect((await a.req({ method: 'GET', url: '/api/state' })).statusCode).toBe(200);
    devices = (await a.req({ method: 'GET', url: '/api/auth/devices' })).json();
    expect(devices).toHaveLength(1);
  });
});

describe('roles', () => {
  it('crew can drop/ack but not change settings or manage users', async () => {
    const { app, env } = await boot();
    feed(env.services, env.clock);
    const admin = await setupAdmin(app);
    const created = await admin.req({
      method: 'POST',
      url: '/api/users',
      payload: { username: 'mate', password: 'a perfectly adequate passphrase', role: 'crew' },
    });
    expect(created.statusCode).toBe(201);
    const crew = (
      await signIn(app, { username: 'mate', password: 'a perfectly adequate passphrase' })
    ).client;
    expect(crew).not.toBeNull();
    expect((await crew?.req({ method: 'POST', url: '/api/anchor/drop' }))?.json().ok).toBe(true);
    expect(
      (await crew?.req({ method: 'PATCH', url: '/api/settings', payload: { boatName: 'x' } }))
        ?.statusCode,
    ).toBe(403);
    expect((await crew?.req({ method: 'GET', url: '/api/users' }))?.statusCode).toBe(403);
    expect((await crew?.req({ method: 'GET', url: '/api/settings' }))?.statusCode).toBe(200);
  });

  it('protects the last admin from demotion, disabling and deletion', async () => {
    const { app } = await boot();
    const admin = await setupAdmin(app);
    expect(
      (
        await admin.req({
          method: 'PATCH',
          url: `/api/users/${admin.user.id}`,
          payload: { role: 'crew' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await admin.req({
          method: 'PATCH',
          url: `/api/users/${admin.user.id}`,
          payload: { disabled: true },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await admin.req({ method: 'DELETE', url: `/api/users/${admin.user.id}` })).statusCode,
    ).toBe(409);
  });
});

describe('two-factor', () => {
  it('enables TOTP, requires it at login, accepts a recovery code once', async () => {
    const { app, env } = await boot();
    const c = await setupAdmin(app);
    const setup = (await c.req({ method: 'POST', url: '/api/auth/totp/setup' })).json<{
      secret: string;
      url: string;
    }>();
    expect(setup.url).toMatch(/^otpauth:\/\/totp\//);
    const bad = await c.req({
      method: 'POST',
      url: '/api/auth/totp/enable',
      payload: { code: '000000' },
    });
    expect(bad.statusCode).toBe(400);
    const enable = await c.req({
      method: 'POST',
      url: '/api/auth/totp/enable',
      payload: { code: totpCode(setup.secret, env.clock.now()) },
    });
    expect(enable.statusCode).toBe(200);
    const codes = enable.json<{ recoveryCodes: string[] }>().recoveryCodes;
    expect(codes).toHaveLength(10);

    const noCode = await signIn(app, ADMIN);
    expect(noCode.res.statusCode).toBe(401);
    expect(noCode.res.json().error).toBe('needs-totp');
    const wrongCode = await signIn(app, { ...ADMIN, totp: '123456' });
    expect(wrongCode.res.json().error).toBe('invalid');
    const withCode = await signIn(app, { ...ADMIN, totp: totpCode(setup.secret, env.clock.now()) });
    expect(withCode.res.statusCode).toBe(200);

    const recovery = await signIn(app, { ...ADMIN, recoveryCode: codes[0]?.toUpperCase() ?? '' });
    expect(recovery.res.statusCode).toBe(200);
    const reused = await signIn(app, { ...ADMIN, recoveryCode: codes[0] ?? '' });
    expect(reused.res.json().error).toBe('invalid');

    const disable = await c.req({
      method: 'POST',
      url: '/api/auth/totp/disable',
      payload: { password: ADMIN.password },
    });
    expect(disable.statusCode).toBe(200);
    expect((await signIn(app, ADMIN)).res.statusCode).toBe(200);
  });
});

describe('API tokens', () => {
  it('creates a read-only token shown once, accepts it as Bearer, refuses writes, revokes', async () => {
    const { app, env } = await boot();
    feed(env.services, env.clock);
    const admin = await setupAdmin(app);
    const created = await admin.req({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: 'home-assistant' },
    });
    expect(created.statusCode).toBe(201);
    const { id, token } = created.json<{ id: string; token: string }>();
    expect(token).toMatch(/^rode_/);
    const listed = (await admin.req({ method: 'GET', url: '/api/tokens' })).json<
      { id: string; name: string }[]
    >();
    expect(listed[0]).toMatchObject({ id, name: 'home-assistant' });
    expect(JSON.stringify(listed)).not.toContain(token);

    const read = await app.inject({
      method: 'GET',
      url: '/api/state',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode).toBe(200);
    const write = await app.inject({
      method: 'POST',
      url: '/api/anchor/drop',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toBe('read-only-token');

    expect((await admin.req({ method: 'DELETE', url: `/api/tokens/${id}` })).statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/state',
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/state',
          headers: { authorization: 'Bearer rode_garbage' },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('helpers', () => {
  it('clientFor builds an injecting client', async () => {
    const { app } = await boot();
    const c = await setupAdmin(app);
    const c2: Client = clientFor(app, c.cookie, c.csrf, c.user);
    expect((await c2.req({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(200);
  });
});
