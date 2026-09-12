import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorName, parseBody, type AppContext } from '../context.js';
import { clientIp, currentSessionHash, requireRole, SESSION_COOKIE } from '../auth/guard.js';
import {
  AuthError,
  SESSION_ABSOLUTE_MS,
  type AuthService,
  type SessionHandle,
} from '../auth/service.js';
import { toPublic } from '../auth/repos.js';

const Credentials = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
});
const LoginRequest = Credentials.extend({
  totp: z.string().max(16).optional(),
  recoveryCode: z.string().max(32).optional(),
});
const SetupRequest = Credentials.extend({ displayName: z.string().max(60).default('') });
const StrengthRequest = z.object({
  password: z.string().max(1024),
  inputs: z.array(z.string().max(64)).max(5).default([]),
});
const ChangePassword = z.object({
  currentPassword: z.string().max(1024),
  newPassword: z.string().max(1024),
});
const TotpCode = z.object({ code: z.string().min(6).max(8) });
const PasswordOnly = z.object({ password: z.string().max(1024) });
const NewUser = z.object({
  username: z.string().min(2).max(32),
  password: z.string().max(1024),
  displayName: z.string().max(60).default(''),
  role: z.enum(['admin', 'crew']),
});
const UserPatch = z.object({
  displayName: z.string().max(60).optional(),
  role: z.enum(['admin', 'crew']).optional(),
  disabled: z.boolean().optional(),
});
const NewToken = z.object({ name: z.string().min(1).max(60) });

