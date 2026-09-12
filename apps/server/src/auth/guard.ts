import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '../context.js';
import { safeEqual, sha256 } from './crypto.js';
import type { AuthService, Resolved } from './service.js';

/*
 * Route guards.
 *
 * `authenticate` runs on every request and attaches `req.actor` from either
 * a session cookie or a Bearer API token. `requireRole` is the per-route
 * check: role rank, CSRF for cookie-authenticated writes, and read-only
 * enforcement for tokens. `setupGate` refuses to serve anything but the
 * setup wizard until the first admin exists.
 */

export type Role = Actor['role'];

export const SESSION_COOKIE = 'rode_session';
export const CSRF_HEADER = 'x-csrf-token';

const RANK: Record<Role, number> = { token: 0, crew: 1, admin: 2 };

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved session, when authenticated with a cookie. */
    authSession?: Resolved;
  }
}

let service: AuthService | null = null;

/** Called once at mount; routes import `requireRole` without needing the service. */
export function configureGuard(auth: AuthService): void {
  service = auth;
}

export function hasRole(actor: Actor | undefined, needed: Role): boolean {
  if (!actor) return false;
  return RANK[actor.role] >= RANK[needed];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Paths reachable before setup and without a session. */
const PUBLIC_API = new Set([
  '/api/setup/status',
  '/api/setup',
  '/api/auth/login',
  '/api/auth/password-strength',
  '/api/auth/me',
]);

export function clientIp(req: FastifyRequest): string | null {
  return req.ip || null;
}

/** onRequest hook: resolve the actor from cookie or bearer token. */
export function authenticate(req: FastifyRequest, _reply: FastifyReply, done: () => void): void {
  if (!service) {
    done();
    return;
  }
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const t = service.resolveToken(header.slice(7).trim());
    if (t) req.actor = { id: t.id, name: `token:${t.name}`, role: 'token' };
    done();
    return;
  }
  const cookie = req.cookies[SESSION_COOKIE];
  const resolved = service.resolveSession(cookie, clientIp(req));
  if (resolved) {
    req.authSession = resolved;
    req.actor = { id: resolved.user.id, name: resolved.user.username, role: resolved.user.role };
  }
  done();
}

/** onRequest hook: 503 for everything but the wizard until the first admin exists. */
export function setupGate(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (!service?.needsSetup()) {
    done();
    return;
  }
  const path = req.url.split('?')[0] ?? '';
  const isApi = path.startsWith('/api') || path.startsWith('/ws');
  if (isApi && !PUBLIC_API.has(path)) {
    void reply
      .code(503)
      .send({ error: 'setup-required', message: 'Create the first admin account to continue.' });
    return;
  }
  done();
}

/**
 * Per-route guard. Cookie-authenticated state-changing requests must carry
 * the session's CSRF token in a header; API tokens are read-only.
 */
export function requireRole(needed: Role) {
  return (req: FastifyRequest, reply: FastifyReply, done: () => void): void => {
    const actor = req.actor;
    if (!actor) {
      void reply.code(401).send({ error: 'unauthenticated', message: 'Sign in to continue.' });
      return;
    }
    if (actor.role === 'token') {
      // Tokens read what crew can read, and nothing else.
      if (!SAFE_METHODS.has(req.method)) {
        void reply
          .code(403)
          .send({ error: 'read-only-token', message: 'API tokens are read-only.' });
        return;
      }
      if (needed === 'admin') {
        void reply.code(403).send({ error: 'forbidden', message: 'This needs the admin role.' });
        return;
      }
      done();
      return;
    }
    if (!hasRole(actor, needed)) {
      void reply.code(403).send({ error: 'forbidden', message: `This needs the ${needed} role.` });
      return;
    }
    if (req.authSession && !SAFE_METHODS.has(req.method)) {
      const header = req.headers[CSRF_HEADER];
      const token = Array.isArray(header) ? header[0] : header;
      if (!token || !safeEqual(token, req.authSession.session.csrf_token)) {
        void reply
          .code(403)
          .send({ error: 'csrf', message: 'Missing or invalid CSRF token. Reload the page.' });
        return;
      }
    }
    done();
  };
}

/** The current session's id hash, for "this device" comparisons. */
export function currentSessionHash(req: FastifyRequest): string | null {
  const cookie = req.cookies[SESSION_COOKIE];
  return cookie ? sha256(cookie) : null;
}