function setSessionCookie(reply: FastifyReply, ctx: AppContext, s: SessionHandle): void {
  void reply.setCookie(SESSION_COOKIE, s.cookie, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Secure only when TLS is actually terminated for us; otherwise the browser
    // drops the cookie on a plain-HTTP tailnet address and login silently fails.
    secure: ctx.config.RODE_TLS,
    maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000),
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

function authCtx(req: FastifyRequest) {
  return { ip: clientIp(req), userAgent: req.headers['user-agent'] ?? null };
}

function sendAuthError(reply: FastifyReply, err: unknown): void {
  if (err instanceof AuthError) {
    const status = err.code === 'invalid' ? 400 : err.code === 'not-found' ? 404 : 409;
    void reply.code(status).send({ error: err.code, message: err.message });
    return;
  }
  throw err;
}

export function authRoutes(app: FastifyInstance, ctx: AppContext, auth: AuthService): void {
  // ---------------------------------------------------------------- setup

  app.get('/api/setup/status', () => ({
    needsSetup: auth.needsSetup(),
    boatName: ctx.settings.view().boatName,
  }));

  app.post(
    '/api/setup',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parseBody(SetupRequest, req, reply);
      if (!body) return;
      try {
        const r = await auth.setup(body, authCtx(req));
        setSessionCookie(reply, ctx, r.session);
        return { user: r.user, csrfToken: r.session.csrfToken };
      } catch (err) {
        sendAuthError(reply, err);
        return;
      }
    },
  );

  app.post(
    '/api/auth/password-strength',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    (req, reply) => {
      const body = parseBody(StrengthRequest, req, reply);
      if (!body) return;
      return auth.strength(body.password, body.inputs);
    },
  );

  // ---------------------------------------------------------------- session

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parseBody(LoginRequest, req, reply);
      if (!body) return;
      const r = await auth.login(body, authCtx(req));
      if (r.ok) {
        setSessionCookie(reply, ctx, r.session);
        return { user: r.user, csrfToken: r.session.csrfToken };
      }
      if (r.reason === 'needs-totp')
        return reply
          .code(401)
          .send({ error: 'needs-totp', message: 'Enter your two-factor code.' });
      if (r.reason === 'locked') {
        void reply.header('Retry-After', String(r.retryAfterS ?? 900));
        return reply
          .code(429)
          .send({ error: 'locked', message: 'Too many failed attempts. Try again later.' });
      }
      return reply.code(401).send({ error: 'invalid', message: 'Wrong username or password.' });
    },
  );

  app.post('/api/auth/logout', { preHandler: requireRole('crew') }, (req, reply) => {
    auth.logout(req.cookies[SESSION_COOKIE]);
    clearSessionCookie(reply);
    return { ok: true };
  });

  /** Who am I. Public so the app can bootstrap; returns null when signed out. */
  app.get('/api/auth/me', (req) => {
    if (!req.authSession) return { user: null, csrfToken: null, needsSetup: auth.needsSetup() };
    return {
      user: toPublic(req.authSession.user),
      csrfToken: req.authSession.session.csrf_token,
      needsSetup: false,
    };
  });

  app.get('/api/auth/devices', { preHandler: requireRole('crew') }, (req, reply) => {
    if (!req.authSession) return reply.code(401).send({ error: 'unauthenticated' });
    return auth.devices(req.authSession.user.id, currentSessionHash(req) ?? '');
  });

  app.delete('/api/auth/devices/:id', { preHandler: requireRole('crew') }, (req, reply) => {
    if (!req.authSession) return reply.code(401).send({ error: 'unauthenticated' });
    const { id } = req.params as { id: string };
    return auth.revokeDevice(req.authSession.user.id, id)
      ? { ok: true }
      : reply.code(404).send({ error: 'not-found' });
  });

  app.post('/api/auth/devices/revoke-others', { preHandler: requireRole('crew') }, (req, reply) => {
    if (!req.authSession) return reply.code(401).send({ error: 'unauthenticated' });
    return {
      revoked: auth.revokeOtherDevices(req.authSession.user.id, currentSessionHash(req) ?? ''),
    };
  });

  app.post('/api/auth/password', { preHandler: requireRole('crew') }, async (req, reply) => {
    if (!req.authSession) return reply.code(401).send({ error: 'unauthenticated' });
    const body = parseBody(ChangePassword, req, reply);
    if (!body) return;
    try {
      await auth.changePassword(
        req.authSession.user,
        body.currentPassword,
        body.newPassword,
        currentSessionHash(req) ?? '',
      );
      return { ok: true };
    } catch (err) {
      sendAuthError(reply, err);
      return;
    }
  });

  // ---------------------------------------------------------------- TOTP

  app.post('/api/auth/totp/setup', { preHandler: requireRole('crew') }, (req, reply) => {
    if (!req.authSession) return reply.code(401).send({ error: 'unauthenticated' });
    return auth.totpSetup(req.authSession.user);
  });

  app.post('/api/auth/totp/enable', { preHandler: requireRole('crew') }, (req, reply) => {
    if (!req.authSession) return reply.code(401).send({ error: 'unauthenticated' });
    const body = parseBody(TotpCode, req, reply);
    if (!body) return;
    try {
      return { recoveryCodes: auth.totpEnable(req.authSession.user, body.code) };
    } catch (err) {
      sendAuthError(reply, err);
      return;
    }
  });

  app.post('/api/auth/totp/disable', { preHandler: requireRole('crew') }, async (req, reply) => {
    if (!req.authSession) return reply.code(401).send({ error: 'unauthenticated' });
    const body = parseBody(PasswordOnly, req, reply);
    if (!body) return;
    try {
      await auth.totpDisable(req.authSession.user, body.password);
      return { ok: true };
    } catch (err) {
      sendAuthError(reply, err);
      return;
    }
  });

  app.post('/api/auth/totp/recovery-codes', { preHandler: requireRole('crew') }, (req, reply) => {
    if (!req.authSession) return reply.code(401).send({ error: 'unauthenticated' });
    try {
      return { recoveryCodes: auth.regenerateRecoveryCodes(req.authSession.user) };
    } catch (err) {
      sendAuthError(reply, err);
      return;
    }
  });

  // ---------------------------------------------------------------- users (admin)

  app.get('/api/users', { preHandler: requireRole('admin') }, () => auth.listUsers());

  app.post('/api/users', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = parseBody(NewUser, req, reply);
    if (!body) return;
    try {
      const u = await auth.createUser(body, actorName(req));
      return await reply.code(201).send(toPublic(u));
    } catch (err) {
      sendAuthError(reply, err);
      return;
    }
  });

  app.patch('/api/users/:id', { preHandler: requireRole('admin') }, (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(UserPatch, req, reply);
    if (!body) return;
    try {
      return auth.updateUser(id, body, actorName(req));
    } catch (err) {
      sendAuthError(reply, err);
      return;
    }
  });

  app.post('/api/users/:id/password', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(PasswordOnly, req, reply);
    if (!body) return;
    const user = auth.userById(id);
    if (!user) return reply.code(404).send({ error: 'not-found' });
    try {
      await auth.setPassword(user, body.password, null, actorName(req));
      return { ok: true };
    } catch (err) {
      sendAuthError(reply, err);
      return;
    }
  });

  app.delete('/api/users/:id', { preHandler: requireRole('admin') }, (req, reply) => {
    const { id } = req.params as { id: string };
    if (req.authSession?.user.id === id)
      return reply
        .code(409)
        .send({ error: 'self', message: 'You cannot delete your own account.' });
    try {
      auth.deleteUser(id, actorName(req));
      return reply.code(204).send();
    } catch (err) {
      sendAuthError(reply, err);
      return;
    }
  });

  // ---------------------------------------------------------------- API tokens (admin)

  app.get('/api/tokens', { preHandler: requireRole('admin') }, () => auth.listTokens());

  app.post('/api/tokens', { preHandler: requireRole('admin') }, (req, reply) => {
    if (!req.authSession) return reply.code(401).send({ error: 'unauthenticated' });
    const body = parseBody(NewToken, req, reply);
    if (!body) return;
    const t = auth.createToken(req.authSession.user.id, body.name);
    // Shown once. It is not stored; only its hash is.
    return reply.code(201).send({ id: t.id, name: body.name, token: t.token });
  });

  app.delete('/api/tokens/:id', { preHandler: requireRole('admin') }, (req, reply) => {
    const { id } = req.params as { id: string };
    return auth.revokeToken(id, actorName(req))
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'not-found' });
  });
}
